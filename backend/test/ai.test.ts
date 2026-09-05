import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGeminiPayload, AI_CARD_SYSTEM } from "../src/ai/prompts.js";
import { geminiUrl } from "../src/ai/gemini.js";
import { RateFuse, minuteKey } from "../src/ai/rate.js";
import { trimDetail } from "../src/ai/routes.js";
import { loadConfig, DEFAULT_GEMINI_MODEL, MAX_AI_BODY_BYTES } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, login } from "./helpers.js";

/* ------------------------------------------------------------------ *
 * 순수 부분
 * ------------------------------------------------------------------ */

describe("Gemini 페이로드", () => {
  it("검색 기반이면 google_search 도구를 붙인다", () => {
    const payload = buildGeminiPayload({ prompt: "부산 날씨", grounding: true });
    expect(payload.tools).toEqual([{ google_search: {} }]);
    expect(payload.contents[0]!.parts[0]!.text).toBe("부산 날씨");
    expect(payload.systemInstruction.parts[0]!.text).toBe(AI_CARD_SYSTEM);
  });

  it("검색 기반이 아니면 도구가 없다 (스키마도 쓰지 않는다)", () => {
    const payload = buildGeminiPayload({ prompt: "질문", grounding: false });
    expect(payload.tools).toBeUndefined();
    expect(payload).not.toHaveProperty("generationConfig");
  });

  it("선택 텍스트는 라벨과 함께 사용자 메시지에 붙는다", () => {
    const payload = buildGeminiPayload({ prompt: "요약해 줘", context: "회의록 본문", grounding: false });
    const text = payload.contents[0]!.parts[0]!.text;
    expect(text.startsWith("요약해 줘")).toBe(true);
    expect(text).toContain("회의록 본문");
  });

  it("카드 규약이 지시문에 들어 있다", () => {
    expect(AI_CARD_SYSTEM).toContain("30자");
    expect(AI_CARD_SYSTEM).toContain("3~6개");
    expect(AI_CARD_SYSTEM).toContain("80자");
  });
});

describe("업스트림 주소", () => {
  it("모델과 키를 URL 에 넣는다", () => {
    expect(
      geminiUrl({ baseUrl: "https://example.test/", model: "gemini-2.5-flash", apiKey: "k e y" }),
    ).toBe("https://example.test/v1beta/models/gemini-2.5-flash:generateContent?key=k%20e%20y");
  });
});

describe("분당 퓨즈", () => {
  it("한도까지는 통과하고 그 뒤로 막는다", () => {
    const fuse = new RateFuse(3);
    const at = new Date("2026-09-05T03:04:05Z");
    expect([fuse.allow(at), fuse.allow(at), fuse.allow(at)]).toEqual([true, true, true]);
    expect(fuse.allow(at)).toBe(false);
    expect(fuse.countFor(at)).toBe(4);
  });

  it("분이 바뀌면 다시 0 부터 센다", () => {
    const fuse = new RateFuse(1);
    const first = new Date("2026-09-05T03:04:05Z");
    const next = new Date("2026-09-05T03:05:00Z");
    expect(fuse.allow(first)).toBe(true);
    expect(fuse.allow(first)).toBe(false);
    expect(fuse.allow(next)).toBe(true);
    expect(fuse.countFor(first)).toBe(0);
  });

  it("분 키는 UTC 분 단위다", () => {
    expect(minuteKey(new Date("2026-09-05T03:04:59.999Z"))).toBe("2026-09-05T03:04");
  });
});

describe("업스트림 오류 잘라내기", () => {
  it("공백을 접고 400자로 자른다", () => {
    expect(trimDetail("  a\n\n  b  ")).toBe("a b");
    expect(trimDetail("가".repeat(500))).toHaveLength(400);
  });
});

/* ------------------------------------------------------------------ *
 * 라우트
 * ------------------------------------------------------------------ */

/** 테스트용 Gemini 스텁. 다음 응답을 시험마다 갈아 끼운다. */
interface Upstream {
  server: Server;
  url: string;
  requests: Array<{ url: string; body: unknown }>;
  reply: { status: number; body: string };
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const state: Pick<Upstream, "requests" | "reply"> = {
    requests: [],
    reply: { status: 200, body: JSON.stringify({ candidates: [] }) },
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      state.requests.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      res.writeHead(state.reply.status, { "content-type": "application/json" });
      res.end(state.reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    get reply() {
      return state.reply;
    },
    set reply(value: { status: number; body: string }) {
      state.reply = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as Upstream;
}

interface Ctx {
  app: FastifyInstance;
  dataDir: string;
  adminSid: string;
  aliceSid: string;
  aliceId: string;
  pageId: string;
  otherPageId: string;
}

let upstream: Upstream;

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(async () => {
  await upstream.close();
});

async function createCtx(env: Record<string, string | undefined> = {}): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "ds118-ai-"));
  const base = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    COOKIE_SECURE: "false",
    GEMINI_BASE_URL: upstream.url,
    ...env,
  });
  const app = await buildServer({ config: { ...base, dataDir }, logger: false });
  await app.ready();
  app.db.prepare("UPDATE users SET must_change_password = 0 WHERE username = ?").run(ADMIN_USERNAME);
  const adminSid = await login(app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/users",
    headers: authHeaders(adminSid),
    payload: { username: "alice", password: "alicepass1234" },
  });
  const aliceId = created.json().user.id as string;
  app.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(aliceId);
  const aliceSid = await login(app, "alice", "alicepass1234");

  const mkPage = async (name: string, members: string[]): Promise<string> => {
    const session = await app.inject({
      method: "POST",
      url: "/api/admin/sessions",
      headers: authHeaders(adminSid),
      payload: { name },
    });
    const sessionId = session.json().session.id as string;
    for (const userId of members) {
      await app.inject({
        method: "PUT",
        url: `/api/admin/sessions/${sessionId}/members/${userId}`,
        headers: authHeaders(adminSid),
      });
    }
    const page = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pages`,
      headers: authHeaders(adminSid),
      payload: { name: "캔버스", type: "canvas" },
    });
    return page.json().page.id as string;
  };

  return {
    app,
    dataDir,
    adminSid,
    aliceSid,
    aliceId,
    pageId: await mkPage("AI 세션", [aliceId]),
    otherPageId: await mkPage("남의 세션", []),
  };
}

let ctx: Ctx;

const ask = (payload: Record<string, unknown>, sid: string = ctx.aliceSid) =>
  ctx.app.inject({ method: "POST", url: "/api/ai/ask", headers: authHeaders(sid), payload });

describe("AI 프록시 (키 있음)", () => {
  beforeEach(async () => {
    ctx = await createCtx({ GEMINI_API_KEY: "test-key", AI_RATE_LIMIT_PER_MIN: "3" });
    upstream.requests.length = 0;
    upstream.reply = { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "제목\n- 하나" }] } }] }) };
  });

  afterEach(async () => {
    await ctx.app.close();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  it("ping 은 로그인해야 하고, 키가 있으면 true 다", async () => {
    const anonymous = await ctx.app.inject({ method: "GET", url: "/api/ai/ping" });
    expect(anonymous.statusCode).toBe(401);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/ai/ping",
      headers: authHeaders(ctx.aliceSid),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ai: true });
  });

  it("ai_allowed=0 인 사용자는 ping false 이고 ask 는 403 이다", async () => {
    ctx.app.db.prepare("UPDATE users SET ai_allowed = 0 WHERE id = ?").run(ctx.aliceId);

    const ping = await ctx.app.inject({
      method: "GET",
      url: "/api/ai/ping",
      headers: authHeaders(ctx.aliceSid),
    });
    expect(ping.json()).toEqual({ ai: false });

    const res = await ask({ pageId: ctx.pageId, prompt: "질문", grounding: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ai_forbidden");
    expect(upstream.requests).toHaveLength(0);
  });

  it("업스트림 응답을 그대로 전달한다 (검색 기반이면 도구가 붙는다)", async () => {
    const body = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: "제목\n- 하나\n- 둘" }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: "https://a.test", title: "A" } }] },
        },
      ],
    });
    upstream.reply = { status: 200, body };

    const res = await ask({ pageId: ctx.pageId, prompt: "부산 여행", grounding: true, context: "메모" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(body);
    expect(res.headers["cache-control"]).toBe("no-store");

    expect(upstream.requests).toHaveLength(1);
    const sent = upstream.requests[0]!;
    expect(sent.url).toContain(`/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(sent.url).toContain("key=test-key");
    const payload = sent.body as { tools?: unknown; contents: Array<{ parts: Array<{ text: string }> }> };
    expect(payload.tools).toEqual([{ google_search: {} }]);
    expect(payload.contents[0]!.parts[0]!.text).toContain("부산 여행");
    expect(payload.contents[0]!.parts[0]!.text).toContain("메모");
  });

  it("grounding=false 면 도구 없이 부른다", async () => {
    await ask({ pageId: ctx.pageId, prompt: "질문", grounding: false });
    expect((upstream.requests[0]!.body as { tools?: unknown }).tools).toBeUndefined();
  });

  it("비멤버 페이지는 403, 없는 페이지는 404 다", async () => {
    const forbidden = await ask({ pageId: ctx.otherPageId, prompt: "질문" });
    expect(forbidden.statusCode).toBe(403);

    const missing = await ask({ pageId: "없는페이지", prompt: "질문" });
    expect(missing.statusCode).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it("비로그인은 401 이다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/ai/ask",
      payload: { pageId: ctx.pageId, prompt: "질문" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("질문 500자는 되고 501자는 400 이다", async () => {
    const ok = await ask({ pageId: ctx.pageId, prompt: "가".repeat(500) });
    expect(ok.statusCode).toBe(200);

    const tooLong = await ask({ pageId: ctx.pageId, prompt: "가".repeat(501) });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toContain("500자");
  });

  it("컨텍스트 2000자는 되고 2001자는 400 이다", async () => {
    const ok = await ask({ pageId: ctx.pageId, prompt: "질문", context: "가".repeat(2000) });
    expect(ok.statusCode).toBe(200);

    const tooLong = await ask({ pageId: ctx.pageId, prompt: "질문", context: "가".repeat(2001) });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toContain("2000자");
  });

  it("빈 질문은 400 이다", async () => {
    const res = await ask({ pageId: ctx.pageId, prompt: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("본문이 64KB 를 넘으면 413 이다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/ai/ask",
      headers: { ...authHeaders(ctx.aliceSid), "content-type": "application/json" },
      payload: JSON.stringify({ pageId: ctx.pageId, prompt: "질문", padding: "x".repeat(MAX_AI_BODY_BYTES) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("분당 퓨즈를 넘기면 429 이고 업스트림을 부르지 않는다", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await ask({ pageId: ctx.pageId, prompt: `질문 ${i}` })).statusCode).toBe(200);
    }
    const blocked = await ask({ pageId: ctx.pageId, prompt: "네 번째" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate");
    expect(upstream.requests).toHaveLength(3);
  });

  it("업스트림 5xx 는 502 server 로, 오류 본문은 잘라서 전달한다", async () => {
    upstream.reply = { status: 500, body: "x".repeat(1000) };
    const res = await ask({ pageId: ctx.pageId, prompt: "질문" });
    expect(res.statusCode).toBe(502);
    const error = res.json().error;
    expect(error.code).toBe("server");
    expect(error.detail).toContain("HTTP 500");
    expect(error.detail.length).toBeLessThanOrEqual(420);
  });

  it("업스트림 401/403 은 auth 로 구분한다", async () => {
    upstream.reply = { status: 403, body: JSON.stringify({ error: { message: "API key not valid" } }) };
    const res = await ask({ pageId: ctx.pageId, prompt: "질문" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("auth");
    expect(res.json().error.detail).toContain("API key not valid");
  });

  it("일별 호출 수를 세고 관리자 통계로 보여 준다 (질문 내용은 남기지 않는다)", async () => {
    await ask({ pageId: ctx.pageId, prompt: "질문 1" });
    await ask({ pageId: ctx.pageId, prompt: "질문 2" });

    const denied = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/ai/stats",
      headers: authHeaders(ctx.aliceSid),
    });
    expect(denied.statusCode).toBe(403);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/ai/stats",
      headers: authHeaders(ctx.adminSid),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.configured).toBe(true);
    expect(stats.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(stats.daily[0].count).toBe(2);

    const columns = ctx.app.db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('ai_calls_daily')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(["day", "count"]);
  });
});

describe("AI 프록시 (키 없음)", () => {
  beforeEach(async () => {
    ctx = await createCtx();
    upstream.requests.length = 0;
  });

  afterEach(async () => {
    await ctx.app.close();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  it("ping 은 200 이지만 ai:false 다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/ai/ping",
      headers: authHeaders(ctx.aliceSid),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ai: false });
  });

  it("ask 는 503 이고 업스트림을 부르지 않는다", async () => {
    const res = await ask({ pageId: ctx.pageId, prompt: "질문" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ai_disabled");
    expect(upstream.requests).toHaveLength(0);
  });

  it("관리자 통계는 configured:false 다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/ai/stats",
      headers: authHeaders(ctx.adminSid),
    });
    expect(res.json().configured).toBe(false);
  });
});

describe("업스트림에 닿지 못하는 경우", () => {
  beforeEach(async () => {
    // 아무도 듣지 않는 포트로 보낸다.
    ctx = await createCtx({ GEMINI_API_KEY: "test-key", GEMINI_BASE_URL: "http://127.0.0.1:1" });
  });

  afterEach(async () => {
    await ctx.app.close();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  it("502 server 로 떨어지고 서버는 살아 있다", async () => {
    const res = await ask({ pageId: ctx.pageId, prompt: "질문" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("server");
    expect(res.json().error.detail).toContain("연결 실패");

    const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });
});

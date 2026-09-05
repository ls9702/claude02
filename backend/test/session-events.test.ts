/**
 * 세션 실시간 이벤트 채널 (`GET /ws/session/:sessionId`) 회귀 테스트.
 *
 * 배경: 통합 디버깅 리포트 [높음] 1 — 관리자가 협업 중인 페이지·세션을 지워도
 * 접속자에게 알릴 길이 없어 화면이 방치됐다. 여기서는 (a) 핸드셰이크 권한,
 * (b) 라우트에서의 이벤트 발행, (c) 권한 회수 시 소켓 종료를 검증한다.
 */
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  authHeaders,
  createTestApp,
  login,
  type TestApp,
} from "./helpers.js";

let ctx: TestApp;
let adminSid: string;

interface Fixture {
  aliceId: string;
  bobId: string;
  carolId: string;
  sidA: string;
  sidB: string;
  sidC: string;
  sessionId: string;
  otherSessionId: string;
  canvasPageId: string;
  sheetPageId: string;
}

let fx: Fixture;

interface Subscription {
  socket: WebSocket;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function subscribe(sessionId: string, sid: string): Promise<Subscription> {
  const socket = await ctx.app.injectWS(`/ws/session/${sessionId}`, {
    headers: { cookie: `sid=${sid}` },
  } as never);
  const events: Subscription["events"] = [];
  socket.on("message", (data: unknown) => {
    events.push(JSON.parse(String(data)) as Subscription["events"][number]);
  });
  return {
    socket,
    events,
    async waitFor(type, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find((e) => e.type === type);
        if (hit) return hit.payload;
        if (Date.now() > deadline) {
          throw new Error(
            `이벤트 ${type} 를 받지 못했습니다. (받은 것: ${events.map((e) => e.type).join(",")})`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close() {
      socket.close();
    },
  };
}

beforeEach(async () => {
  ctx = await createTestApp();
  adminSid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const mkUser = async (username: string) => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(adminSid),
      payload: { username, password: "userpass1234" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().user.id as string;
  };
  const mkSession = async (name: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/admin/sessions",
        headers: authHeaders(adminSid),
        payload: { name },
      })
    ).json().session.id as string;
  const addMember = async (sessionId: string, userId: string) => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/admin/sessions/${sessionId}/members/${userId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);
  };
  const mkPage = async (sessionId: string, name: string, payload: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pages`,
      headers: authHeaders(adminSid),
      payload: { name, ...payload },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().page.id as string;
  };

  const aliceId = await mkUser("alice");
  const bobId = await mkUser("bob");
  const carolId = await mkUser("carol");
  const sessionId = await mkSession("협업 세션");
  const otherSessionId = await mkSession("남의 세션");
  await addMember(sessionId, aliceId);
  await addMember(sessionId, bobId);
  await addMember(otherSessionId, carolId);

  fx = {
    aliceId,
    bobId,
    carolId,
    sidA: await login(ctx.app, "alice", "userpass1234"),
    sidB: await login(ctx.app, "bob", "userpass1234"),
    sidC: await login(ctx.app, "carol", "userpass1234"),
    sessionId,
    otherSessionId,
    canvasPageId: await mkPage(sessionId, "캔버스", { type: "canvas" }),
    sheetPageId: await mkPage(sessionId, "장부", { type: "sheet", template: "ledger" }),
  };
});

afterEach(async () => {
  await ctx.close();
});

describe("/ws/session/:sessionId — 권한", () => {
  it("쿠키가 없으면 업그레이드가 401 로 거절된다", async () => {
    await expect(ctx.app.injectWS(`/ws/session/${fx.sessionId}`)).rejects.toThrow(/401/);
  });

  it("세션 멤버가 아니면 403 으로 거절된다", async () => {
    await expect(
      ctx.app.injectWS(`/ws/session/${fx.sessionId}`, {
        headers: { cookie: `sid=${fx.sidC}` },
      } as never),
    ).rejects.toThrow(/403/);
  });

  it("없는 세션은 404 로 거절된다", async () => {
    await expect(
      ctx.app.injectWS("/ws/session/없는-세션", {
        headers: { cookie: `sid=${fx.sidA}` },
      } as never),
    ).rejects.toThrow(/404/);
  });

  it("관리자는 멤버가 아니어도 붙을 수 있다", async () => {
    const sub = await subscribe(fx.otherSessionId, adminSid);
    expect(await sub.waitFor("ready")).toMatchObject({ sessionId: fx.otherSessionId });
    sub.close();
  });

  it("멤버는 붙자마자 ready 를 받는다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    expect(await sub.waitFor("ready")).toMatchObject({ sessionId: fx.sessionId });
    expect(ctx.app.sessionSockets.countForSession(fx.sessionId)).toBe(1);
    sub.close();
  });
});

describe("/ws/session/:sessionId — 페이지 이벤트", () => {
  it("다른 사람이 페이지를 만들면 page.created 가 온다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${fx.sessionId}/pages`,
      headers: authHeaders(fx.sidB),
      payload: { name: "밥의 새 페이지", type: "canvas" },
    });
    expect(res.statusCode).toBe(201);

    const payload = await sub.waitFor("page.created");
    expect(payload.sessionId).toBe(fx.sessionId);
    expect(payload.page).toMatchObject({ name: "밥의 새 페이지", type: "canvas" });
    sub.close();
  });

  it("이름을 바꾸면 page.updated 가 온다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");

    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/pages/${fx.canvasPageId}`,
      headers: authHeaders(fx.sidB),
      payload: { name: "이름 바뀐 캔버스" },
    });
    expect(res.statusCode).toBe(200);

    const payload = await sub.waitFor("page.updated");
    expect(payload.page).toMatchObject({ id: fx.canvasPageId, name: "이름 바뀐 캔버스" });
    sub.close();
  });

  it("페이지를 지우면 page.deleted 가 온다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/pages/${fx.canvasPageId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);

    expect(await sub.waitFor("page.deleted")).toMatchObject({
      sessionId: fx.sessionId,
      pageId: fx.canvasPageId,
    });
    sub.close();
  });

  it("순서를 바꾸면 pages.reordered 가 새 순서로 온다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");

    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/sessions/${fx.sessionId}/pages/order`,
      headers: authHeaders(fx.sidB),
      payload: { pageIds: [fx.sheetPageId, fx.canvasPageId] },
    });
    expect(res.statusCode, res.body).toBe(200);

    const payload = await sub.waitFor("pages.reordered");
    const pages = payload.pages as Array<{ id: string }>;
    expect(pages.map((p) => p.id)).toEqual([fx.sheetPageId, fx.canvasPageId]);
    sub.close();
  });

  it("다른 세션의 변경은 전달되지 않는다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");
    sub.events.length = 0;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${fx.otherSessionId}/pages`,
      headers: authHeaders(adminSid),
      payload: { name: "남의 페이지", type: "canvas" },
    });
    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(sub.events).toHaveLength(0);
    sub.close();
  });
});

describe("/ws/session/:sessionId — 세션 이벤트", () => {
  it("잠금·이름 변경은 session.updated 로 즉시 전달된다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");

    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/admin/sessions/${fx.sessionId}`,
          headers: authHeaders(adminSid),
          payload: { locked: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(await sub.waitFor("session.updated")).toMatchObject({
      session: { id: fx.sessionId, locked: true },
    });

    sub.events.length = 0;
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/admin/sessions/${fx.sessionId}`,
          headers: authHeaders(adminSid),
          payload: { locked: false, name: "이름 바뀐 세션" },
        })
      ).statusCode,
    ).toBe(200);
    expect(await sub.waitFor("session.updated")).toMatchObject({
      session: { locked: false, name: "이름 바뀐 세션" },
    });
    sub.close();
  });

  it("세션을 지우면 session.deleted 를 보낸 뒤 소켓을 끊는다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${fx.sessionId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);

    expect(await sub.waitFor("session.deleted")).toMatchObject({ sessionId: fx.sessionId });
    expect(ctx.app.sessionSockets.countForSession(fx.sessionId)).toBe(0);
  });

  it("멤버 해제는 member.removed 를 보낸 뒤 그 사용자의 소켓만 끊는다", async () => {
    const alice = await subscribe(fx.sessionId, fx.sidA);
    const bob = await subscribe(fx.sessionId, fx.sidB);
    await alice.waitFor("ready");
    await bob.waitFor("ready");

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${fx.sessionId}/members/${fx.bobId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);

    // 해제된 본인도 안내를 받는다 (끊기기 전에 프레임이 먼저 나간다).
    expect(await bob.waitFor("member.removed")).toMatchObject({ userId: fx.bobId });
    // 같은 세션의 다른 사람도 같은 이벤트를 본다 (본인 것이 아니면 무시한다).
    expect(await alice.waitFor("member.removed")).toMatchObject({ userId: fx.bobId });

    expect(ctx.app.sessionSockets.countForUser(fx.bobId)).toBe(0);
    expect(ctx.app.sessionSockets.countForUser(fx.aliceId)).toBe(1);
    alice.close();
  });

  it("로그아웃하면 그 사용자의 세션 소켓이 끊긴다", async () => {
    const sub = await subscribe(fx.sessionId, fx.sidA);
    await sub.waitFor("ready");
    const closed = new Promise<void>((resolve) => sub.socket.on("close", () => resolve()));

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: authHeaders(fx.sidA),
    });
    expect(res.statusCode).toBe(200);

    await closed;
    expect(ctx.app.sessionSockets.countForUser(fx.aliceId)).toBe(0);
  });

  it("실제 WebSocket 으로 붙었다가 끊으면 레지스트리에서 빠진다", async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const address = ctx.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/session/${fx.sessionId}`, {
      headers: { cookie: `sid=${fx.sidA}` },
    });
    const first = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => resolve(String(data)));
      client.on("error", reject);
    });
    expect(JSON.parse(first)).toEqual({ type: "ready", payload: { sessionId: fx.sessionId } });
    expect(ctx.app.sessionSockets.countForSession(fx.sessionId)).toBe(1);

    client.close();
    const deadline = Date.now() + 5000;
    while (ctx.app.sessionSockets.countForSession(fx.sessionId) > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(ctx.app.sessionSockets.countForSession(fx.sessionId)).toBe(0);
  });
});

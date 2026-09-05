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
import {
  buildSheetDoc,
  SHEET_ENGINE,
  SHEET_ENGINE_VERSION,
  type TemplateCellData,
} from "../src/sheets/templates.js";
import { MAX_SHEETS } from "../src/sheets/service.js";

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
  ledgerPageId: string;
  blankPageId: string;
  canvasPageId: string;
  otherPageId: string;
}

let fx: Fixture;

const doc = (sheets: unknown[] = [{ name: "시트1", id: "s1", order: 0, celldata: [] }]) => ({
  engine: SHEET_ENGINE,
  engineVersion: SHEET_ENGINE_VERSION,
  sheets,
});

async function getSheet(pageId: string, sid: string) {
  return ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/sheet`, headers: authHeaders(sid) });
}

async function putSheet(pageId: string, sid: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: "PUT",
    url: `/api/pages/${pageId}/sheet`,
    headers: authHeaders(sid),
    payload,
  });
}

interface Subscription {
  socket: WebSocket;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function subscribe(pageId: string, sid: string): Promise<Subscription> {
  const socket = await ctx.app.injectWS(`/ws/sheet/${pageId}`, {
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

async function lockSession(sessionId: string, locked: boolean): Promise<void> {
  const res = await ctx.app.inject({
    method: "PATCH",
    url: `/api/admin/sessions/${sessionId}`,
    headers: authHeaders(adminSid),
    payload: { locked },
  });
  expect(res.statusCode).toBe(200);
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
  const mkPage = async (
    sessionId: string,
    name: string,
    payload: Record<string, unknown> = { type: "sheet" },
  ) => {
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
  const sessionId = await mkSession("시트 세션");
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
    ledgerPageId: await mkPage(sessionId, "회비 장부", { type: "sheet", template: "ledger" }),
    blankPageId: await mkPage(sessionId, "빈 시트", { type: "sheet", template: "blank" }),
    canvasPageId: await mkPage(sessionId, "캔버스", { type: "canvas" }),
    otherPageId: await mkPage(otherSessionId, "남의 시트", { type: "sheet" }),
  };
});

afterEach(async () => {
  await ctx.close();
});

describe("템플릿", () => {
  it("회비 장부 템플릿은 합계·잔액·월별 요약 수식을 갖는다", () => {
    const built = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z"));
    expect(built.engine).toBe("fortune-sheet");
    expect(built.engineVersion).toBe("1.0.4");
    expect(built.sheets).toHaveLength(1);

    const sheet = built.sheets[0]!;
    expect(sheet.name).toBe("장부");
    const formulas = sheet.celldata.filter((c: TemplateCellData) => c.v.f).map((c) => c.v.f!);

    // 합계 3종
    expect(formulas).toContain('=SUMIF(B2:B201,"수입",D2:D201)');
    expect(formulas).toContain('=SUMIF(B2:B201,"지출",D2:D201)');
    expect(formulas).toContain("=D204-D205");
    // 월별 요약 (같은 시트 SUMIFS + 월 보조 열)
    expect(formulas).toContain(
      '=SUMIFS($D$2:$D$201,$B$2:$B$201,"수입",$G$2:$G$201,$I2)',
    );
    expect(formulas).toContain(
      '=SUMIFS($D$2:$D$201,$B$2:$B$201,"지출",$G$2:$G$201,$I13)',
    );
    // 월 보조 열 (TEXT() 대신 LEFT())
    expect(formulas).toContain('=IF(A2="","",LEFT(A2,7))');
    expect(formulas.some((f) => f.includes("TEXT("))).toBe(false);
    // 시트 간 참조는 쓰지 않는다 (한글 시트 이름은 이 엔진의 수식 파서가 못 읽는다).
    expect(formulas.some((f) => f.includes("장부!"))).toBe(false);
  });

  it("장부 템플릿에 드롭다운·머리글·샘플 3행이 들어 있다", () => {
    const sheet = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z")).sheets[0]!;
    const at = (r: number, c: number) => sheet.celldata.find((x) => x.r === r && x.c === c)?.v;

    expect(at(0, 0)?.v).toBe("날짜");
    expect(at(0, 3)?.v).toBe("금액");
    expect(at(0, 8)?.v).toBe("월");
    expect(at(1, 1)?.v).toBe("수입");
    expect(at(3, 1)?.v).toBe("지출");
    expect(at(1, 3)?.v).toBe(30000);
    expect(at(3, 3)?.v).toBe(45000);
    expect(at(1, 3)?.ct?.fa).toBe("#,##0");
    expect(at(1, 0)?.v).toBe("2026-01-05");
    // 구분 열 드롭다운
    expect(sheet.dataVerification?.["1_1"]).toMatchObject({ type: "dropdown", value1: "수입,지출" });
    expect(Object.keys(sheet.dataVerification ?? {})).toHaveLength(200);
  });

  it("빈 시트 템플릿은 시트 한 장만 만든다", () => {
    const built = buildSheetDoc("blank");
    expect(built.sheets).toHaveLength(1);
    expect(built.sheets[0]!.name).toBe("시트1");
    expect(built.sheets[0]!.celldata).toHaveLength(0);
  });
});

describe("GET /api/pages/:id/sheet", () => {
  it("장부 템플릿으로 만든 시트를 래퍼 스키마로 돌려준다", async () => {
    const res = await getSheet(fx.ledgerPageId, fx.sidA);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.version).toBe(0);
    expect(body.readOnly).toBe(false);
    expect(body.data.engine).toBe("fortune-sheet");
    expect(body.data.engineVersion).toBe("1.0.4");
    expect(body.data.sheets[0].name).toBe("장부");
  });

  it("템플릿을 지정하지 않으면 빈 시트가 된다", async () => {
    const body = (await getSheet(fx.otherPageId, fx.sidC)).json();
    expect(body.data.sheets[0].name).toBe("시트1");
  });

  it("캔버스 페이지에는 400", async () => {
    const res = await getSheet(fx.canvasPageId, fx.sidA);
    expect(res.statusCode).toBe(400);
  });

  it("세션 멤버가 아니면 403", async () => {
    const res = await getSheet(fx.ledgerPageId, fx.sidC);
    expect(res.statusCode).toBe(403);
  });

  it("비로그인은 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/pages/${fx.ledgerPageId}/sheet` });
    expect(res.statusCode).toBe(401);
  });

  it("M1 시절의 빈 `{}` 저장본도 빈 시트로 읽는다", async () => {
    ctx.app.db.prepare("UPDATE sheets SET data = '{}' WHERE page_id = ?").run(fx.blankPageId);
    const body = (await getSheet(fx.blankPageId, fx.sidA)).json();
    expect(body.data.sheets[0].name).toBe("시트1");
  });
});

describe("PUT /api/pages/:id/sheet", () => {
  it("저장하면 버전이 1씩 오르고 다시 읽힌다", async () => {
    const first = await putSheet(fx.blankPageId, fx.sidA, {
      data: doc([{ name: "시트1", id: "s1", order: 0, celldata: [{ r: 0, c: 0, v: { v: 1 } }] }]),
      baseVersion: 0,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().version).toBe(1);

    const second = await putSheet(fx.blankPageId, fx.sidB, { data: doc(), baseVersion: 1 });
    expect(second.json().version).toBe(2);

    const body = (await getSheet(fx.blankPageId, fx.sidA)).json();
    expect(body.version).toBe(2);
  });

  it("baseVersion 이 어긋나면 409 (version_conflict)", async () => {
    await putSheet(fx.blankPageId, fx.sidA, { data: doc(), baseVersion: 0 });
    const stale = await putSheet(fx.blankPageId, fx.sidB, { data: doc(), baseVersion: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_conflict");
  });

  it("baseVersion 을 생략하면 그대로 덮어쓴다", async () => {
    await putSheet(fx.blankPageId, fx.sidA, { data: doc(), baseVersion: 0 });
    const res = await putSheet(fx.blankPageId, fx.sidB, { data: doc() });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
  });

  it("엔진이 다르거나 형태가 깨진 데이터는 거부한다", async () => {
    const wrongEngine = await putSheet(fx.blankPageId, fx.sidA, {
      data: { engine: "univer", sheets: [{ name: "a" }] },
    });
    expect(wrongEngine.statusCode).toBe(400);
    expect(wrongEngine.json().error.code).toBe("unsupported_engine");

    const noSheets = await putSheet(fx.blankPageId, fx.sidA, { data: doc([]) });
    expect(noSheets.statusCode).toBe(400);

    const noName = await putSheet(fx.blankPageId, fx.sidA, { data: doc([{ id: "x" }]) });
    expect(noName.statusCode).toBe(400);

    const tooMany = await putSheet(fx.blankPageId, fx.sidA, {
      data: doc(Array.from({ length: MAX_SHEETS + 1 }, (_, i) => ({ name: `시트${i}` }))),
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("잠긴 세션은 관리자만 저장할 수 있다", async () => {
    await lockSession(fx.sessionId, true);
    const blocked = await putSheet(fx.blankPageId, fx.sidA, { data: doc() });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("session_locked");

    const admin = await putSheet(fx.blankPageId, adminSid, { data: doc() });
    expect(admin.statusCode).toBe(200);

    // 잠긴 세션의 일반 멤버는 읽기 전용으로 표시된다.
    const body = (await getSheet(fx.blankPageId, fx.sidA)).json();
    expect(body.readOnly).toBe(true);
  });

  it("멤버가 아니면 403, 캔버스 페이지면 400", async () => {
    expect((await putSheet(fx.ledgerPageId, fx.sidC, { data: doc() })).statusCode).toBe(403);
    expect((await putSheet(fx.canvasPageId, fx.sidA, { data: doc() })).statusCode).toBe(400);
  });
});

describe("/ws/sheet/:pageId", () => {
  it("접속하면 ready 와 접속자 목록을 준다", async () => {
    const sub = await subscribe(fx.ledgerPageId, fx.sidA);
    const ready = await sub.waitFor("ready");
    expect(ready.readOnly).toBe(false);
    expect(ready.version).toBe(0);
    expect(typeof ready.clientId).toBe("string");
    expect(ready.members).toEqual([{ userId: fx.aliceId, username: "alice" }]);
    sub.close();
  });

  it("op 는 같은 페이지의 다른 접속자에게만 중계된다 (에코 제외)", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    const b = await subscribe(fx.ledgerPageId, fx.sidB);
    const other = await subscribe(fx.blankPageId, fx.sidA);
    await a.waitFor("ready");
    await b.waitFor("ready");
    await other.waitFor("ready");

    const ops = [{ op: "replace", id: "ledger", path: ["celldata", 0, "v", "v"], value: 7 }];
    a.socket.send(JSON.stringify({ type: "op", ops }));

    const received = await b.waitFor("op");
    expect(received.ops).toEqual(ops);
    expect(received.seq).toBe(1);
    // 보낸 사람에게는 되돌아오지 않는다.
    expect(a.events.some((e) => e.type === "op")).toBe(false);
    // 다른 페이지에도 가지 않는다.
    expect(other.events.some((e) => e.type === "op")).toBe(false);

    a.close();
    b.close();
    other.close();
  });

  it("접속·이탈하면 presence 가 갱신된다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    await a.waitFor("ready");
    const b = await subscribe(fx.ledgerPageId, fx.sidB);
    await b.waitFor("ready");

    const presence = await a.waitFor("presence");
    const members = presence.members as Array<{ username: string }>;
    expect(members.map((m) => m.username).sort()).toEqual(["alice", "bob"]);
    expect(ctx.app.sheetSockets.countForPage(fx.ledgerPageId)).toBe(2);

    a.close();
    b.close();
  });

  it("잠긴 세션에서는 op 를 중계하지 않는다", async () => {
    await lockSession(fx.sessionId, true);
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    const b = await subscribe(fx.ledgerPageId, fx.sidB);
    const ready = await a.waitFor("ready");
    expect(ready.readOnly).toBe(true);
    await b.waitFor("ready");

    a.socket.send(
      JSON.stringify({ type: "op", ops: [{ op: "replace", path: ["celldata"], value: 1 }] }),
    );
    const err = await a.waitFor("error");
    expect(err.code).toBe("session_locked");
    expect(b.events.some((e) => e.type === "op")).toBe(false);

    a.close();
    b.close();
  });

  it("형태가 깨진 op 는 거부한다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    await a.waitFor("ready");
    a.socket.send(JSON.stringify({ type: "op", ops: [{ nope: true }] }));
    const err = await a.waitFor("error");
    expect(err.code).toBe("bad_op");
    a.close();
  });

  it("권한이 없거나 캔버스 페이지면 붙지 못한다", async () => {
    await expect(subscribe(fx.ledgerPageId, fx.sidC)).rejects.toThrow();
    await expect(subscribe(fx.canvasPageId, fx.sidA)).rejects.toThrow();
    await expect(subscribe(fx.ledgerPageId, "없는쿠키")).rejects.toThrow();
  });

  it("저장이 끝나면 다른 접속자에게 saved 를 알린다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    await a.waitFor("ready");
    const res = await putSheet(fx.ledgerPageId, fx.sidB, { data: doc(), baseVersion: 0 });
    expect(res.statusCode).toBe(200);
    const saved = await a.waitFor("saved");
    expect(saved.version).toBe(1);
    a.close();
  });

  it("권한이 회수되면 열린 시트 소켓이 끊긴다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    await a.waitFor("ready");
    expect(ctx.app.sheetSockets.countForUser(fx.aliceId)).toBe(1);

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${fx.sessionId}/members/${fx.aliceId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.app.sheetSockets.countForUser(fx.aliceId)).toBe(0);
  });
});

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
  AMOUNT_WARNING_TEXT,
  buildSheetDoc,
  SHEET_ENGINE,
  SHEET_ENGINE_VERSION,
  type TemplateCellData,
} from "../src/sheets/templates.js";
import { MAX_SHEETS } from "../src/sheets/service.js";
import { MAX_BAD_OPS_PER_WINDOW } from "../src/sheets/ws.js";

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

    // 합계 3종 — 금액 열(D)이 아니라 **숫자 보조 열(H)** 을 더한다.
    expect(formulas).toContain('=SUMIF(B2:B201,"수입",H2:H201)');
    expect(formulas).toContain('=SUMIF(B2:B201,"지출",H2:H201)');
    expect(formulas).toContain("=D204-D205");
    // 월별 요약 (같은 시트 SUMIFS + 월 보조 열 + 숫자 보조 열)
    expect(formulas).toContain(
      '=SUMIFS($H$2:$H$201,$B$2:$B$201,"수입",$G$2:$G$201,$I2)',
    );
    expect(formulas).toContain(
      '=SUMIFS($H$2:$H$201,$B$2:$B$201,"지출",$G$2:$G$201,$I13)',
    );
    // 월 보조 열 (TEXT() 대신 LEFT())
    expect(formulas).toContain('=IF(A2="","",LEFT(SUBSTITUTE(SUBSTITUTE(A2,"/","-"),".","-"),7))');
    expect(formulas.some((f) => f.includes("TEXT("))).toBe(false);
    // 시트 간 참조는 쓰지 않는다 (한글 시트 이름은 이 엔진의 수식 파서가 못 읽는다).
    expect(formulas.some((f) => f.includes("장부!"))).toBe(false);
  });

  /**
   * 회귀: 검증 리포트 Finding 1 (치명).
   * 금액 열(D)에 문자가 하나라도 섞이면 이 엔진의 SUMIF 는 조건을 무시하고 범위를
   * 문자열로 이어붙여 잔액이 **에러 표시 없이** 틀어졌다. 합계가 D 를 직접 더하지
   * 않는지(=숫자 보조 열 H 를 거치는지)를 못으로 박아 둔다.
   */
  it("합계·월별 요약은 금액 열을 직접 더하지 않는다 (문자 오염 방지)", () => {
    const sheet = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z")).sheets[0]!;
    const at = (r: number, c: number) => sheet.celldata.find((x) => x.r === r && x.c === c)?.v;

    // 숫자 보조 열 H: 문자는 0 으로 떨어뜨린다.
    expect(at(1, 7)?.f).toBe("=IF(ISNUMBER(D2),D2,0)");
    expect(at(200, 7)?.f).toBe("=IF(ISNUMBER(D201),D201,0)");
    expect(at(0, 7)?.v).toBe("금액(숫자)");

    // 합계·월별 요약 어디에도 D2:D201 을 더하는 수식이 없어야 한다.
    const aggregates = sheet.celldata
      .filter((c) => c.v.f && /SUMIFS?\(/.test(c.v.f))
      .map((c) => c.v.f!);
    expect(aggregates.length).toBe(2 + 24);
    for (const f of aggregates) {
      expect(f).not.toMatch(/D\$?2:\$?D?\$?201/);
      expect(f).toMatch(/H\$?2/);
    }
  });

  /** 회귀: 검증 리포트 Finding 1 — 3차 방어(경고 셀) */
  it("금액 열에 문자가 있으면 알리는 경고 셀이 합계 옆(E204)에 있다", () => {
    const sheet = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z")).sheets[0]!;
    const warning = sheet.celldata.find((x) => x.r === 203 && x.c === 4)?.v;
    expect(warning?.f).toBe(
      `=IF(COUNTA(D2:D201)-COUNT(D2:D201)>0,"${AMOUNT_WARNING_TEXT}","")`,
    );
    // 배열식(SUMPRODUCT)은 이 엔진에서 #VALUE! 라 쓰지 않는다.
    expect(warning?.f).not.toContain("SUMPRODUCT");
  });

  /**
   * 회귀: 검증 리포트 Finding 2 (중간).
   * `2026/03/10`·`2026.03.10` 을 그냥 LEFT 로 자르면 `2026/03` 이 되어
   * 월별 요약(SUMIFS)에서 조용히 빠졌다.
   */
  it("월 보조 열은 슬래시·점 날짜도 yyyy-MM 으로 바꾼다", () => {
    const sheet = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z")).sheets[0]!;
    const at = (r: number, c: number) => sheet.celldata.find((x) => x.r === r && x.c === c)?.v;
    expect(at(9, 6)?.f).toBe('=IF(A10="","",LEFT(SUBSTITUTE(SUBSTITUTE(A10,"/","-"),".","-"),7))');
    expect(at(0, 0)?.v).toBe("날짜(yyyy-MM-dd)");
  });

  it("장부 템플릿에 드롭다운·머리글·샘플 3행이 들어 있다", () => {
    const sheet = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z")).sheets[0]!;
    const at = (r: number, c: number) => sheet.celldata.find((x) => x.r === r && x.c === c)?.v;

    expect(at(0, 0)?.v).toBe("날짜(yyyy-MM-dd)");
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
  });

  /** 회귀: 검증 리포트 Finding 1·2 — 1차 방어(입력 유효성) */
  it("날짜 열은 날짜, 금액 열은 숫자 유효성을 200행 모두에 건다", () => {
    const sheet = buildSheetDoc("ledger", new Date("2026-03-02T00:00:00Z")).sheets[0]!;
    const dv = sheet.dataVerification ?? {};
    // 200행 × 3열(날짜·구분·금액)
    expect(Object.keys(dv)).toHaveLength(600);
    for (const r of [1, 100, 200]) {
      expect(dv[`${r}_0`]).toMatchObject({ type: "date", hintShow: true });
      expect(dv[`${r}_3`]).toMatchObject({ type: "number", hintShow: true });
      // 안내 문구는 한국어로 우리가 넣는다 (엔진 기본 문구는 영어라서).
      expect(String((dv[`${r}_0`] as { hintValue: string }).hintValue)).toContain("yyyy-MM-dd");
      expect(String((dv[`${r}_3`] as { hintValue: string }).hintValue)).toContain("숫자만");
    }
    // 되돌리는 일은 프런트(hooks.beforeUpdateCell)가 한다 — 엔진 안내창이 영어라서다.
    expect(dv["1_3"]).toMatchObject({ prohibitInput: false });
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

  /**
   * 회귀: 통합 디버깅 리포트 [높음] 2.
   * `readOnly` 를 핸드셰이크 시점에 클로저로 고정하면, 이미 붙어 있던 소켓은
   * 잠금 이후에도 계속 중계하고 잠금 해제 이후에도 계속 막힌다.
   */
  it("이미 붙어 있던 소켓도 잠금 변경을 곧바로 따른다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    const b = await subscribe(fx.ledgerPageId, fx.sidB);
    expect((await a.waitFor("ready")).readOnly).toBe(false);
    await b.waitFor("ready");

    // 잠그면: 서버가 새 readOnly 를 알리고(소켓은 유지) 릴레이도 막는다.
    await lockSession(fx.sessionId, true);
    expect(await a.waitFor("readonly")).toMatchObject({ readOnly: true });
    a.socket.send(
      JSON.stringify({ type: "op", ops: [{ op: "replace", path: ["celldata"], value: 1 }] }),
    );
    expect((await a.waitFor("error")).code).toBe("session_locked");
    expect(b.events.some((e) => e.type === "op")).toBe(false);

    // 풀면: 새로고침(재접속) 없이 편집이 돌아온다.
    a.events.length = 0;
    b.events.length = 0;
    await lockSession(fx.sessionId, false);
    expect(await a.waitFor("readonly")).toMatchObject({ readOnly: false });
    a.socket.send(
      JSON.stringify({ type: "op", ops: [{ op: "replace", path: ["celldata"], value: 2 }] }),
    );
    const relayed = await b.waitFor("op");
    expect(relayed.ops).toEqual([{ op: "replace", path: ["celldata"], value: 2 }]);
    expect(a.events.some((e) => e.type === "error")).toBe(false);

    a.close();
    b.close();
  });

  it("잠금 중에도 관리자에게는 readOnly:false 를 알린다", async () => {
    const admin = await subscribe(fx.ledgerPageId, adminSid);
    const alice = await subscribe(fx.ledgerPageId, fx.sidA);
    await admin.waitFor("ready");
    await alice.waitFor("ready");

    await lockSession(fx.sessionId, true);
    expect(await admin.waitFor("readonly")).toMatchObject({ readOnly: false });
    expect(await alice.waitFor("readonly")).toMatchObject({ readOnly: true });

    admin.close();
    alice.close();
  });

  it("형태가 깨진 op 는 거부한다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    await a.waitFor("ready");
    a.socket.send(JSON.stringify({ type: "op", ops: [{ nope: true }] }));
    const err = await a.waitFor("error");
    expect(err.code).toBe("bad_op");
    a.close();
  });

  /**
   * 회귀: 검증 리포트 WS 절 [Low] — bad_op 를 계속 쏟아부어도 서버가 에러만 돌려주며
   * 소켓을 살려 두면 같은 클라이언트가 무한히 재시도할 수 있다.
   */
  it("bad_op 를 분당 상한보다 많이 보내면 소켓을 끊는다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    const b = await subscribe(fx.ledgerPageId, fx.sidB);
    await a.waitFor("ready");
    await b.waitFor("ready");

    const closed = new Promise<number>((resolve) => a.socket.on("close", resolve));
    for (let i = 0; i < MAX_BAD_OPS_PER_WINDOW + 1; i += 1) {
      a.socket.send(JSON.stringify({ type: "op", ops: [{ nope: true }] }));
    }
    await a.waitFor("error");
    await closed;
    const codes = a.events.filter((e) => e.type === "error").map((e) => e.payload.code);
    expect(codes.filter((c) => c === "bad_op")).toHaveLength(MAX_BAD_OPS_PER_WINDOW);
    expect(codes.at(-1)).toBe("too_many_bad_ops");

    // 다른 접속자는 멀쩡하다 (끊긴 소켓은 정리되고 Bob 만 남는다).
    for (let i = 0; i < 100 && ctx.app.sheetSockets.countForPage(fx.ledgerPageId) > 1; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ctx.app.sheetSockets.countForPage(fx.ledgerPageId)).toBe(1);
    b.socket.send(
      JSON.stringify({ type: "op", ops: [{ op: "replace", path: ["celldata"], value: 1 }] }),
    );
    b.close();
  });

  it("상한 안쪽의 bad_op 는 끊지 않는다", async () => {
    const a = await subscribe(fx.ledgerPageId, fx.sidA);
    await a.waitFor("ready");
    for (let i = 0; i < MAX_BAD_OPS_PER_WINDOW; i += 1) {
      a.socket.send(JSON.stringify({ type: "op", ops: [{ nope: true }] }));
    }
    await a.waitFor("error");
    // 연결이 살아 있고 정상 op 는 계속 중계된다.
    await new Promise((r) => setTimeout(r, 50));
    expect(a.socket.readyState).toBe(1);
    expect(a.events.every((e) => e.payload?.code !== "too_many_bad_ops")).toBe(true);
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

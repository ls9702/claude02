import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, login, type TestApp } from "./helpers.js";

let ctx: TestApp;
let adminSid: string;

interface Fixture {
  userA: string;
  userB: string;
  sidA: string;
  sidB: string;
  s1: string;
  s2: string;
  pageS1: string;
  pageS2: string;
}

let fx: Fixture;

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
  const mkSession = async (name: string) => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/sessions",
      headers: authHeaders(adminSid),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().session.id as string;
  };
  const addMember = async (sessionId: string, userId: string) => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/admin/sessions/${sessionId}/members/${userId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);
  };
  const mkPage = async (sessionId: string, name: string) => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pages`,
      headers: authHeaders(adminSid),
      payload: { name, type: "canvas" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().page.id as string;
  };

  const userA = await mkUser("alice");
  const userB = await mkUser("bob");
  const s1 = await mkSession("S1");
  const s2 = await mkSession("S2");
  await addMember(s1, userA);
  await addMember(s2, userA);
  await addMember(s2, userB);

  fx = {
    userA,
    userB,
    sidA: await login(ctx.app, "alice", "userpass1234"),
    sidB: await login(ctx.app, "bob", "userpass1234"),
    s1,
    s2,
    pageS1: await mkPage(s1, "S1 페이지"),
    pageS2: await mkPage(s2, "S2 페이지"),
  };
});

afterEach(async () => {
  await ctx.close();
});

describe("관리자 전용 API", () => {
  it("일반 사용자는 403", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/admin/users", headers: authHeaders(fx.sidA) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("관리자만 사용할 수 있습니다.");
  });

  it("비로그인은 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/admin/users" });
    expect(res.statusCode).toBe(401);
  });

  it("마지막 관리자는 삭제할 수 없다", async () => {
    const users = (
      await ctx.app.inject({ method: "GET", url: "/api/admin/users", headers: authHeaders(adminSid) })
    ).json().users as Array<{ id: string; role: string }>;
    const admin = users.find((u) => u.role === "admin")!;
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${admin.id}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(400);
  });

  it("중복 아이디는 409", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(adminSid),
      payload: { username: "alice", password: "another1234" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("username_taken");
  });
});

describe("세션 접근 제어", () => {
  it("자신에게 할당된 세션만 목록에 보인다", async () => {
    const a = (await ctx.app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders(fx.sidA) })).json();
    expect(a.sessions.map((s: { id: string }) => s.id).sort()).toEqual([fx.s1, fx.s2].sort());

    const b = (await ctx.app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders(fx.sidB) })).json();
    expect(b.sessions.map((s: { id: string }) => s.id)).toEqual([fx.s2]);
  });

  it("목록에는 페이지와 미해결 댓글 배지 자리가 포함된다", async () => {
    const a = (await ctx.app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders(fx.sidA) })).json();
    const s1 = a.sessions.find((s: { id: string }) => s.id === fx.s1);
    expect(s1.pages).toHaveLength(1);
    expect(s1.unresolvedComments).toBe(0);
  });

  it("할당되지 않은 세션 직접 접근은 403", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/sessions/${fx.s1}`, headers: authHeaders(fx.sidB) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("이 세션에 접근할 권한이 없습니다.");
  });

  it("할당되지 않은 세션의 페이지 씬도 403", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageS1}/scene`,
      headers: authHeaders(fx.sidB),
    });
    expect(res.statusCode).toBe(403);
  });

  it("관리자는 모든 세션에 접근한다", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/sessions/${fx.s1}`, headers: authHeaders(adminSid) });
    expect(res.statusCode).toBe(200);
  });

  it("없는 세션은 404", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/sessions/nope", headers: authHeaders(adminSid) });
    expect(res.statusCode).toBe(404);
  });

  it("멤버 해제 후에는 접근할 수 없다", async () => {
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${fx.s2}/members/${fx.userB}`,
      headers: authHeaders(adminSid),
    });
    const res = await ctx.app.inject({ method: "GET", url: `/api/sessions/${fx.s2}`, headers: authHeaders(fx.sidB) });
    expect(res.statusCode).toBe(403);
  });
});

describe("페이지 CRUD / 순서", () => {
  it("페이지를 만들고 이름을 바꾸고 순서를 바꾼다", async () => {
    const create = async (name: string, type: "canvas" | "sheet") =>
      (
        await ctx.app.inject({
          method: "POST",
          url: `/api/sessions/${fx.s1}/pages`,
          headers: authHeaders(fx.sidA),
          payload: { name, type },
        })
      ).json().page as { id: string; position: number };

    const p2 = await create("두 번째", "canvas");
    const p3 = await create("장부", "sheet");
    expect(p2.position).toBe(1);
    expect(p3.position).toBe(2);

    const renamed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/pages/${p2.id}`,
      headers: authHeaders(fx.sidA),
      payload: { name: "이름 변경됨" },
    });
    expect(renamed.json().page.name).toBe("이름 변경됨");

    const order = await ctx.app.inject({
      method: "PUT",
      url: `/api/sessions/${fx.s1}/pages/order`,
      headers: authHeaders(fx.sidA),
      payload: { pageIds: [p3.id, fx.pageS1, p2.id] },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().pages.map((p: { id: string }) => p.id)).toEqual([p3.id, fx.pageS1, p2.id]);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/pages/${p2.id}`,
      headers: authHeaders(fx.sidA),
    });
    expect(del.statusCode).toBe(200);
  });

  it("잘못된 페이지 타입은 400", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${fx.s1}/pages`,
      headers: authHeaders(fx.sidA),
      payload: { name: "x", type: "video" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("순서 배열이 현재 페이지와 다르면 400", async () => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/sessions/${fx.s1}/pages/order`,
      headers: authHeaders(fx.sidA),
      payload: { pageIds: ["없는-id"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("중복된 id 로 다른 페이지를 빠뜨린 순서 요청은 400 (정확한 순열만 허용)", async () => {
    const p2 = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${fx.s1}/pages`,
        headers: authHeaders(fx.sidA),
        payload: { name: "두 번째", type: "canvas" },
      })
    ).json().page as { id: string };

    const before = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${fx.s1}`,
        headers: authHeaders(fx.sidA),
      })
    ).json().pages as Array<{ id: string; position: number }>;

    // 길이는 같지만 fx.pageS1 이 두 번, p2 는 빠졌다.
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/sessions/${fx.s1}/pages/order`,
      headers: authHeaders(fx.sidA),
      payload: { pageIds: [fx.pageS1, fx.pageS1] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("현재 세션과 일치하지 않습니다");

    // position 이 손상되지 않았는지 확인 (0..N-1 유일)
    const after = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${fx.s1}`,
        headers: authHeaders(fx.sidA),
      })
    ).json().pages as Array<{ id: string; position: number }>;
    expect(after.map((p) => p.position)).toEqual(before.map((p) => p.position));
    expect(new Set(after.map((p) => p.position)).size).toBe(after.length);
    expect(after.map((p) => p.id).sort()).toEqual([fx.pageS1, p2.id].sort());
  });

  it("세션에 없는 페이지 id 가 섞이면 400", async () => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/sessions/${fx.s1}/pages/order`,
      headers: authHeaders(fx.sidA),
      payload: { pageIds: [fx.pageS2] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("룸 정보는 멤버에게만 준다", async () => {
    const ok = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageS1}/room`,
      headers: authHeaders(fx.sidA),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.roomId).toMatch(/^[0-9a-f]{20}$/);
    expect(body.roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const denied = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageS1}/room`,
      headers: authHeaders(fx.sidB),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("잠긴 세션", () => {
  beforeEach(async () => {
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/sessions/${fx.s1}`,
      headers: authHeaders(adminSid),
      payload: { locked: true },
    });
    expect(res.statusCode).toBe(200);
  });

  it("일반 사용자는 읽을 수 있다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageS1}/scene`,
      headers: authHeaders(fx.sidA),
    });
    expect(res.statusCode).toBe(200);
  });

  it("일반 사용자의 씬 저장은 403", async () => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/pages/${fx.pageS1}/scene`,
      headers: authHeaders(fx.sidA),
      payload: { elements: [], appState: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("session_locked");
  });

  it("일반 사용자의 페이지 생성·삭제도 403", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${fx.s1}/pages`,
      headers: authHeaders(fx.sidA),
      payload: { name: "x", type: "canvas" },
    });
    expect(create.statusCode).toBe(403);

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/pages/${fx.pageS1}`,
      headers: authHeaders(fx.sidA),
    });
    expect(remove.statusCode).toBe(403);
  });

  it("관리자는 잠긴 세션에도 저장할 수 있다", async () => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/pages/${fx.pageS1}/scene`,
      headers: authHeaders(adminSid),
      payload: { elements: [], appState: {} },
    });
    expect(res.statusCode).toBe(200);
  });
});

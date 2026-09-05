import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, login, type TestApp } from "./helpers.js";

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
  pageId: string;
  page2Id: string;
  otherPageId: string;
}

let fx: Fixture;

/** WebSocket 으로 들어온 메시지를 모아 두는 헬퍼 (injectWS 로 붙는다). */
interface Subscription {
  socket: WebSocket;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  /** 조건에 맞는 이벤트가 올 때까지 기다린다. */
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function subscribe(pageId: string, sid: string): Promise<Subscription> {
  const socket = await ctx.app.injectWS(`/ws/comments/${pageId}`, {
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
          throw new Error(`이벤트 ${type} 를 받지 못했습니다. (받은 것: ${events.map((e) => e.type).join(",")})`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close() {
      socket.close();
    },
  };
}

/** 댓글을 하나 만들고 id 를 돌려준다. */
async function createComment(
  pageId: string,
  sid: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/api/pages/${pageId}/comments`,
    headers: authHeaders(sid),
    payload: { x: 10, y: 20, body: "첫 댓글", ...payload },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().comment.id as string;
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
  const mkPage = async (sessionId: string, name: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pages`,
        headers: authHeaders(adminSid),
        payload: { name, type: "canvas" },
      })
    ).json().page.id as string;

  const aliceId = await mkUser("alice");
  const bobId = await mkUser("bob");
  const carolId = await mkUser("carol");
  const sessionId = await mkSession("댓글 세션");
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
    pageId: await mkPage(sessionId, "캔버스"),
    page2Id: await mkPage(sessionId, "둘째"),
    otherPageId: await mkPage(otherSessionId, "남의 캔버스"),
  };
});

afterEach(async () => {
  await ctx.close();
});

describe("댓글 CRUD", () => {
  it("좌표 댓글을 만들고 목록에서 읽는다", async () => {
    const id = await createComment(fx.pageId, fx.sidA, { x: 12.5, y: -30, body: "여기 확인" });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidB),
    });
    expect(res.statusCode).toBe(200);
    const comments = res.json().comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id,
      elementId: null,
      x: 12.5,
      y: -30,
      body: "여기 확인",
      resolved: false,
      author: { id: fx.aliceId, username: "alice" },
      replies: [],
    });
    expect(typeof comments[0]!.createdAt).toBe("string");
  });

  it("요소 앵커 댓글은 elementId 를 그대로 돌려준다", async () => {
    await createComment(fx.pageId, fx.sidA, { elementId: "el-1", x: 100, y: 200 });
    const comments = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/pages/${fx.pageId}/comments`,
        headers: authHeaders(fx.sidA),
      })
    ).json().comments as Array<{ elementId: string | null }>;
    expect(comments[0]!.elementId).toBe("el-1");
  });

  it("해결한 댓글은 기본 목록에서 빠지고 includeResolved=1 이면 보인다", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const resolve = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidB),
      payload: { resolved: true },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().comment.resolved).toBe(true);

    const hidden = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/pages/${fx.pageId}/comments`,
        headers: authHeaders(fx.sidA),
      })
    ).json().comments as unknown[];
    expect(hidden).toHaveLength(0);

    const shown = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/pages/${fx.pageId}/comments?includeResolved=1`,
        headers: authHeaders(fx.sidA),
      })
    ).json().comments as unknown[];
    expect(shown).toHaveLength(1);
  });

  it("답글을 달고 지운다", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/comments/${id}/replies`,
      headers: authHeaders(fx.sidB),
      payload: { body: "확인했습니다" },
    });
    expect(created.statusCode).toBe(201);
    const replyId = created.json().reply.id as string;
    expect(created.json().reply.author.username).toBe("bob");

    const withReply = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/pages/${fx.pageId}/comments`,
        headers: authHeaders(fx.sidA),
      })
    ).json().comments as Array<{ replies: unknown[] }>;
    expect(withReply[0]!.replies).toHaveLength(1);

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/replies/${replyId}`,
      headers: authHeaders(fx.sidB),
    });
    expect(removed.statusCode).toBe(200);
  });

  it("댓글을 지우면 답글도 함께 사라진다", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    await ctx.app.inject({
      method: "POST",
      url: `/api/comments/${id}/replies`,
      headers: authHeaders(fx.sidB),
      payload: { body: "답글" },
    });
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidA),
    });
    expect(removed.statusCode).toBe(200);
    const replies = ctx.app.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM comment_replies")
      .get()!.c;
    expect(replies).toBe(0);
  });

  it("고아 전환 시 좌표를 갱신할 수 있다 (멤버 누구나)", async () => {
    const id = await createComment(fx.pageId, fx.sidA, { elementId: "el-1", x: 0, y: 0 });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidB),
      payload: { x: 300, y: 150 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().comment).toMatchObject({ x: 300, y: 150, elementId: "el-1" });
  });

  it("본문·좌표·해결 중 아무것도 없으면 400", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidA),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("x 만 보내면 400 (좌표는 쌍으로만 갱신한다)", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidA),
      payload: { x: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("본문이 비었거나 좌표가 숫자가 아니면 400", async () => {
    const empty = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidA),
      payload: { x: 0, y: 0, body: "   " },
    });
    expect(empty.statusCode).toBe(400);

    const nan = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidA),
      payload: { x: "10", y: 0, body: "내용" },
    });
    expect(nan.statusCode).toBe(400);
  });

  it("없는 댓글은 404", async () => {
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/comments/없는-id",
      headers: authHeaders(fx.sidA),
      payload: { resolved: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("댓글 권한", () => {
  it("비로그인은 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/pages/${fx.pageId}/comments` });
    expect(res.statusCode).toBe(401);
  });

  it("세션 멤버가 아니면 읽기도 작성도 403", async () => {
    const read = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidC),
    });
    expect(read.statusCode).toBe(403);

    const write = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidC),
      payload: { x: 0, y: 0, body: "몰래" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("남의 세션 댓글은 스레드 조작도 403", async () => {
    const id = await createComment(fx.otherPageId, fx.sidC);
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidA),
      payload: { resolved: true },
    });
    expect(patch.statusCode).toBe(403);

    const reply = await ctx.app.inject({
      method: "POST",
      url: `/api/comments/${id}/replies`,
      headers: authHeaders(fx.sidA),
      payload: { body: "끼어들기" },
    });
    expect(reply.statusCode).toBe(403);
  });

  it("타인의 댓글은 수정·삭제할 수 없다 (403)", async () => {
    const id = await createComment(fx.pageId, fx.sidA);

    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidB),
      payload: { body: "바꿔치기" },
    });
    expect(edit.statusCode).toBe(403);

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidB),
    });
    expect(remove.statusCode).toBe(403);
  });

  it("타인의 답글도 삭제할 수 없다 (403)", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const replyId = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/comments/${id}/replies`,
        headers: authHeaders(fx.sidA),
        payload: { body: "내 답글" },
      })
    ).json().reply.id as string;

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/replies/${replyId}`,
      headers: authHeaders(fx.sidB),
    });
    expect(res.statusCode).toBe(403);
  });

  it("관리자는 타인의 댓글도 수정·삭제할 수 있다", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(adminSid),
      payload: { body: "관리자 수정" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().comment.body).toBe("관리자 수정");

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/comments/${id}`,
      headers: authHeaders(adminSid),
    });
    expect(remove.statusCode).toBe(200);
  });

  it("멤버 누구나 해결·해결 취소를 할 수 있다", async () => {
    const id = await createComment(fx.pageId, fx.sidA);
    const on = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidB),
      payload: { resolved: true },
    });
    expect(on.statusCode).toBe(200);
    const off = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidB),
      payload: { resolved: false },
    });
    expect(off.json().comment.resolved).toBe(false);
  });
});

describe("잠긴 세션의 댓글", () => {
  let commentId: string;

  beforeEach(async () => {
    commentId = await createComment(fx.pageId, fx.sidA);
    await lockSession(fx.sessionId, true);
  });

  it("작성은 403 session_locked", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidA),
      payload: { x: 1, y: 1, body: "잠김" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("session_locked");
  });

  it("답글도 403 session_locked", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/comments/${commentId}/replies`,
      headers: authHeaders(fx.sidA),
      payload: { body: "잠김" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("session_locked");
  });

  it("읽기와 해결 처리는 허용된다", async () => {
    const read = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(fx.sidA),
    });
    expect(read.statusCode).toBe(200);

    const resolve = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${commentId}`,
      headers: authHeaders(fx.sidA),
      payload: { resolved: true },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().comment.resolved).toBe(true);
  });

  it("본문 수정·삭제·좌표 갱신은 403 (작성자여도)", async () => {
    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${commentId}`,
      headers: authHeaders(fx.sidA),
      payload: { body: "수정" },
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json().error.code).toBe("session_locked");

    const move = await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${commentId}`,
      headers: authHeaders(fx.sidA),
      payload: { x: 5, y: 5 },
    });
    expect(move.statusCode).toBe(403);

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/comments/${commentId}`,
      headers: authHeaders(fx.sidA),
    });
    expect(remove.statusCode).toBe(403);
  });

  it("관리자는 잠긴 세션에도 댓글을 남길 수 있다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${fx.pageId}/comments`,
      headers: authHeaders(adminSid),
      payload: { x: 1, y: 1, body: "관리자 메모" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("미해결 댓글 집계 (GET /api/sessions)", () => {
  const unresolvedOf = async (sid: string, sessionId: string): Promise<number> => {
    const sessions = (
      await ctx.app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders(sid) })
    ).json().sessions as Array<{ id: string; unresolvedComments: number }>;
    return sessions.find((s) => s.id === sessionId)!.unresolvedComments;
  };

  it("세션의 모든 페이지 미해결 댓글을 합산한다", async () => {
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(0);

    await createComment(fx.pageId, fx.sidA);
    const second = await createComment(fx.pageId, fx.sidB);
    await createComment(fx.page2Id, fx.sidA);
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(3);

    // 해결하면 줄어든다.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${second}`,
      headers: authHeaders(fx.sidB),
      payload: { resolved: true },
    });
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(2);

    // 삭제해도 줄어든다.
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/comments/${second}`,
      headers: authHeaders(fx.sidB),
    });
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(2);
  });

  it("다른 세션의 댓글은 섞이지 않는다", async () => {
    await createComment(fx.otherPageId, fx.sidC);
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(0);
    expect(await unresolvedOf(fx.sidC, fx.otherSessionId)).toBe(1);
  });

  it("페이지를 지우면 그 페이지의 댓글도 집계에서 빠진다", async () => {
    await createComment(fx.page2Id, fx.sidA);
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(1);
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/pages/${fx.page2Id}`,
      headers: authHeaders(fx.sidA),
    });
    expect(removed.statusCode).toBe(200);
    expect(await unresolvedOf(fx.sidA, fx.sessionId)).toBe(0);
  });
});

describe("/ws/comments/:pageId", () => {
  it("쿠키가 없으면 업그레이드가 401 로 거절된다", async () => {
    await expect(ctx.app.injectWS(`/ws/comments/${fx.pageId}`)).rejects.toThrow(/401/);
  });

  it("세션 멤버가 아니면 403 으로 거절된다", async () => {
    await expect(
      ctx.app.injectWS(`/ws/comments/${fx.pageId}`, {
        headers: { cookie: `sid=${fx.sidC}` },
      } as never),
    ).rejects.toThrow(/403/);
  });

  it("없는 페이지는 404 로 거절된다", async () => {
    await expect(
      ctx.app.injectWS("/ws/comments/없는-페이지", {
        headers: { cookie: `sid=${fx.sidA}` },
      } as never),
    ).rejects.toThrow(/404/);
  });

  it("같은 페이지 구독자에게 생성·답글·해결·삭제가 브로드캐스트된다", async () => {
    const sub = await subscribe(fx.pageId, fx.sidB);
    expect(ctx.app.commentSockets.countForPage(fx.pageId)).toBe(1);

    const id = await createComment(fx.pageId, fx.sidA, { body: "실시간" });
    const created = await sub.waitFor("comment.created");
    expect(created).toMatchObject({ id, body: "실시간", pageId: fx.pageId });

    await ctx.app.inject({
      method: "POST",
      url: `/api/comments/${id}/replies`,
      headers: authHeaders(fx.sidA),
      payload: { body: "답글" },
    });
    expect(await sub.waitFor("reply.created")).toMatchObject({ commentId: id, body: "답글" });

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidA),
      payload: { resolved: true },
    });
    expect(await sub.waitFor("comment.updated")).toMatchObject({ id, resolved: true });

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/comments/${id}`,
      headers: authHeaders(fx.sidA),
    });
    expect(await sub.waitFor("comment.deleted")).toMatchObject({ id });

    sub.close();
  });

  it("다른 페이지의 변경은 전달되지 않는다", async () => {
    const sub = await subscribe(fx.pageId, fx.sidA);
    await createComment(fx.page2Id, fx.sidA);
    await new Promise((r) => setTimeout(r, 200));
    expect(sub.events).toHaveLength(0);
    sub.close();
  });

  /**
   * 실제 업그레이드 경로 검증.
   * `injectWS` 는 스트림 쌍을 흉내 내는 것이라 클라이언트 close 가 서버 close 로
   * 이어지지 않는다. 정리(cleanup)는 진짜로 리슨한 서버에 붙어서 확인한다.
   * (같은 서버에 `/socket.io` 프록시의 upgrade 리스너가 함께 있다는 점도 여기서 같이 검증된다.)
   */
  it("실제 WebSocket 으로 붙었다가 끊으면 레지스트리에서 빠진다", async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const address = ctx.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/comments/${fx.pageId}`, {
      headers: { cookie: `sid=${fx.sidA}` },
    });
    const first = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => resolve(String(data)));
      client.on("error", reject);
    });
    expect(JSON.parse(first)).toEqual({ type: "ready", payload: { pageId: fx.pageId } });
    expect(ctx.app.commentSockets.countForPage(fx.pageId)).toBe(1);

    client.close();
    const deadline = Date.now() + 5000;
    while (ctx.app.commentSockets.countForPage(fx.pageId) > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(ctx.app.commentSockets.countForPage(fx.pageId)).toBe(0);
  });

  it("멤버에서 빠지면 열려 있던 댓글 소켓이 끊긴다", async () => {
    const sub = await subscribe(fx.pageId, fx.sidB);
    const closed = new Promise<void>((resolve) => sub.socket.on("close", () => resolve()));

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${fx.sessionId}/members/${fx.bobId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);

    await closed;
    expect(ctx.app.commentSockets.countForUser(fx.bobId)).toBe(0);
  });

  it("로그아웃하면 그 사용자의 댓글 소켓이 끊긴다", async () => {
    const sub = await subscribe(fx.pageId, fx.sidB);
    const closed = new Promise<void>((resolve) => sub.socket.on("close", () => resolve()));

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: authHeaders(fx.sidB),
    });
    expect(res.statusCode).toBe(200);

    await closed;
    expect(ctx.app.commentSockets.countForUser(fx.bobId)).toBe(0);
  });
});

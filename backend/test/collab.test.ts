import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, login, type TestApp } from "./helpers.js";

let ctx: TestApp;
let adminSid: string;
let memberSid: string;
let outsiderSid: string;
let memberId: string;
let sessionId: string;
let pageId: string;
let otherPageId: string;

/** 레지스트리에 넣을 가짜 소켓 (`net.Socket` 의 최소 형태) */
function fakeSocket(): { destroyed: boolean; destroy(): void; once(event: "close", cb: () => void): void } {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    once() {
      // 테스트에서는 close 이벤트를 발생시키지 않는다.
    },
  };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const BOUNDARY = "----ds118collabboundary";

function multipart(fields: Record<string, string>, file: { mime: string; data: Buffer }): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="img.png"\r\n` +
        `Content-Type: ${file.mime}\r\n\r\n`,
    ),
    file.data,
    Buffer.from("\r\n"),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  );
  return Buffer.concat(parts);
}

beforeEach(async () => {
  ctx = await createTestApp();
  adminSid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const mkUser = async (username: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: authHeaders(adminSid),
        payload: { username, password: "userpass1234" },
      })
    ).json().user.id as string;

  memberId = await mkUser("dave");
  await mkUser("erin");
  memberSid = await login(ctx.app, "dave", "userpass1234");
  outsiderSid = await login(ctx.app, "erin", "userpass1234");

  const mkSession = async (name: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/admin/sessions",
        headers: authHeaders(adminSid),
        payload: { name },
      })
    ).json().session.id as string;

  sessionId = await mkSession("협업 세션");
  const otherSessionId = await mkSession("남의 세션");
  await ctx.app.inject({
    method: "PUT",
    url: `/api/admin/sessions/${sessionId}/members/${memberId}`,
    headers: authHeaders(adminSid),
  });

  const mkPage = async (sid: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${sid}/pages`,
        headers: authHeaders(adminSid),
        payload: { name: "캔버스", type: "canvas" },
      })
    ).json().page.id as string;

  pageId = await mkPage(sessionId);
  otherPageId = await mkPage(otherSessionId);
});

afterEach(async () => {
  await ctx.close();
});

async function lockSession(locked: boolean): Promise<void> {
  const res = await ctx.app.inject({
    method: "PATCH",
    url: `/api/admin/sessions/${sessionId}`,
    headers: authHeaders(adminSid),
    payload: { locked },
  });
  expect(res.statusCode).toBe(200);
}

describe("/socket.io 프록시 인증", () => {
  it("쿠키 없이 폴링하면 401 이다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/socket.io/?EIO=4&transport=polling",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("잘못된 세션 쿠키도 401 이다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/socket.io/?EIO=4&transport=polling",
      headers: authHeaders("존재하지-않는-세션"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("쿠키 없이 업그레이드를 시도해도 401 이다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/socket.io/?EIO=4&transport=websocket",
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST 폴링도 인증을 요구한다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/socket.io/?EIO=4&transport=polling&sid=abc",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: "40",
    });
    expect(res.statusCode).toBe(401);
  });

  it("실제 WebSocket 업그레이드도 쿠키 없이는 401 로 끊긴다", async () => {
    // inject 는 진짜 업그레이드를 하지 않으므로, 실제로 리슨한 뒤 raw 소켓으로 확인한다.
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const address = ctx.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let buffer = "";
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("업그레이드 응답이 없습니다."));
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(buffer));
      socket.on("error", reject);
    });

    expect(response).toContain("401");
    expect(response).not.toContain("101 Switching Protocols");
  });

  it("로그인한 사용자는 인증을 통과한다 (room 이 없으면 502)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/socket.io/?EIO=4&transport=polling",
      headers: authHeaders(memberSid),
    });
    // room 릴레이가 떠 있지 않으므로 프록시가 실패하지만, 401 은 아니어야 한다.
    // 우리 서버의 오류가 아니라 업스트림 장애이므로 502 로 내려간다.
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("room_unavailable");
  });

  it("모든 응답에 X-Frame-Options 가 붙는다 (클릭재킹 방지)", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("POST /api/pages/:id/files/exists", () => {
  it("서버에 있는 파일 id 만 돌려준다", async () => {
    const uploaded = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files`,
      headers: { ...authHeaders(memberSid), "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ fileId: "collabfile1", mime: "image/png" }, { mime: "image/png", data: PNG }),
    });
    expect(uploaded.statusCode).toBe(201);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      headers: authHeaders(memberSid),
      payload: { ids: ["collabfile1", "collabfile2"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().existing).toEqual(["collabfile1"]);
  });

  it("빈 목록이면 빈 배열을 돌려준다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      headers: authHeaders(memberSid),
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().existing).toEqual([]);
  });

  it("형식이 잘못된 id 는 무시한다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      headers: authHeaders(memberSid),
      payload: { ids: ["../../etc/passwd", 42, null] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().existing).toEqual([]);
  });

  it("다른 세션에만 링크된 파일은 존재로 응답하지 않는다 (교차 세션 존재-오라클 차단)", async () => {
    // 관리자는 두 세션 모두 접근할 수 있다 — 그래도 이 페이지에 링크되지 않은 파일은 숨긴다.
    const uploaded = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files`,
      headers: { ...authHeaders(adminSid), "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ fileId: "crosssessionfile", mime: "image/png" }, { mime: "image/png", data: PNG }),
    });
    expect(uploaded.statusCode).toBe(201);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${otherPageId}/files/exists`,
      headers: authHeaders(adminSid),
      payload: { ids: ["crosssessionfile"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().existing).toEqual([]);

    // 원래 페이지에서는 그대로 존재로 응답한다.
    const own = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      headers: authHeaders(adminSid),
      payload: { ids: ["crosssessionfile"] },
    });
    expect(own.json().existing).toEqual(["crosssessionfile"]);
  });

  it("ids 가 500개를 넘으면 400 이다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      headers: authHeaders(memberSid),
      payload: { ids: Array.from({ length: 501 }, (_, i) => `file${i}`) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ids 가 배열이 아니면 400 이다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      headers: authHeaders(memberSid),
      payload: { ids: "collabfile1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("로그인하지 않으면 401 이다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/files/exists`,
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("세션 멤버가 아니면 403 이다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${otherPageId}/files/exists`,
      headers: authHeaders(outsiderSid),
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/pages/:id/room", () => {
  it("멤버에게 roomId·roomKey 를 준다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/room`,
      headers: authHeaders(memberSid),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // roomKey 는 AES-GCM 128bit 키의 base64url (22자) 이어야 한다.
    expect(body.roomId).toMatch(/^[0-9a-f]{20}$/);
    expect(body.roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("멤버가 아니면 403 이다", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${otherPageId}/room`,
      headers: authHeaders(outsiderSid),
    });
    expect(res.statusCode).toBe(403);
  });

  it("잠긴 세션이면 멤버에게 룸 키를 주지 않는다", async () => {
    await lockSession(true);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/room`,
      headers: authHeaders(memberSid),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locked: true });
  });

  it("잠긴 세션이면 관리자에게도 룸 키를 주지 않는다", async () => {
    await lockSession(true);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/room`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ locked: true });
    expect(body.roomId).toBeUndefined();
    expect(body.roomKey).toBeUndefined();
  });

  it("잠금을 풀면 다시 룸 키를 준다", async () => {
    await lockSession(true);
    await lockSession(false);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/room`,
      headers: authHeaders(memberSid),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

/**
 * 핸드셰이크 이후 권한이 회수되면 열린 협업 소켓도 끊어야 한다.
 * (실제 업그레이드 소켓 대신 레지스트리에 가짜 소켓을 넣어 배선을 검증한다 —
 *  프록시 훅이 소켓을 등록하는 부분은 `collab/proxy.ts` 의 한 줄이다.)
 */
describe("협업 소켓 강제 종료", () => {
  it("로그아웃하면 그 사용자의 소켓이 끊긴다", async () => {
    const socket = fakeSocket();
    ctx.app.collabSockets.register(memberId, socket);
    expect(ctx.app.collabSockets.countForUser(memberId)).toBe(1);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: authHeaders(memberSid),
    });
    expect(res.statusCode).toBe(200);
    expect(socket.destroyed).toBe(true);
    expect(ctx.app.collabSockets.countForUser(memberId)).toBe(0);
  });

  it("세션 멤버에서 빠지면 그 사용자의 소켓이 끊긴다", async () => {
    const socket = fakeSocket();
    ctx.app.collabSockets.register(memberId, socket);

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${sessionId}/members/${memberId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);
    expect(socket.destroyed).toBe(true);
  });

  it("사용자가 삭제되면 그 사용자의 소켓이 끊긴다", async () => {
    const socket = fakeSocket();
    ctx.app.collabSockets.register(memberId, socket);

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${memberId}`,
      headers: authHeaders(adminSid),
    });
    expect(res.statusCode).toBe(200);
    expect(socket.destroyed).toBe(true);
  });

  it("세션이 잠기면 그 세션에 접근할 수 있는 사용자의 소켓이 끊긴다", async () => {
    const memberSocket = fakeSocket();
    const outsiderSocket = fakeSocket();
    const outsiderId = ctx.app.db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE username = ?")
      .get("erin")!.id;
    ctx.app.collabSockets.register(memberId, memberSocket);
    ctx.app.collabSockets.register(outsiderId, outsiderSocket);

    await lockSession(true);

    expect(memberSocket.destroyed).toBe(true);
    // 이 세션과 무관한 사용자의 소켓은 건드리지 않는다.
    expect(outsiderSocket.destroyed).toBe(false);
  });

  it("잠금을 푸는 요청은 소켓을 끊지 않는다", async () => {
    await lockSession(true);
    const socket = fakeSocket();
    ctx.app.collabSockets.register(memberId, socket);
    await lockSession(false);
    expect(socket.destroyed).toBe(false);
  });
});

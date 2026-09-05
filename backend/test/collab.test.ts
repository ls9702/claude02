import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, login, type TestApp } from "./helpers.js";

let ctx: TestApp;
let adminSid: string;
let memberSid: string;
let outsiderSid: string;
let pageId: string;
let otherPageId: string;

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

  const memberId = await mkUser("dave");
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

  const sessionId = await mkSession("협업 세션");
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

  it("로그인한 사용자는 인증을 통과한다 (room 이 없으면 502/503)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/socket.io/?EIO=4&transport=polling",
      headers: authHeaders(memberSid),
    });
    // room 릴레이가 떠 있지 않으므로 프록시가 실패하지만, 401 은 아니어야 한다.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
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
});

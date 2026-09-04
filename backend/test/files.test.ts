import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, login, type TestApp } from "./helpers.js";

let ctx: TestApp;
let adminSid: string;
let userSid: string;
let sessionId: string;
let otherSessionId: string;
let pageId: string;
let otherPageId: string;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const BOUNDARY = "----ds118testboundary";

/** multipart/form-data 본문을 직접 만든다 (light-my-request 로 주입하기 위해). */
function multipart(fields: Record<string, string>, file?: { name: string; mime: string; data: Buffer }): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.mime}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

const upload = (sid: string, page: string, fileId: string, mime = "image/png", data = PNG) =>
  ctx.app.inject({
    method: "POST",
    url: `/api/pages/${page}/files`,
    headers: { ...authHeaders(sid), "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart({ fileId, mime }, { name: "img.png", mime, data }),
  });

beforeEach(async () => {
  ctx = await createTestApp();
  adminSid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const userId = (
    await ctx.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(adminSid),
      payload: { username: "carol", password: "userpass1234" },
    })
  ).json().user.id;
  userSid = await login(ctx.app, "carol", "userpass1234");

  const mkSession = async (name: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/admin/sessions",
        headers: authHeaders(adminSid),
        payload: { name },
      })
    ).json().session.id as string;

  sessionId = await mkSession("공유 세션");
  otherSessionId = await mkSession("비공개 세션");
  await ctx.app.inject({
    method: "PUT",
    url: `/api/admin/sessions/${sessionId}/members/${userId}`,
    headers: authHeaders(adminSid),
  });

  const mkPage = async (sid2: string) =>
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${sid2}/pages`,
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

describe("파일 업로드", () => {
  it("업로드하고 다시 받을 수 있다", async () => {
    const res = await upload(userSid, pageId, "abc123");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: "abc123", deduplicated: false });

    const get = await ctx.app.inject({ method: "GET", url: "/files/abc123", headers: authHeaders(userSid) });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(get.rawPayload.equals(PNG)).toBe(true);
  });

  it("같은 fileId 를 다시 올리면 200 이고 중복 저장하지 않는다", async () => {
    await upload(userSid, pageId, "dedup1");
    const again = await upload(userSid, pageId, "dedup1");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: "dedup1", deduplicated: true });

    const count = ctx.app.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM files")
      .get()!.c;
    expect(count).toBe(1);
  });

  it("접근 권한 없는 페이지의 파일은 403", async () => {
    await upload(adminSid, otherPageId, "secret1");
    const res = await ctx.app.inject({ method: "GET", url: "/files/secret1", headers: authHeaders(userSid) });
    expect(res.statusCode).toBe(403);
  });

  it("비로그인은 401", async () => {
    await upload(userSid, pageId, "public1");
    const res = await ctx.app.inject({ method: "GET", url: "/files/public1" });
    expect(res.statusCode).toBe(401);
  });

  it("없는 파일은 404", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/files/notthere", headers: authHeaders(userSid) });
    expect(res.statusCode).toBe(404);
  });

  it("경로 조작 문자가 든 fileId 는 거부한다", async () => {
    const res = await upload(userSid, pageId, "../../etc/passwd");
    expect(res.statusCode).toBe(400);
  });

  it("허용되지 않은 mime 은 400", async () => {
    const res = await upload(userSid, pageId, "badmime1", "application/pdf");
    expect(res.statusCode).toBe(400);
  });

  it("5MB 를 넘으면 413", async () => {
    const res = await upload(userSid, pageId, "toobig1", "image/png", Buffer.alloc(6 * 1024 * 1024, 7));
    expect(res.statusCode).toBe(413);
  });

  it("권한 없는 페이지로의 업로드는 403", async () => {
    const res = await upload(userSid, otherPageId, "nope1");
    expect(res.statusCode).toBe(403);
  });
});

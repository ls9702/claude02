import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** DATA_DIR 기준 실제 파일 경로 (files 행의 path 컬럼을 따른다) */
const storedPath = (fileId: string): string | null => {
  const row = ctx.app.db
    .prepare<[string], { path: string }>("SELECT path FROM files WHERE id = ?")
    .get(fileId);
  return row ? join(ctx.dataDir, row.path) : null;
};

const linkCount = (fileId: string): number =>
  ctx.app.db
    .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM page_files WHERE file_id = ?")
    .get(fileId)!.c;

let carolId: string;

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
  carolId = userId;
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

describe("파일 소유권 (page_files 링크)", () => {
  /** 세션 + 페이지를 만들고 carol 을 멤버로 넣는다. */
  const mkSessionPage = async (name: string, withCarol: boolean) => {
    const sid2 = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/admin/sessions",
        headers: authHeaders(adminSid),
        payload: { name },
      })
    ).json().session.id as string;
    if (withCarol) {
      await ctx.app.inject({
        method: "PUT",
        url: `/api/admin/sessions/${sid2}/members/${carolId}`,
        headers: authHeaders(adminSid),
      });
    }
    const page = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${sid2}/pages`,
        headers: authHeaders(adminSid),
        payload: { name: "캔버스", type: "canvas" },
      })
    ).json().page.id as string;
    return { sessionId: sid2, pageId: page };
  };

  it("같은 fileId 를 다른 세션의 페이지에 올리면 링크만 추가되고 두 멤버 모두 볼 수 있다", async () => {
    // 세션1(관리자만) 페이지에 업로드
    const first = await upload(adminSid, otherPageId, "shared01");
    expect(first.statusCode).toBe(201);

    // carol 은 아직 이 파일을 볼 수 없다.
    const before = await ctx.app.inject({
      method: "GET",
      url: "/files/shared01",
      headers: authHeaders(userSid),
    });
    expect(before.statusCode).toBe(403);

    // carol 이 자기 세션 페이지에 같은 fileId 를 올린다 → 링크만 추가(200 deduplicated)
    const second = await upload(userSid, pageId, "shared01");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ id: "shared01", deduplicated: true });
    expect(linkCount("shared01")).toBe(2);
    expect(
      ctx.app.db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM files").get()!.c,
    ).toBe(1);

    // 이제 carol 도, 관리자도 같은 파일을 받을 수 있다.
    for (const sid of [userSid, adminSid]) {
      const res = await ctx.app.inject({ method: "GET", url: "/files/shared01", headers: authHeaders(sid) });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PNG)).toBe(true);
    }
  });

  it("한 페이지를 지워도 다른 페이지에서 여전히 접근할 수 있다", async () => {
    const a = await mkSessionPage("파일 세션 A", true);
    const b = await mkSessionPage("파일 세션 B", true);
    expect((await upload(userSid, a.pageId, "linked01")).statusCode).toBe(201);
    expect((await upload(userSid, b.pageId, "linked01")).statusCode).toBe(200);
    const path = storedPath("linked01")!;
    expect(existsSync(path)).toBe(true);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/pages/${a.pageId}`,
      headers: authHeaders(userSid),
    });
    expect(del.statusCode).toBe(200);

    expect(linkCount("linked01")).toBe(1);
    expect(existsSync(path)).toBe(true);
    const still = await ctx.app.inject({
      method: "GET",
      url: "/files/linked01",
      headers: authHeaders(userSid),
    });
    expect(still.statusCode).toBe(200);
  });

  it("마지막 링크가 사라지면 파일 행과 디스크 파일이 삭제된다", async () => {
    const a = await mkSessionPage("마지막 링크 세션", true);
    expect((await upload(userSid, a.pageId, "orphan01")).statusCode).toBe(201);
    const path = storedPath("orphan01")!;
    expect(existsSync(path)).toBe(true);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/pages/${a.pageId}`,
      headers: authHeaders(userSid),
    });
    expect(del.statusCode).toBe(200);

    expect(
      ctx.app.db.prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM files WHERE id = ?").get("orphan01")!.c,
    ).toBe(0);
    expect(existsSync(path)).toBe(false);

    const gone = await ctx.app.inject({
      method: "GET",
      url: "/files/orphan01",
      headers: authHeaders(userSid),
    });
    expect(gone.statusCode).toBe(404);
  });

  it("세션을 삭제하면 그 세션에만 링크된 파일이 디스크에서도 정리된다", async () => {
    const a = await mkSessionPage("삭제될 세션", true);
    const b = await mkSessionPage("남는 세션", true);
    expect((await upload(userSid, a.pageId, "gcfile01")).statusCode).toBe(201);
    expect((await upload(userSid, a.pageId, "gcfile02")).statusCode).toBe(201);
    // gcfile02 는 다른 세션 페이지에도 링크한다 → 세션 삭제 후에도 살아남아야 한다.
    expect((await upload(userSid, b.pageId, "gcfile02")).statusCode).toBe(200);

    const path1 = storedPath("gcfile01")!;
    const path2 = storedPath("gcfile02")!;

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${a.sessionId}`,
      headers: authHeaders(adminSid),
    });
    expect(del.statusCode).toBe(200);

    expect(existsSync(path1)).toBe(false);
    expect(existsSync(path2)).toBe(true);
    expect(linkCount("gcfile02")).toBe(1);
    const still = await ctx.app.inject({
      method: "GET",
      url: "/files/gcfile02",
      headers: authHeaders(userSid),
    });
    expect(still.statusCode).toBe(200);
  });

  it("파일은 페이지와 무관한 files/<fileId> 경로에 저장된다", async () => {
    expect((await upload(userSid, pageId, "pathtest1")).statusCode).toBe(201);
    const row = ctx.app.db
      .prepare<[string], { path: string }>("SELECT path FROM files WHERE id = ?")
      .get("pathtest1")!;
    expect(row.path).toBe(join("files", "pathtest1"));
  });
});

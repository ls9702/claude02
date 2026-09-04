import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TOUCH_INTERVAL_MS, SESSION_TTL_MS } from "../src/config.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, extractCookie, login, type TestApp } from "./helpers.js";

let ctx: TestApp;

beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await ctx.close();
});

describe("부트스트랩", () => {
  it("최초 기동 시 관리자 계정을 만들고 비밀번호 변경을 강제한다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      username: ADMIN_USERNAME,
      role: "admin",
      must_change_password: true,
      ai_allowed: true,
    });
  });

  it("ADMIN_PASSWORD 가 없으면 기동에 실패한다", async () => {
    const { buildServer } = await import("../src/server.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ds118-noadmin-"));
    await expect(
      buildServer({
        config: { dataDir: dir, adminPassword: null, nodeEnv: "test", isProduction: false },
        logger: false,
      }),
    ).rejects.toThrow(/ADMIN_PASSWORD/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("로그인 / 쿠키", () => {
  it("성공하면 httpOnly SameSite=Lax sid 쿠키를 내려준다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie);
    expect(cookie).toMatch(/sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/i);
    expect(cookie).toMatch(new RegExp(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`));
  });

  it("COOKIE_SECURE=true 면 Secure 플래그를 붙인다", async () => {
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer({
      config: { dataDir: ctx.dataDir, cookieSecure: true, nodeEnv: "test", isProduction: false, adminPassword: ADMIN_PASSWORD, adminUsername: ADMIN_USERNAME },
      logger: false,
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    const setCookie = res.headers["set-cookie"];
    expect(Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie)).toMatch(/Secure/i);
    await app.close();
  });

  it("잘못된 비밀번호는 401 + 한국어 메시지", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: "invalid_credentials", message: "아이디 또는 비밀번호가 올바르지 않습니다." },
    });
  });

  it("존재하지 않는 사용자도 같은 401을 준다", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "whatever1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
  });

  it("비로그인 요청은 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("로그인이 필요합니다.");
  });

  it("로그아웃하면 세션이 무효화된다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    await ctx.app.inject({ method: "POST", url: "/api/auth/logout", headers: authHeaders(sid) });
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
    expect(res.statusCode).toBe(401);
  });

  it("로그인 시도는 분당 10회로 제한된다", async () => {
    const attempt = () =>
      ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ADMIN_USERNAME, password: "wrong-password" },
        remoteAddress: "10.9.9.9",
      });
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push((await attempt()).statusCode);
    }
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});

describe("슬라이딩 만료", () => {
  it("오래된 세션은 요청 시 last_seen_at / expires_at 이 갱신된다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const db = ctx.app.db;

    const past = new Date(Date.now() - SESSION_TOUCH_INTERVAL_MS - 60_000).toISOString();
    const pastExpiry = new Date(Date.now() + SESSION_TTL_MS - SESSION_TOUCH_INTERVAL_MS - 60_000).toISOString();
    db.prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(past, pastExpiry, sid);

    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
    expect(res.statusCode).toBe(200);
    // 갱신되면 쿠키 Max-Age 도 다시 내려준다.
    expect(extractCookie(res.headers)).toBe(sid);

    const row = db
      .prepare<[string], { last_seen_at: string; expires_at: string }>(
        "SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?",
      )
      .get(sid)!;
    expect(Date.parse(row.last_seen_at)).toBeGreaterThan(Date.parse(past));
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.parse(pastExpiry));
  });

  it("최근에 갱신된 세션은 매 요청마다 다시 쓰지 않는다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const before = ctx.app.db
      .prepare<[string], { last_seen_at: string }>("SELECT last_seen_at FROM auth_sessions WHERE id = ?")
      .get(sid)!.last_seen_at;
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
    expect(res.headers["set-cookie"]).toBeUndefined();
    const after = ctx.app.db
      .prepare<[string], { last_seen_at: string }>("SELECT last_seen_at FROM auth_sessions WHERE id = ?")
      .get(sid)!.last_seen_at;
    expect(after).toBe(before);
  });

  it("만료된 세션은 거부되고 삭제된다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    ctx.app.db
      .prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), sid);
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
    expect(res.statusCode).toBe(401);
    const row = ctx.app.db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sid);
    expect(row).toBeUndefined();
  });
});

describe("비밀번호 변경", () => {
  it("현재 비밀번호가 틀리면 400", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: authHeaders(sid),
      payload: { currentPassword: "nope-nope", newPassword: "newpass1234" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("현재 비밀번호가 올바르지 않습니다.");
  });

  it("8자 미만은 거부한다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: authHeaders(sid),
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: "short1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("8자 이상");
  });

  it("성공하면 must_change_password 가 꺼지고 새 쿠키를 받는다", async () => {
    const sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: authHeaders(sid),
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: "brandnew1234" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.must_change_password).toBe(false);

    const newSid = extractCookie(res.headers)!;
    expect(newSid).not.toBe(sid);

    // 이전 세션은 끊긴다.
    const stale = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
    expect(stale.statusCode).toBe(401);

    const fresh = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(newSid) });
    expect(fresh.statusCode).toBe(200);

    // 새 비밀번호로 로그인된다.
    await expect(login(ctx.app, ADMIN_USERNAME, "brandnew1234")).resolves.toBeTruthy();
  });
});

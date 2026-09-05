import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TOUCH_INTERVAL_MS, SESSION_TTL_MS, loadConfig, parseTrustProxy } from "../src/config.js";
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
    const fresh = await createTestApp({ keepPasswordChange: true });
    try {
      const sid = await login(fresh.app, ADMIN_USERNAME, ADMIN_PASSWORD);
      const res = await fresh.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: authHeaders(sid),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({
        username: ADMIN_USERNAME,
        role: "admin",
        must_change_password: true,
        ai_allowed: true,
      });
    } finally {
      await fresh.close();
    }
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

  it("X-Forwarded-For 를 바꿔가며 시도해도 rate limit 을 우회할 수 없다", async () => {
    // TRUST_PROXY 기본값(false)에서는 XFF 를 신뢰하지 않으므로 실제 소켓 주소로 카운트된다.
    const attempt = (forwarded: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": forwarded },
        payload: { username: ADMIN_USERNAME, password: "wrong-password" },
        remoteAddress: "10.1.2.3",
      });

    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      codes.push((await attempt(`9.9.9.${i + 1}`)).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("rate limit 응답 본문은 rate_limited 코드와 한국어 메시지를 준다", async () => {
    let last = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: ADMIN_USERNAME, password: "wrong-password" },
      remoteAddress: "10.4.5.6",
    });
    for (let i = 0; i < 10; i += 1) {
      last = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ADMIN_USERNAME, password: "wrong-password" },
        remoteAddress: "10.4.5.6",
      });
    }
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe("rate_limited");
    expect(last.json().error.message).toContain("로그인 시도가 너무 많습니다");
  });

  it("존재하지 않는 계정도 bcrypt 비교를 수행해 응답 시간이 비슷하다", async () => {
    const measure = async (username: string): Promise<number> => {
      const started = performance.now();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username, password: "definitely-wrong-password" },
        remoteAddress: `10.7.7.${Math.floor(Math.random() * 200) + 1}`,
      });
      expect(res.statusCode).toBe(401);
      return performance.now() - started;
    };

    // 워밍업 (JIT 편차 완화)
    await measure(ADMIN_USERNAME);
    const known = await measure(ADMIN_USERNAME);
    const unknown = await measure("no-such-user-here");

    // 더미 해시 비교를 하지 않으면 미존재 계정은 1~2ms 로 끝나 큰 차이가 난다.
    expect(unknown).toBeGreaterThan(known * 0.4);
  });
});

describe("TRUST_PROXY 설정", () => {
  it("환경변수를 안전한 기본값으로 해석한다", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("true")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("127.0.0.1,10.0.0.0/8")).toBe("127.0.0.1,10.0.0.0/8");
    expect(loadConfig({}).trustProxy).toBe(false);
  });
});

describe("강제 비밀번호 변경 (서버 강제)", () => {
  it("must_change_password 사용자는 me/password/logout 외 API 가 403", async () => {
    const fresh = await createTestApp({ keepPasswordChange: true });
    try {
      const sid = await login(fresh.app, ADMIN_USERNAME, ADMIN_PASSWORD);

      const me = await fresh.app.inject({ method: "GET", url: "/api/auth/me", headers: authHeaders(sid) });
      expect(me.statusCode).toBe(200);

      const sessions = await fresh.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: authHeaders(sid),
      });
      expect(sessions.statusCode).toBe(403);
      expect(sessions.json().error.code).toBe("must_change_password");

      const admin = await fresh.app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: authHeaders(sid),
      });
      expect(admin.statusCode).toBe(403);
      expect(admin.json().error.code).toBe("must_change_password");

      const file = await fresh.app.inject({
        method: "GET",
        url: "/files/whatever",
        headers: authHeaders(sid),
      });
      expect(file.statusCode).toBe(403);
      expect(file.json().error.code).toBe("must_change_password");

      // 비밀번호를 바꾸면 곧바로 정상 사용할 수 있다.
      const changed = await fresh.app.inject({
        method: "POST",
        url: "/api/auth/password",
        headers: authHeaders(sid),
        payload: { currentPassword: ADMIN_PASSWORD, newPassword: "changed1234" },
      });
      expect(changed.statusCode).toBe(200);
      const newSid = extractCookie(changed.headers)!;
      const after = await fresh.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: authHeaders(newSid),
      });
      expect(after.statusCode).toBe(200);
    } finally {
      await fresh.close();
    }
  });

  it("로그아웃은 비밀번호 변경 전에도 허용된다", async () => {
    const fresh = await createTestApp({ keepPasswordChange: true });
    try {
      const sid = await login(fresh.app, ADMIN_USERNAME, ADMIN_PASSWORD);
      const res = await fresh.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: authHeaders(sid),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await fresh.close();
    }
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

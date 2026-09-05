import type { FastifyInstance } from "fastify";
import { LOGIN_RATE_LIMIT, SESSION_COOKIE } from "../config.js";
import { badRequest, unauthorized } from "../errors.js";
import { nowIso } from "../ids.js";
import { toPublicUser } from "../types.js";
import { asObject, requireString } from "../validate.js";
import { requireAuth, sessionCookieOptions } from "./plugin.js";
import { DUMMY_PASSWORD_HASH, checkPasswordPolicy, hashPassword, verifyPassword } from "./passwords.js";
import {
  createAuthSession,
  deleteAuthSession,
  deleteAuthSessionsForUser,
  findUserByUsername,
} from "./service.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: LOGIN_RATE_LIMIT.max,
          timeWindow: LOGIN_RATE_LIMIT.timeWindow,
          errorResponseBuilder: () => ({
            statusCode: 429,
            error: { code: "rate_limited", message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." },
          }),
        },
      },
    },
    async (req, reply) => {
      const body = asObject(req.body);
      const username = requireString(body, "username", "아이디", { max: 64 });
      const password = requireString(body, "password", "비밀번호", { max: 200 });

      const user = findUserByUsername(app.db, username);
      // 사용자가 없어도 더미 해시로 비교해 응답 시간을 맞춘다 (계정 존재 여부 열거 방지).
      const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
      if (!user || !ok) {
        throw unauthorized("아이디 또는 비밀번호가 올바르지 않습니다.", "invalid_credentials");
      }

      const session = createAuthSession(app.db, user.id, req.headers["user-agent"] ?? null);
      reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.config.cookieSecure));
      return { user: toPublicUser(user) };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.authSession) deleteAuthSession(app.db, req.authSession.id);
    // 열려 있는 협업·댓글 소켓은 핸드셰이크 때 한 번만 인증됐다 — 로그아웃과 함께 끊는다.
    if (req.user) {
      app.collabSockets.closeForUser(req.user.id);
      app.commentSockets.closeForUser(req.user.id);
      app.sheetSockets.closeForUser(req.user.id);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    return { user: toPublicUser(req.user!) };
  });

  app.post("/api/auth/password", { preHandler: requireAuth }, async (req, reply) => {
    const body = asObject(req.body);
    const currentPassword = requireString(body, "currentPassword", "현재 비밀번호", { max: 200 });
    const newPassword = requireString(body, "newPassword", "새 비밀번호", { max: 200 });

    const user = req.user!;
    const ok = await verifyPassword(currentPassword, user.password_hash);
    if (!ok) throw badRequest("현재 비밀번호가 올바르지 않습니다.", "invalid_password");

    const policy = checkPasswordPolicy(newPassword);
    if (!policy.ok) throw badRequest(policy.message!);
    if (newPassword === currentPassword) {
      throw badRequest("새 비밀번호는 현재 비밀번호와 달라야 합니다.");
    }

    const hash = await hashPassword(newPassword);
    app.db
      .prepare(
        "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
      )
      .run(hash, nowIso(), user.id);

    // 비밀번호를 바꾸면 다른 기기의 세션은 모두 끊고, 현재 기기만 새 세션으로 유지한다.
    deleteAuthSessionsForUser(app.db, user.id);
    const session = createAuthSession(app.db, user.id, req.headers["user-agent"] ?? null);
    reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.config.cookieSecure));

    const updated = app.db
      .prepare<[string], typeof user>("SELECT * FROM users WHERE id = ?")
      .get(user.id)!;
    return { user: toPublicUser(updated) };
  });
}

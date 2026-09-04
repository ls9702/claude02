import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { SESSION_COOKIE, SESSION_TTL_MS } from "../config.js";
import { forbidden, unauthorized } from "../errors.js";
import { deleteAuthSession, findUserById, getAuthSession, isExpired, touchAuthSession } from "./service.js";

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie);

  app.decorateRequest("user", null);
  app.decorateRequest("authSession", null);

  app.addHook("onRequest", async (req, reply) => {
    req.user = null;
    req.authSession = null;

    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;

    const session = getAuthSession(app.db, sid);
    if (!session) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return;
    }
    if (isExpired(session)) {
      deleteAuthSession(app.db, session.id);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return;
    }

    const user = findUserById(app.db, session.user_id);
    if (!user) {
      deleteAuthSession(app.db, session.id);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return;
    }

    // 슬라이딩 만료: 오래된 세션만 갱신하고 쿠키 Max-Age 도 다시 내린다.
    const touched = touchAuthSession(app.db, session);
    if (touched.refreshed) {
      reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(app.config.cookieSecure));
    }

    req.user = user;
    req.authSession = touched.session;
  });
}

export default fp(authPlugin, { name: "auth" });

/** 로그인 필수 preHandler */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw unauthorized();
}

/** 관리자 전용 preHandler */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw unauthorized();
  if (req.user.role !== "admin") throw forbidden("관리자만 사용할 수 있습니다.");
}

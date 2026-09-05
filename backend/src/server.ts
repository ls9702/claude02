import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin/routes.js";
import { aiRoutes } from "./ai/routes.js";
import authPlugin from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { bootstrapAdmin, purgeExpiredSessions } from "./auth/service.js";
import { socketIoProxy, SOCKET_IO_PREFIX } from "./collab/proxy.js";
import { CollabSocketRegistry } from "./collab/sockets.js";
import { commentRoutes } from "./comments/routes.js";
import { CommentSocketRegistry } from "./comments/sockets.js";
import { commentWebsocket } from "./comments/ws.js";
import { loadConfig, MAX_FILE_BYTES, MAX_THUMBNAIL_BYTES, type AppConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { ApiError, forbidden } from "./errors.js";
import { fileRoutes } from "./files/routes.js";
import { sceneRoutes } from "./scenes/routes.js";
import { sessionRoutes } from "./sessions/routes.js";
import { sheetRoutes } from "./sheets/routes.js";
import { SheetSocketRegistry } from "./sheets/sockets.js";
import { sheetWebsocket } from "./sheets/ws.js";

export interface BuildServerOptions {
  config?: Partial<AppConfig>;
  logger?: boolean;
}

/** SPA fallback 에서 제외할 경로 접두사 */
const API_PREFIXES = ["/api", "/files", "/ws", SOCKET_IO_PREFIX];

/** must_change_password=1 인 사용자에게도 허용하는 경로 */
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/auth/me", "/api/auth/password", "/api/auth/logout"]);

/** 쿼리스트링을 뗀 경로 */
const pathOf = (url: string): string => url.split("?")[0] ?? url;

/** 강제 비밀번호 변경 가드가 적용되는 경로인지 (`/api/*`, `/files/*`, `/ws/*`, `/socket.io/*`) */
function isGuardedPath(url: string): boolean {
  const path = pathOf(url);
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/files" ||
    path.startsWith("/files/") ||
    path === "/ws" ||
    path.startsWith("/ws/") ||
    path === SOCKET_IO_PREFIX ||
    path.startsWith(`${SOCKET_IO_PREFIX}/`)
  );
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config: AppConfig = { ...loadConfig(), ...options.config };

  // Fastify 타입은 홉 수(number)를 직접 받지 않으므로 proxy-addr 과 같은 의미의 함수로 바꾼다.
  const trustProxy =
    typeof config.trustProxy === "number"
      ? (_address: string, hop: number) => hop < (config.trustProxy as number)
      : config.trustProxy;

  const app = Fastify({
    logger: options.logger ?? (config.nodeEnv !== "test" && { level: config.isProduction ? "info" : "warn" }),
    bodyLimit: 16 * 1024 * 1024,
    // 기본값은 false — X-Forwarded-For 스푸핑으로 IP 별 rate limit 을 우회할 수 없게 한다.
    // 리버스 프록시 뒤에서는 TRUST_PROXY=1 (또는 프록시 IP/CIDR) 로 켠다.
    trustProxy,
  });

  const db = openDatabase(config.dataDir);
  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("collabSockets", new CollabSocketRegistry());
  app.decorate("commentSockets", new CommentSocketRegistry());
  app.decorate("sheetSockets", new SheetSocketRegistry());
  app.addHook("onClose", async () => {
    db.close();
  });

  purgeExpiredSessions(db);
  await bootstrapAdmin(db, { username: config.adminUsername, password: config.adminPassword });

  // 썸네일은 raw PNG 본문으로 받는다.
  app.addContentTypeParser(
    "image/png",
    { parseAs: "buffer", bodyLimit: MAX_THUMBNAIL_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // global:false — rate limit 은 라우트에서 config.rateLimit 으로 개별 지정한다.
  // (한도 값은 config.ts 의 LOGIN_RATE_LIMIT 한 곳에서만 관리한다.)
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 },
  });
  await app.register(authPlugin);

  // 강제 비밀번호 변경: 서버에서도 막는다 (프론트 라우팅에만 의존하지 않는다).
  app.addHook("onRequest", async (req) => {
    if (!req.user || req.user.must_change_password !== 1) return;
    if (!isGuardedPath(req.url)) return;
    if (PASSWORD_CHANGE_ALLOWED.has(pathOf(req.url))) return;
    throw forbidden("비밀번호를 변경해야 계속 사용할 수 있습니다.", "must_change_password");
  });

  // 클릭재킹 방지 — 이 앱은 어디에도 임베드되지 않는다.
  // (전체 CSP 는 배포 단계(M6)에서 리버스 프록시와 함께 정한다 — KNOWN_ISSUES.md 참고.)
  app.addHook("onSend", async (_req, reply) => {
    if (!reply.getHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
  });

  app.setErrorHandler((raw, req, reply) => {
    const error = raw as Error & { code?: string; statusCode?: number };
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }

    // @fastify/rate-limit 은 Error 가 아닌 평범한 객체를 throw 한다:
    // `{ statusCode, error: { code, message } }` (errorResponseBuilder 의 반환값).
    const thrown = raw as { statusCode?: number; error?: { code?: unknown; message?: unknown } };
    const custom = thrown.error;
    if (custom && typeof custom.code === "string" && typeof custom.message === "string") {
      const customStatus = typeof thrown.statusCode === "number" ? thrown.statusCode : 400;
      return reply.code(customStatus).send({ error: { code: custom.code, message: custom.message } });
    }
    if (thrown.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." } });
    }

    const code = error.code;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({ error: { code: "payload_too_large", message: "요청 본문이 너무 큽니다." } });
    }
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply
        .code(415)
        .send({ error: { code: "unsupported_media_type", message: "지원하지 않는 요청 형식입니다." } });
    }
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) req.log.error({ err: error }, "unhandled error");
    return reply.code(status).send({
      error: {
        code: status >= 500 ? "internal_error" : "bad_request",
        message: status >= 500 ? "서버 오류가 발생했습니다." : "요청을 처리할 수 없습니다.",
      },
    });
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(sessionRoutes);
  await app.register(sceneRoutes);
  await app.register(fileRoutes);
  await app.register(commentRoutes);
  await app.register(sheetRoutes);
  await app.register(aiRoutes);
  await app.register(socketIoProxy);
  // socketIoProxy 다음에 등록한다 — upgrade 리스너 공존 처리는 commentWebsocket 안에 있다.
  await app.register(commentWebsocket);
  // 시트 채널은 commentWebsocket 이 등록한 @fastify/websocket 위에 라우트만 얹는다.
  await app.register(sheetWebsocket);

  app.get("/api/health", async () => ({ ok: true }));

  await registerStatic(app, config);

  return app;
}

async function registerStatic(app: FastifyInstance, config: AppConfig): Promise<void> {
  const distDir = process.env.FRONTEND_DIST
    ? resolve(process.cwd(), process.env.FRONTEND_DIST)
    : resolve(process.cwd(), "../frontend/dist");
  if (!config.isProduction || !existsSync(distDir)) {
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.code(404).send({ error: { code: "not_found", message: "요청한 경로를 찾을 수 없습니다." } });
    });
    return;
  }

  await app.register(fastifyStatic, { root: distDir, prefix: "/", index: ["index.html"] });

  // SPA fallback — API/파일/WS 경로는 제외한다.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== "GET" || API_PREFIXES.some((p) => req.url === p || req.url.startsWith(`${p}/`))) {
      return reply.code(404).send({ error: { code: "not_found", message: "요청한 경로를 찾을 수 없습니다." } });
    }
    return reply.sendFile("index.html");
  });
}

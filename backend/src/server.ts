import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin/routes.js";
import authPlugin from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { bootstrapAdmin, purgeExpiredSessions } from "./auth/service.js";
import { loadConfig, MAX_FILE_BYTES, MAX_THUMBNAIL_BYTES, type AppConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { ApiError } from "./errors.js";
import { fileRoutes } from "./files/routes.js";
import { sceneRoutes } from "./scenes/routes.js";
import { sessionRoutes } from "./sessions/routes.js";

export interface BuildServerOptions {
  config?: Partial<AppConfig>;
  logger?: boolean;
}

/** SPA fallback 에서 제외할 경로 접두사 */
const API_PREFIXES = ["/api", "/files", "/ws"];

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config: AppConfig = { ...loadConfig(), ...options.config };

  const app = Fastify({
    logger: options.logger ?? (config.nodeEnv !== "test" && { level: config.isProduction ? "info" : "warn" }),
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: true,
  });

  const db = openDatabase(config.dataDir);
  app.decorate("db", db);
  app.decorate("config", config);
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

  await app.register(fastifyRateLimit, {
    global: false,
    max: 10,
    timeWindow: "1 minute",
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 },
  });
  await app.register(authPlugin);

  app.setErrorHandler((raw, req, reply) => {
    const error = raw as Error & { code?: string; statusCode?: number };
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
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

import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import type { AuthSessionRow, UserRow } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
  }
  interface FastifyRequest {
    /** 인증된 사용자. 인증 훅이 채운다. 비로그인 요청이면 null. */
    user: UserRow | null;
    authSession: AuthSessionRow | null;
  }
}

export {};

import type { CollabSocketRegistry } from "./collab/sockets.js";
import type { CommentSocketRegistry } from "./comments/sockets.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import type { AuthSessionRow, UserRow } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
    /** 열려 있는 협업 소켓 — 권한 회수 시 끊는다 (collab/sockets.ts) */
    collabSockets: CollabSocketRegistry;
    /** 열려 있는 댓글 소켓 — 페이지별 브로드캐스트·권한 회수용 (comments/sockets.ts) */
    commentSockets: CommentSocketRegistry;
  }
  interface FastifyRequest {
    /** 인증된 사용자. 인증 훅이 채운다. 비로그인 요청이면 null. */
    user: UserRow | null;
    authSession: AuthSessionRow | null;
  }
}

export {};

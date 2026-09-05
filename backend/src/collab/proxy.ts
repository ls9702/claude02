import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";

/** socket.io 가 쓰는 경로 접두사 — 프론트는 항상 app 오리진의 이 경로로 접속한다. */
export const SOCKET_IO_PREFIX = "/socket.io";

/**
 * `/socket.io/*` → excalidraw-room 프록시.
 *
 * 프론트는 room(3002)에 직접 붙지 않고 언제나 app 오리진으로 접속한다.
 * 덕분에 (1) 배포 시 DSM 리버스 프록시는 app 하나만 바라보면 되고,
 * (2) 릴레이 접속에도 우리 세션 쿠키 인증을 걸 수 있다.
 *
 * 인증: HTTP 폴링과 WebSocket 업그레이드 **양쪽 모두** `requireAuth` 를 통과해야 한다.
 * `@fastify/http-proxy` 는 업그레이드 요청도 `fastify.routing()` 으로 흘려보내므로
 * (index.js 의 `handleUpgrade`) 라우트 preHandler 와 전역 onRequest 훅이 그대로 돈다.
 * 인증에 실패하면 401 응답이 소켓에 쓰이고 소켓이 닫힌다.
 *
 * 룸 접근 자체(어떤 페이지의 룸에 들어갈 수 있는가)는 룸 id·키를 아는지로 통제한다.
 * 룸 id·키는 `GET /api/pages/:id/room` 이 세션 멤버에게만 내려준다.
 */
export async function socketIoProxy(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHttpProxy, {
    upstream: app.config.roomUrl,
    prefix: SOCKET_IO_PREFIX,
    rewritePrefix: SOCKET_IO_PREFIX,
    websocket: true,
    // 업그레이드·폴링 요청 모두 이 훅을 지난다.
    preHandler: requireAuth,
  });
}

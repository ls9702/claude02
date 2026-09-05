import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
 * 인증은 핸드셰이크 1회뿐이므로, 통과한 업그레이드 소켓을 `app.collabSockets` 에
 * 사용자별로 기록해 둔다. 로그아웃·멤버 해제·사용자 삭제·세션 잠금 시 서버가
 * 그 소켓을 직접 끊는다 (`collab/sockets.ts` 참고).
 *
 * 룸 접근 자체(어떤 페이지의 룸에 들어갈 수 있는가)는 룸 id·키를 아는지로 통제한다.
 * 룸 id·키는 `GET /api/pages/:id/room` 이 세션 멤버에게만 내려준다
 * (잠긴 세션이면 아무에게도 주지 않는다).
 */
export async function socketIoProxy(app: FastifyInstance): Promise<void> {
  const authAndTrack = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(req, reply);
    trackUpgradeSocket(app, req);
  };

  await app.register(fastifyHttpProxy, {
    upstream: app.config.roomUrl,
    prefix: SOCKET_IO_PREFIX,
    rewritePrefix: SOCKET_IO_PREFIX,
    websocket: true,
    // 업그레이드·폴링 요청 모두 이 훅을 지난다.
    preHandler: authAndTrack,
    replyOptions: {
      // 룸이 떠 있지 않으면 우리 서버 오류(500)가 아니라 게이트웨이 오류(502)다.
      onError: (reply, error) => {
        reply.log.warn({ err: error.error }, "room proxy error");
        void reply
          .code(502)
          .send({ error: { code: "room_unavailable", message: "실시간 협업 서버에 연결할 수 없습니다." } });
      },
    },
  });
}

/**
 * 업그레이드 요청이면 그 요청의 raw 소켓을 사용자별로 기록한다.
 * (폴링 요청은 매번 새로 인증을 지나므로 추적할 필요가 없다.)
 */
function trackUpgradeSocket(app: FastifyInstance, req: FastifyRequest): void {
  const upgrade = req.raw.headers.upgrade;
  if (!upgrade || upgrade.toLowerCase() !== "websocket") return;
  const socket = req.raw.socket;
  const user = req.user;
  if (!socket || !user) return;
  app.collabSockets.register(user.id, socket);
}

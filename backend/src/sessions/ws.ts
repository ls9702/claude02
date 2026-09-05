/**
 * 세션 실시간 이벤트 채널 — `GET /ws/session/:sessionId` (@fastify/websocket).
 *
 * 인증·권한은 댓글·시트 채널과 **같은 방식**이다: 전역 인증 훅이 쿠키로 `req.user` 를
 * 채우고, preHandler 가 `requireAuth` + `requireSessionMember` 를 지난다. 실패하면
 * 업그레이드 대신 401/403/404 JSON 이 소켓에 쓰이고 연결이 닫힌다.
 *
 * `/ws/*` 업그레이드 리스너 정리(=socket.io 프록시와의 공존)는 `comments/ws.ts` 의
 * `commentWebsocket` 플러그인이 이미 해 두었다 — 이 플러그인은 그 뒤에 등록되어
 * 라우트만 추가한다.
 *
 * 프로토콜 (JSON, 서버→클라 단방향):
 *   `ready`            { sessionId }
 *   `page.created`     { sessionId, page }
 *   `page.updated`     { sessionId, page }
 *   `page.deleted`     { sessionId, pageId }
 *   `pages.reordered`  { sessionId, pages }
 *   `session.updated`  { session }                — 이름·잠금 변경
 *   `session.deleted`  { sessionId }
 *   `member.removed`   { sessionId, userId }      — 그 사용자만 목록으로 나간다
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireSessionMember } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { attachHeartbeat } from "../comments/heartbeat.js";

export async function sessionWebsocket(app: FastifyInstance): Promise<void> {
  const guard = async (
    req: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAuth(req, reply);
    requireSessionMember(app.db, req.user!, req.params.sessionId);
  };

  app.get<{ Params: { sessionId: string } }>(
    "/ws/session/:sessionId",
    { websocket: true, preHandler: guard },
    (socket: WebSocket, req) => {
      const user = req.user!;
      const { sessionId } = req.params;
      const dispose = app.sessionSockets.add(sessionId, user.id, socket);

      // ping 주기마다 pong 을 확인하고, 연속 2회 놓친 소켓은 끊는다 (comments/heartbeat.ts).
      const stopHeartbeat = attachHeartbeat(socket, {
        intervalMs: app.config.commentWsPingMs,
      });

      const cleanup = () => {
        stopHeartbeat();
        dispose();
      };
      socket.on("close", cleanup);
      socket.on("error", () => {
        cleanup();
        try {
          socket.close();
        } catch {
          // 이미 닫혔다.
        }
      });

      // 구독이 시작됐음을 알린다 (클라이언트가 재연결 백오프를 초기화하고,
      // 끊겼던 동안 놓친 변경을 세션 재로딩으로 회수하는 신호).
      //
      // 첫 메시지는 다음 틱에 보낸다 — 핸들러가 도는 동안에는 클라이언트가 아직
      // 'message' 리스너를 붙이기 전일 수 있다(테스트의 injectWS 가 그렇다).
      // 시트 채널(`sheets/ws.ts`)이 같은 이유로 같은 방식을 쓴다.
      setImmediate(() => {
        if (socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ type: "ready", payload: { sessionId } }));
        } catch {
          // 곧바로 끊긴 연결은 무시한다.
        }
      });
    },
  );
}

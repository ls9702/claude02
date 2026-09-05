/**
 * 댓글 실시간 채널 — `GET /ws/comments/:pageId` (@fastify/websocket).
 *
 * 인증·권한은 **핸드셰이크에서** 처리한다: 전역 인증 훅이 세션 쿠키로 `req.user` 를
 * 채우고, 라우트 preHandler 가 `requireAuth` + `requirePageAccess` 를 지난다.
 * 실패하면 업그레이드 대신 401/403/404 JSON 이 소켓에 쓰이고 연결이 닫힌다.
 *
 * ⚠️ upgrade 리스너 공존
 * `@fastify/websocket` 은 서버의 **모든** upgrade 를 가로채 `fastify.routing()` 으로
 * 흘려보낸다. 그런데 이 서버에는 `/socket.io/*` 를 담당하는 `@fastify/http-proxy` 의
 * upgrade 리스너가 이미 있다(`collab/proxy.ts`). 둘 다 그대로 두면 하나의 upgrade 가
 * 라우터에 **두 번** 들어가 소켓이 깨진다. http-proxy 쪽은 리스너가 둘 이상일 때
 * 자기 prefix 만 처리하도록 이미 막혀 있으므로, 여기서는 반대로
 * `@fastify/websocket` 이 등록한 리스너를 감싸 **`/ws/*` 만** 처리하게 한다.
 * (어느 쪽도 담당하지 않는 경로의 업그레이드는 소켓을 붙잡아 두지 않도록 끊는다.)
 */
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { SOCKET_IO_PREFIX } from "../collab/proxy.js";

/** 이 라우트가 담당하는 경로 접두사 */
export const COMMENT_WS_PREFIX = "/ws";

/** 클라이언트가 보낼 수 있는 메시지 크기 상한 (서버→클라이언트 단방향 채널이라 작게 잡는다) */
const MAX_WS_PAYLOAD = 4 * 1024;

/** 유휴 연결이 프록시에서 끊기지 않도록 보내는 ping 주기 */
const PING_INTERVAL_MS = 30_000;

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const pathOf = (url: string): string => url.split("?")[0] ?? url;

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

async function commentWebsocketPlugin(app: FastifyInstance): Promise<void> {
  const before = new Set(app.server.listeners("upgrade") as UpgradeListener[]);
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD } });
  const added = (app.server.listeners("upgrade") as UpgradeListener[]).filter(
    (listener) => !before.has(listener),
  );
  // 리스너를 못 찾았다면 플러그인 내부 구현이 바뀐 것이다 — 조용히 지나가면
  // /socket.io 업그레이드가 이중 라우팅되므로 부팅 단계에서 바로 실패시킨다.
  if (added.length !== 1) {
    throw new Error(
      `@fastify/websocket 의 upgrade 리스너를 특정하지 못했습니다 (발견 ${added.length}개).`,
    );
  }
  const wsUpgrade = added[0]!;
  app.server.off("upgrade", wsUpgrade);
  app.server.on("upgrade", (req, socket, head) => {
    const path = pathOf(req.url ?? "");
    if (isUnder(path, COMMENT_WS_PREFIX)) {
      wsUpgrade(req, socket, head);
      return;
    }
    // `/socket.io/*` 는 http-proxy 의 리스너가 처리한다 — 건드리지 않는다.
    if (isUnder(path, SOCKET_IO_PREFIX)) return;
    socket.destroy();
  });

  const guard = async (
    req: FastifyRequest<{ Params: { pageId: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAuth(req, reply);
    requirePageAccess(app.db, req.user!, req.params.pageId);
  };

  app.get<{ Params: { pageId: string } }>(
    "/ws/comments/:pageId",
    { websocket: true, preHandler: guard },
    (socket: WebSocket, req) => {
      const user = req.user!;
      const { pageId } = req.params;
      const dispose = app.commentSockets.add(pageId, user.id, socket);

      const ping = setInterval(() => {
        try {
          socket.ping();
        } catch {
          // 닫히는 중이면 무시한다 — close 핸들러가 정리한다.
        }
      }, PING_INTERVAL_MS);
      ping.unref?.();

      const cleanup = () => {
        clearInterval(ping);
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

      // 구독이 시작됐음을 알린다 (클라이언트가 재연결 백오프를 초기화하는 신호).
      try {
        socket.send(JSON.stringify({ type: "ready", payload: { pageId } }));
      } catch {
        // 곧바로 끊긴 연결은 무시한다.
      }
    },
  );
}

/**
 * fastify-plugin 으로 감싸 **루트 스코프**에 등록한다.
 * 그래야 `@fastify/websocket` 이 붙이는 데코레이터(`injectWS`, `websocketServer`)를
 * 앱 전체에서 쓸 수 있다(테스트가 `app.injectWS()` 로 핸드셰이크를 검증한다).
 */
export const commentWebsocket = fp(commentWebsocketPlugin, { name: "comment-websocket" });

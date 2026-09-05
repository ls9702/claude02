/**
 * 시트 실시간 채널 — `GET /ws/sheet/:pageId` (@fastify/websocket).
 *
 * 인증·권한은 댓글 채널과 **같은 방식**이다: 전역 인증 훅이 쿠키로 `req.user` 를 채우고,
 * preHandler 가 `requireAuth` + `requirePageAccess` 를 지난다. 실패하면 업그레이드 대신
 * 401/403/404 JSON 이 소켓에 쓰이고 연결이 닫힌다.
 *
 * `/ws/*` 업그레이드 리스너 정리(=socket.io 프록시와의 공존)는 `comments/ws.ts` 의
 * `commentWebsocket` 플러그인이 이미 해 두었다 — 이 플러그인은 그 뒤에 등록되어
 * 라우트만 추가한다.
 *
 * 프로토콜 (JSON):
 *   서버→클라 `ready`    { clientId, version, readOnly, members }
 *   서버→클라 `presence` { members }            — 접속자 변동
 *   서버→클라 `op`       { ops, from, seq }     — 다른 사람의 편집 (자기 것은 안 온다)
 *   서버→클라 `saved`    { version, by, at }    — 누군가 전체 저장을 끝냈다
 *   서버→클라 `readonly` { readOnly }           — 세션 잠금이 바뀌었다 (재접속 없이 반영)
 *   서버→클라 `error`    { code, message }  — `bad_op` 가 분당 30회를 넘으면
 *                                          `too_many_bad_ops` 를 보내고 소켓을 끊는다.
 *   클라→서버 `op`       { ops }
 *
 * 서버는 op 를 해석하지 않고 그대로 중계한다. 저장은 `PUT /api/pages/:id/sheet`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { attachHeartbeat } from "../comments/heartbeat.js";
import { newId } from "../ids.js";
import { readSheet } from "./service.js";

/** 한 메시지에 담을 수 있는 op 개수 상한 (붙여넣기 한 번이 수백 개가 될 수 있다) */
const MAX_OPS_PER_MESSAGE = 5000;

/**
 * 형태가 잘못된 op(`bad_op`)를 이만큼 넘게 보내면 소켓을 끊는다.
 *
 * 정상 클라이언트는 `bad_op` 를 만들지 않는다 — 한두 번은 버전 차이나 버그로 볼 수 있지만
 * 계속 쏟아지면 오작동·악용이다. 에러만 돌려주고 계속 살려 두면 같은 클라이언트가
 * 무한히 재시도하며 서버 CPU 를 태울 수 있어(검증 리포트 WS 절 [Low]) 창 단위로 센다.
 */
export const MAX_BAD_OPS_PER_WINDOW = 30;
/** 위 상한을 세는 창 (1분) */
export const BAD_OP_WINDOW_MS = 60_000;
/** 상한 초과로 끊을 때 쓰는 WebSocket 종료 코드 (1008 = policy violation) */
const POLICY_VIOLATION = 1008;

interface ClientMessage {
  type?: unknown;
  ops?: unknown;
}

const isOpArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= MAX_OPS_PER_MESSAGE &&
  value.every(
    (op) =>
      !!op &&
      typeof op === "object" &&
      !Array.isArray(op) &&
      typeof (op as { op?: unknown }).op === "string" &&
      Array.isArray((op as { path?: unknown }).path),
  );

export async function sheetWebsocket(app: FastifyInstance): Promise<void> {
  const guard = async (
    req: FastifyRequest<{ Params: { pageId: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAuth(req, reply);
    const { page } = requirePageAccess(app.db, req.user!, req.params.pageId);
    if (page.type !== "sheet") {
      await reply.code(404).send({
        error: { code: "not_found", message: "시트 페이지가 아닙니다." },
      });
    }
  };

  app.get<{ Params: { pageId: string } }>(
    "/ws/sheet/:pageId",
    { websocket: true, preHandler: guard },
    (socket: WebSocket, req) => {
      const user = req.user!;
      const { pageId } = req.params;
      /**
       * 잠금은 소켓이 살아 있는 동안에도 바뀐다 — 핸드셰이크 시점 스냅샷을 클로저에
       * 가둬 두면 잠금 해제 뒤에도 릴레이가 계속 막히고, 반대로 잠근 뒤에도
       * 이미 붙어 있던 소켓은 계속 중계된다. 그래서 **매번 DB 를 다시 본다**
       * (REST `PUT /sheet` 의 `assertWritable` 과 같은 성질로 맞춘다).
       */
      const isReadOnly = (): boolean => {
        try {
          const { session } = requirePageAccess(app.db, user, pageId);
          return session.locked === 1 && user.role !== "admin";
        } catch {
          // 페이지·세션이 사라졌거나 권한이 빠졌다 — 안전한 쪽(읽기 전용)으로 본다.
          return true;
        }
      };
      const clientId = newId();

      /** `bad_op` 남용 카운터 — 창이 지나면 0 부터 다시 센다. */
      let badOps = 0;
      let badOpWindowStart = 0;
      /** 이번 `bad_op` 로 상한을 넘었으면 true (소켓을 끊어야 한다) */
      const countBadOp = (now: number): boolean => {
        if (now - badOpWindowStart > BAD_OP_WINDOW_MS) {
          badOpWindowStart = now;
          badOps = 0;
        }
        badOps += 1;
        return badOps > MAX_BAD_OPS_PER_WINDOW;
      };

      const dispose = app.sheetSockets.add(
        pageId,
        { clientId, userId: user.id, username: user.username },
        socket,
      );
      const stopHeartbeat = attachHeartbeat(socket, { intervalMs: app.config.commentWsPingMs });

      const send = (type: string, payload: unknown) => {
        try {
          socket.send(JSON.stringify({ type, payload }));
        } catch {
          // 곧바로 끊긴 연결은 무시한다.
        }
      };

      // 첫 메시지는 다음 틱에 보낸다 — 핸들러가 도는 동안에는 클라이언트가 아직
      // 'message' 리스너를 붙이기 전일 수 있다(테스트의 injectWS 가 그렇다).
      setImmediate(() => {
        if (socket.readyState !== 1) return;
        const stored = readSheet(app.db, pageId);
        send("ready", {
          clientId,
          version: stored.version,
          readOnly: isReadOnly(),
          members: app.sheetSockets.members(pageId),
        });
        // 접속자 목록 변경을 다른 사람에게 알린다.
        app.sheetSockets.broadcastExcept(pageId, clientId, {
          type: "presence",
          payload: { members: app.sheetSockets.members(pageId) },
        });
      });

      /** 접속 정리 — close 이벤트와 강제 종료 양쪽에서 부른다(두 번 불려도 안전하다). */
      const cleanup = () => {
        stopHeartbeat();
        dispose();
        app.sheetSockets.broadcast(pageId, {
          type: "presence",
          payload: { members: app.sheetSockets.members(pageId) },
        });
      };

      socket.on("message", (raw: unknown) => {
        let parsed: ClientMessage;
        try {
          parsed = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return; // 형태가 깨진 메시지는 조용히 버린다.
        }
        if (!parsed || parsed.type !== "op") return;

        if (isReadOnly()) {
          // 잠긴 세션에서는 릴레이하지 않는다 (REST 저장도 403 이다).
          send("error", { code: "session_locked", message: "잠긴 세션은 읽기 전용입니다." });
          return;
        }
        if (!isOpArray(parsed.ops)) {
          if (countBadOp(Date.now())) {
            // 너무 많다 — 안내하고 끊는다. 정상 클라이언트는 자동으로 다시 붙는다.
            send("error", {
              code: "too_many_bad_ops",
              message: "잘못된 편집 요청이 너무 많아 연결을 끊었습니다.",
            });
            // 레지스트리에서 **먼저** 뺀다 — close 핸드셰이크가 끝나기 전에도
            // 이 소켓에 더 이상 중계하지 않도록.
            cleanup();
            try {
              socket.close(POLICY_VIOLATION, "too_many_bad_ops");
            } catch {
              // 이미 닫혔다.
            }
            return;
          }
          send("error", { code: "bad_op", message: "편집 내용을 전달하지 못했습니다." });
          return;
        }

        const seq = app.sheetSockets.nextSeq(pageId);
        app.sheetSockets.broadcastExcept(pageId, clientId, {
          type: "op",
          payload: { ops: parsed.ops, from: clientId, seq },
        });
      });

      socket.on("close", cleanup);
      socket.on("error", () => {
        cleanup();
        try {
          socket.close();
        } catch {
          // 이미 닫혔다.
        }
      });
    },
  );
}

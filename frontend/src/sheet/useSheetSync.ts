/**
 * 시트 실시간 채널 클라이언트 (`/ws/sheet/:pageId`).
 *
 * 댓글 채널(`useComments`)과 같은 재접속 정책(지수 백오프 + 흔들림)을 쓴다.
 * 다른 점은 양방향이라는 것: 내 편집 op 를 보내고, 다른 사람의 op 를 받는다.
 * 서버가 발신자에게는 되돌려 주지 않으므로 에코를 걸러낼 필요가 없다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollabConnection } from "../collab/status";

/** 재접속 백오프: 0.5초에서 시작해 최대 15초까지 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export interface SheetMember {
  userId: string;
  username: string;
}

export interface SheetSyncHandlers {
  /** 다른 사람의 편집 op */
  onOps(ops: unknown[]): void;
  /** 누군가 전체 저장을 끝냈다 (버전 동기화용) */
  onSaved(version: number, by: string): void;
  /** (재)접속 완료 — 끊겼던 동안의 변경을 회수하려면 여기서 다시 읽는다. */
  onReady(info: { version: number; readOnly: boolean; reconnected: boolean }): void;
  /**
   * 세션 잠금이 바뀌어 서버가 `readOnly` 를 다시 알려 왔다.
   * 소켓을 끊지 않고 밀어 주므로, 잠금 중에 열어 둔 시트도 **새로고침 없이** 편집이 돌아온다.
   */
  onReadOnly(readOnly: boolean): void;
}

export interface SheetSync {
  connection: CollabConnection;
  members: SheetMember[];
  /** 내 편집을 방송한다. 연결이 끊겨 있으면 false 를 돌려준다(저장은 따로 진행된다). */
  sendOps(ops: unknown[]): boolean;
}

interface ServerEvent {
  type: string;
  payload: Record<string, unknown>;
}

export function useSheetSync(pageId: string, handlers: SheetSyncHandlers): SheetSync {
  const [connection, setConnection] = useState<CollabConnection>("idle");
  const [members, setMembers] = useState<SheetMember[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  // 핸들러는 매 렌더 바뀔 수 있으니 ref 로 들고 다닌다 (소켓을 다시 열지 않기 위해).
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    aliveRef.current = true;
    setMembers([]);

    const apply = (event: ServerEvent) => {
      switch (event.type) {
        case "ready":
          setMembers(toMembers(event.payload.members));
          handlersRef.current.onReady({
            version: Number(event.payload.version ?? 0),
            readOnly: Boolean(event.payload.readOnly),
            reconnected: retryRef.current > 0,
          });
          retryRef.current = 0;
          setConnection("connected");
          break;
        case "presence":
          setMembers(toMembers(event.payload.members));
          break;
        case "op": {
          const ops = event.payload.ops;
          if (Array.isArray(ops) && ops.length > 0) handlersRef.current.onOps(ops);
          break;
        }
        case "readonly":
          handlersRef.current.onReadOnly(Boolean(event.payload.readOnly));
          break;
        case "saved":
          handlersRef.current.onSaved(
            Number(event.payload.version ?? 0),
            String(event.payload.by ?? ""),
          );
          break;
        default:
          break;
      }
    };

    const scheduleReconnect = () => {
      if (!aliveRef.current || timerRef.current) return;
      const attempt = retryRef.current;
      retryRef.current = attempt + 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      const jitter = Math.random() * 0.3 * delay;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay + jitter);
    };

    const connect = () => {
      if (!aliveRef.current) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${scheme}://${window.location.host}/ws/sheet/${pageId}`;
      // 처음 붙는 동안에는 배지를 띄우지 않는다(CollabConnection 에 "connecting" 은 없다).
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onmessage = (message) => {
        if (!aliveRef.current) return;
        try {
          const parsed = JSON.parse(String(message.data)) as ServerEvent;
          if (parsed && typeof parsed.type === "string") apply(parsed);
        } catch {
          // 형태가 깨진 메시지는 버린다.
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (!aliveRef.current) return;
        setMembers([]);
        setConnection("reconnecting");
        scheduleReconnect();
      };
      socket.onerror = () => {
        // onclose 가 이어서 온다 — 여기서는 아무것도 하지 않는다.
      };
    };

    connect();

    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      retryRef.current = 0;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.close();
      }
      setConnection("idle");
      setMembers([]);
    };
  }, [pageId]);

  const sendOps = useCallback((ops: unknown[]): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || ops.length === 0) return false;
    try {
      socket.send(JSON.stringify({ type: "op", ops }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { connection, members, sendOps };
}

function toMembers(value: unknown): SheetMember[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const member = item as { userId?: unknown; username?: unknown };
    if (typeof member.userId !== "string" || typeof member.username !== "string") return [];
    return [{ userId: member.userId, username: member.username }];
  });
}

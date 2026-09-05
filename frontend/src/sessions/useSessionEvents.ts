/**
 * 세션 실시간 이벤트 구독 (`/ws/session/:sessionId`).
 *
 * 댓글(`useComments`)·시트(`useSheetSync`) 채널과 **같은 재접속 정책**(지수 백오프 +
 * 흔들림)을 쓴다. 서버→클라 단방향이라 보낼 것은 없다.
 *
 * 이 채널이 없던 동안에는 세션 화면이 마운트 시 1회 로드가 전부라, 관리자가 보고 있던
 * 페이지를 지워도 화면은 그대로 남고 자동저장만 계속 실패했다. 이제 페이지 추가·이름
 * 변경·삭제·순서 변경, 세션 이름·잠금 변경, 세션 삭제, 멤버 해제가 바로 밀려온다.
 *
 * 폴링은 없애지 않고 **보조**로 남긴다(`SessionPage`) — WebSocket 이 막힌 환경이나
 * 끊긴 구간을 메운다.
 */
import { useEffect, useRef, useState } from "react";
import type { Page, Session } from "../api";

/** 재접속 백오프: 0.5초에서 시작해 최대 15초까지 (다른 채널과 같은 값) */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export interface SessionEventHandlers {
  onPageCreated(page: Page): void;
  onPageUpdated(page: Page): void;
  onPageDeleted(pageId: string): void;
  onPagesReordered(pages: Page[]): void;
  onSessionUpdated(session: Session): void;
  onSessionDeleted(): void;
  /** 어떤 멤버가 세션에서 빠졌다 (나 자신인지는 호출하는 쪽에서 판단한다) */
  onMemberRemoved(userId: string): void;
  /** (재)접속 완료 — 끊겨 있던 동안 놓친 변경을 회수하려면 여기서 다시 읽는다. */
  onResubscribed(): void;
}

interface ServerEvent {
  type: string;
  payload: Record<string, unknown>;
}

const asPage = (value: unknown): Page | null => {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<Page>;
  if (typeof page.id !== "string" || typeof page.name !== "string") return null;
  if (page.type !== "canvas" && page.type !== "sheet") return null;
  return page as Page;
};

const asPages = (value: unknown): Page[] | null => {
  if (!Array.isArray(value)) return null;
  const pages = value.map(asPage);
  return pages.every((p): p is Page => p !== null) ? pages : null;
};

const asSession = (value: unknown): Session | null => {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<Session>;
  if (typeof session.id !== "string" || typeof session.name !== "string") return null;
  if (typeof session.locked !== "boolean") return null;
  return session as Session;
};

/**
 * 세션 이벤트를 구독한다. 핸들러는 매 렌더 바뀌어도 되고(ref 로 들고 다닌다),
 * 소켓은 `sessionId` 가 바뀔 때만 다시 연다.
 */
export function useSessionEvents(
  sessionId: string | undefined,
  handlers: SessionEventHandlers,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    if (!sessionId) return;
    aliveRef.current = true;

    const apply = (event: ServerEvent) => {
      const h = handlersRef.current;
      const payload = event.payload ?? {};
      switch (event.type) {
        case "ready":
          // 끊겨 있던 동안 놓친 변경은 세션을 다시 읽어 회수한다.
          if (retryRef.current > 0) h.onResubscribed();
          retryRef.current = 0;
          setConnected(true);
          break;
        case "page.created": {
          const page = asPage(payload.page);
          if (page) h.onPageCreated(page);
          break;
        }
        case "page.updated": {
          const page = asPage(payload.page);
          if (page) h.onPageUpdated(page);
          break;
        }
        case "page.deleted":
          if (typeof payload.pageId === "string") h.onPageDeleted(payload.pageId);
          break;
        case "pages.reordered": {
          const pages = asPages(payload.pages);
          if (pages) h.onPagesReordered(pages);
          break;
        }
        case "session.updated": {
          const session = asSession(payload.session);
          if (session) h.onSessionUpdated(session);
          break;
        }
        case "session.deleted":
          h.onSessionDeleted();
          break;
        case "member.removed":
          if (typeof payload.userId === "string") h.onMemberRemoved(payload.userId);
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
      // 여러 탭이 동시에 몰리지 않도록 약간의 흔들림을 준다.
      const jitter = Math.random() * 0.3 * delay;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay + jitter);
    };

    const connect = () => {
      if (!aliveRef.current) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${scheme}://${window.location.host}/ws/session/${sessionId}`;
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
        setConnected(false);
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
      setConnected(false);
    };
  }, [sessionId]);

  return { connected };
}

/**
 * 페이지 댓글 상태 + 실시간 구독.
 *
 * - 목록은 항상 해결된 것까지 받아 온다(`includeResolved=1`). "해결 표시" 토글은
 *   서버를 다시 부르지 않고 화면에서만 거른다.
 * - `/ws/comments/:pageId` 이벤트로 로컬 상태를 갱신한다. 내가 만든 변경도 같은
 *   경로로 되돌아오므로, REST 응답과 WS 이벤트 **양쪽 모두** 멱등하게 반영한다.
 * - 연결이 끊기면 지수 백오프로 재접속하고, 다시 붙을 때 목록을 새로 읽어
 *   끊겨 있던 동안의 변경을 회수한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Comment,
  type CommentPatch,
  type CommentReply,
  type NewCommentInput,
} from "../api";

export type CommentsConnection = "idle" | "connecting" | "connected" | "reconnecting";

/** 재접속 백오프: 0.5초에서 시작해 최대 15초까지 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

interface ServerEvent {
  type: string;
  payload: unknown;
}

const upsertComment = (list: Comment[], comment: Comment): Comment[] => {
  const index = list.findIndex((c) => c.id === comment.id);
  if (index < 0) return [...list, comment];
  const next = [...list];
  next[index] = comment;
  return next;
};

const upsertReply = (list: Comment[], reply: CommentReply): Comment[] =>
  list.map((comment) => {
    if (comment.id !== reply.commentId) return comment;
    if (comment.replies.some((r) => r.id === reply.id)) return comment;
    return { ...comment, replies: [...comment.replies, reply] };
  });

export interface CommentActions {
  create(input: NewCommentInput): Promise<Comment>;
  patch(commentId: string, patch: CommentPatch): Promise<Comment>;
  remove(commentId: string): Promise<void>;
  reply(commentId: string, body: string): Promise<CommentReply>;
  removeReply(replyId: string, commentId: string): Promise<void>;
}

export interface UseCommentsResult {
  comments: Comment[];
  unresolvedCount: number;
  loading: boolean;
  error: string | null;
  connection: CommentsConnection;
  actions: CommentActions;
  reload: () => Promise<void>;
}

export function useComments(pageId: string): UseCommentsResult {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<CommentsConnection>("idle");

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const { comments: list } = await api.listComments(pageId, { includeResolved: true });
      if (!aliveRef.current) return;
      setComments(list);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof ApiError ? err.message : "댓글을 불러오지 못했습니다.");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [pageId]);

  // ---- 초기 로딩 + 실시간 구독 -----------------------------------------
  useEffect(() => {
    aliveRef.current = true;
    setComments([]);
    setLoading(true);
    setError(null);
    void load();

    const apply = (event: ServerEvent) => {
      const payload = event.payload as Record<string, unknown>;
      switch (event.type) {
        case "comment.created":
        case "comment.updated":
          setComments((prev) => upsertComment(prev, payload as unknown as Comment));
          break;
        case "comment.deleted":
          setComments((prev) => prev.filter((c) => c.id !== payload.id));
          break;
        case "reply.created":
          setComments((prev) => upsertReply(prev, payload as unknown as CommentReply));
          break;
        case "reply.deleted":
          setComments((prev) =>
            prev.map((comment) =>
              comment.id === payload.commentId
                ? { ...comment, replies: comment.replies.filter((r) => r.id !== payload.id) }
                : comment,
            ),
          );
          break;
        default:
          // 알 수 없는 이벤트(예: "ready")는 무시한다.
          break;
      }
    };

    const connect = () => {
      if (!aliveRef.current) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${scheme}://${window.location.host}/ws/comments/${pageId}`;
      setConnection((prev) => (prev === "idle" ? "connecting" : prev));

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (!aliveRef.current) return;
        // 끊겨 있던 동안 놓친 변경을 목록으로 회수한다.
        if (retryRef.current > 0) void load();
        retryRef.current = 0;
        setConnection("connected");
      };
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
        setConnection("reconnecting");
        scheduleReconnect();
      };
      socket.onerror = () => {
        // onclose 가 이어서 온다 — 여기서는 아무것도 하지 않는다.
      };
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
        socket.onopen = null;
        socket.close();
      }
      setConnection("idle");
    };
  }, [pageId, load]);

  // ---- 동작 -------------------------------------------------------------
  const actions = useMemo<CommentActions>(
    () => ({
      async create(input) {
        const { comment } = await api.createComment(pageId, input);
        setComments((prev) => upsertComment(prev, comment));
        return comment;
      },
      async patch(commentId, patch) {
        const { comment } = await api.updateComment(commentId, patch);
        setComments((prev) => upsertComment(prev, comment));
        return comment;
      },
      async remove(commentId) {
        await api.deleteComment(commentId);
        setComments((prev) => prev.filter((c) => c.id !== commentId));
      },
      async reply(commentId, body) {
        const { reply } = await api.createReply(commentId, body);
        setComments((prev) => upsertReply(prev, reply));
        return reply;
      },
      async removeReply(replyId, commentId) {
        await api.deleteReply(replyId);
        setComments((prev) =>
          prev.map((comment) =>
            comment.id === commentId
              ? { ...comment, replies: comment.replies.filter((r) => r.id !== replyId) }
              : comment,
          ),
        );
      },
    }),
    [pageId],
  );

  const unresolvedCount = useMemo(() => comments.filter((c) => !c.resolved).length, [comments]);

  return { comments, unresolvedCount, loading, error, connection, actions, reload: load };
}

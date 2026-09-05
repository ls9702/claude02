import { useState, type FormEvent } from "react";
import type { Comment } from "../api";
import { colorOf, displayName, formatTime, initialOf } from "./format";

export interface CommentThreadProps {
  comment: Comment;
  currentUserId: string;
  isAdmin: boolean;
  /** 잠긴 세션(읽기 전용) — 답글·삭제는 막고 해결 처리만 남긴다. */
  readOnly: boolean;
  onReply: (body: string) => Promise<void>;
  onToggleResolved: () => Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteReply: (replyId: string) => Promise<void>;
  onClose: () => void;
}

/** 핀 클릭 시 뜨는 스레드 팝오버 (본문·답글·해결·삭제) */
export function CommentThread({
  comment,
  currentUserId,
  isAdmin,
  readOnly,
  onReply,
  onToggleResolved,
  onDelete,
  onDeleteReply,
  onClose,
}: CommentThreadProps) {
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canModify = isAdmin || comment.author?.id === currentUserId;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    const body = replyBody.trim();
    if (!body) return;
    await run(async () => {
      await onReply(body);
      setReplyBody("");
    });
  };

  return (
    <div className="comment-thread" data-testid="comment-thread" data-comment-id={comment.id}>
      <header className="comment-thread-head">
        <span
          className="comment-avatar"
          style={{ background: colorOf(comment.author?.username) }}
          aria-hidden="true"
        >
          {initialOf(comment.author?.username)}
        </span>
        <span className="comment-author">{displayName(comment.author?.username)}</span>
        <time className="comment-time" dateTime={comment.createdAt}>
          {formatTime(comment.createdAt)}
        </time>
        <button type="button" className="button ghost small" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>

      <p className="comment-body" data-testid="comment-body">
        {comment.body}
      </p>

      {comment.replies.length > 0 ? (
        <ul className="comment-replies">
          {comment.replies.map((reply) => (
            <li key={reply.id} data-testid="comment-reply">
              <span className="comment-author">{displayName(reply.author?.username)}</span>
              <time className="comment-time" dateTime={reply.createdAt}>
                {formatTime(reply.createdAt)}
              </time>
              {!readOnly && (isAdmin || reply.author?.id === currentUserId) ? (
                <button
                  type="button"
                  className="button ghost small"
                  data-testid="reply-delete"
                  disabled={busy}
                  onClick={() => void run(() => onDeleteReply(reply.id))}
                >
                  삭제
                </button>
              ) : null}
              <span className="comment-body">{reply.body}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!readOnly ? (
        <form className="comment-reply-form" onSubmit={submitReply}>
          <textarea
            value={replyBody}
            rows={2}
            placeholder="답글 달기…"
            data-testid="reply-input"
            onChange={(event) => setReplyBody(event.target.value)}
          />
          <button
            type="submit"
            className="button primary small"
            data-testid="reply-submit"
            disabled={busy || replyBody.trim().length === 0}
          >
            답글
          </button>
        </form>
      ) : null}

      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="comment-thread-actions">
        <button
          type="button"
          className="button small"
          data-testid="comment-resolve"
          disabled={busy}
          onClick={() => void run(onToggleResolved)}
        >
          {comment.resolved ? "해결 취소" : "해결"}
        </button>
        {canModify && !readOnly ? (
          <button
            type="button"
            className="button ghost small danger"
            data-testid="comment-delete"
            disabled={busy}
            onClick={() => void run(onDelete)}
          >
            삭제
          </button>
        ) : null}
      </footer>
    </div>
  );
}

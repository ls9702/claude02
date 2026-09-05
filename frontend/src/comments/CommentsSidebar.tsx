import type { Comment } from "../api";
import { colorOf, displayName, formatTime, initialOf, previewOf } from "./format";

export interface CommentsSidebarProps {
  comments: Comment[];
  showResolved: boolean;
  loading: boolean;
  error: string | null;
  onToggleResolved: (next: boolean) => void;
  /** 목록에서 고르면 그 위치로 캔버스를 옮기고 스레드를 연다. */
  onSelect: (comment: Comment) => void;
  onClose: () => void;
}

/**
 * 댓글 목록 패널.
 *
 * Excalidraw 의 `Sidebar` 컴포넌트 대신 자체 패널을 쓴다 —
 * 오버레이·핀과 같은 레이어 안에서 위치와 z-index 를 우리가 통제해야 하기 때문이다.
 */
export function CommentsSidebar({
  comments,
  showResolved,
  loading,
  error,
  onToggleResolved,
  onSelect,
  onClose,
}: CommentsSidebarProps) {
  const visible = showResolved ? comments : comments.filter((c) => !c.resolved);

  return (
    <aside className="comments-sidebar" data-testid="comments-sidebar" aria-label="댓글 목록">
      <header className="comments-sidebar-head">
        <h2>댓글</h2>
        <label className="comments-sidebar-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            data-testid="comments-show-resolved"
            onChange={(event) => onToggleResolved(event.target.checked)}
          />
          해결 포함
        </label>
        <button type="button" className="button ghost small" onClick={onClose} aria-label="댓글 목록 닫기">
          ✕
        </button>
      </header>

      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? <p className="muted small">불러오는 중…</p> : null}

      {!loading && visible.length === 0 ? (
        <p className="muted small" data-testid="comments-empty">
          {showResolved ? "댓글이 없습니다." : "미해결 댓글이 없습니다."}
        </p>
      ) : null}

      <ul className="comments-list">
        {visible.map((comment) => (
          <li key={comment.id}>
            <button
              type="button"
              className="comments-list-item"
              data-testid="comments-list-item"
              data-comment-id={comment.id}
              data-resolved={comment.resolved ? "1" : "0"}
              onClick={() => onSelect(comment)}
            >
              <span
                className="comment-avatar small"
                style={{ background: comment.resolved ? "#9aa3b0" : colorOf(comment.author?.username) }}
                aria-hidden="true"
              >
                {initialOf(comment.author?.username)}
              </span>
              <span className="comments-list-text">
                <span className="comments-list-meta">
                  {displayName(comment.author?.username)} · {formatTime(comment.createdAt)}
                  {comment.resolved ? " · 해결됨" : ""}
                  {comment.replies.length > 0 ? ` · 답글 ${comment.replies.length}` : ""}
                </span>
                <span className="comments-list-body">{previewOf(comment.body)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

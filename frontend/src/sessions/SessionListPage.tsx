import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, type SessionSummary } from "../api";
import { Spinner } from "../components/Spinner";
import { UserMenu } from "../components/UserMenu";
import type { SessionListNoticeState } from "./SessionPage";

export function SessionListPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * 세션이 삭제되거나 멤버에서 빠져 세션 화면이 여기로 돌려보냈다면 그 이유를 띄운다.
   * 한 번만 보여 주면 되므로 초기값으로만 읽고, 히스토리 state 는 곧바로 지운다.
   */
  const [notice, setNotice] = useState<string | null>(
    () => (location.state as SessionListNoticeState | null)?.notice ?? null,
  );
  useEffect(() => {
    if ((location.state as SessionListNoticeState | null)?.notice) {
      navigate(location.pathname, { replace: true, state: null });
    }
    // 최초 마운트에서만 정리한다 (notice 는 이미 위에서 읽었다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listSessions()
      .then(({ sessions: list }) => {
        if (!cancelled) setSessions(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "세션을 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (session: SessionSummary) => {
    const first = session.pages[0];
    navigate(first ? `/s/${session.id}/p/${first.id}` : `/s/${session.id}`);
  };

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="topbar-title">내 세션</h1>
        <div className="spacer" />
        <UserMenu />
      </header>

      <main className="content">
        {notice ? (
          <div className="session-notice" data-testid="session-list-notice" role="status">
            <span>{notice}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="안내 닫기"
              onClick={() => setNotice(null)}
            >
              ✕
            </button>
          </div>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {sessions === null && !error ? <Spinner /> : null}
        {sessions !== null && sessions.length === 0 ? (
          <p className="muted" data-testid="empty-sessions">
            할당된 세션이 없습니다. 관리자에게 문의해 주세요.
          </p>
        ) : null}

        <ul className="session-grid">
          {(sessions ?? []).map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="session-card"
                data-testid="session-card"
                data-session-id={session.id}
                onClick={() => open(session)}
              >
                <span className="session-card-title">
                  {session.locked ? <span title="잠김">🔒 </span> : null}
                  {session.name}
                </span>
                <span className="session-card-meta">
                  페이지 {session.pages.length}개
                  {session.unresolvedComments > 0 ? (
                    <span className="badge" data-testid="unresolved-badge" title="미해결 댓글">
                      {session.unresolvedComments}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="muted small">
          세션이 보이지 않는다면 관리자에게 할당을 요청하세요. <Link to="/password">비밀번호 변경</Link>
        </p>
      </main>
    </div>
  );
}

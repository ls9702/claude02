import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Page, type PageType, type Session, type SheetTemplate } from "../api";
import { CanvasPage } from "../canvas/CanvasPage";
import { collabBadge, type CollabConnection } from "../collab/status";
import { ErrorNotice } from "../components/ErrorNotice";
import { Spinner } from "../components/Spinner";
import { UserMenu } from "../components/UserMenu";
import { SheetPage } from "../sheet/SheetPage";
import { useAuth } from "../auth/AuthContext";
import { NewPageDialog } from "./NewPageDialog";
import { PageTabs } from "./PageTabs";

interface LoadState {
  session: Session;
  pages: Page[];
}

export function SessionPage() {
  const { sessionId, pageId } = useParams<{ sessionId: string; pageId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<LoadState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showNewPage, setShowNewPage] = useState(false);
  /** 현재 캔버스 페이지(룸)의 접속자 수·연결 상태 */
  const [collab, setCollab] = useState<{
    collaboratorCount: number;
    connection: CollabConnection;
  }>({ collaboratorCount: 0, connection: "idle" });
  /** 현재 페이지의 미해결 댓글 수 (상단 바 배지) */
  const [unresolvedComments, setUnresolvedComments] = useState(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getSession(sessionId);
      setState({ session: data.session, pages: data.pages });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "unknown", "세션을 불러오지 못했습니다."));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 지금 화면이 알고 있는 잠금 상태 (아직 세션을 못 읽었으면 null) */
  const lockedRef = useRef<boolean | null>(null);
  lockedRef.current = state ? state.session.locked : null;

  /**
   * 캔버스가 룸 재검증으로 알아낸 잠금 상태가 지금 보고 있는 세션 정보와 다르면
   * 세션을 다시 읽는다 — 읽기 전용 UI(뷰 모드·페이지 편집 버튼)가 여기에 달려 있다.
   */
  const onRoomLockedChange = useCallback(
    (locked: boolean) => {
      if (lockedRef.current !== null && lockedRef.current !== locked) void load();
    },
    [load],
  );

  if (!sessionId) return <Navigate to="/" replace />;

  if (error) {
    if (error.status === 403) {
      return <ErrorNotice title="접근 권한이 없습니다" message="이 세션에 접근할 권한이 없습니다." />;
    }
    if (error.status === 404) {
      return <ErrorNotice title="세션을 찾을 수 없습니다" message="삭제되었거나 잘못된 주소입니다." />;
    }
    if (error.status === 401) return <Navigate to="/login" replace />;
    return <ErrorNotice title="오류" message={error.message} />;
  }

  if (!state) return <Spinner label="세션을 여는 중…" />;

  const { session, pages } = state;
  const readOnly = session.locked && user?.role !== "admin";

  // /s/:sessionId 로 들어오면 첫 페이지로 보낸다.
  if (!pageId) {
    const first = pages[0];
    if (first) return <Navigate to={`/s/${session.id}/p/${first.id}`} replace />;
  }

  const activePage = pageId ? pages.find((p) => p.id === pageId) : undefined;
  const badge = collabBadge(collab);

  const createPage = async (name: string, type: PageType, template: SheetTemplate) => {
    const { page } = await api.createPage(session.id, name, type, template);
    setState({ session, pages: [...pages, page] });
    setShowNewPage(false);
    navigate(`/s/${session.id}/p/${page.id}`);
  };

  const renamePage = async (id: string, name: string) => {
    const { page } = await api.renamePage(id, name);
    setState({ session, pages: pages.map((p) => (p.id === id ? page : p)) });
  };

  const deletePage = async (id: string) => {
    const target = pages.find((p) => p.id === id);
    if (!target) return;
    if (!window.confirm(`'${target.name}' 페이지를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api.deletePage(id);
    const remaining = pages.filter((p) => p.id !== id);
    setState({ session, pages: remaining });
    if (id === pageId) {
      const next = remaining[0];
      navigate(next ? `/s/${session.id}/p/${next.id}` : `/s/${session.id}`, { replace: true });
    }
  };

  const reorder = async (ids: string[]) => {
    const optimistic = ids
      .map((id) => pages.find((p) => p.id === id))
      .filter((p): p is Page => Boolean(p));
    setState({ session, pages: optimistic });
    const { pages: saved } = await api.reorderPages(session.id, ids);
    setState({ session, pages: saved });
  };

  const movePage = async (id: string, direction: -1 | 1) => {
    const ids = pages.map((p) => p.id);
    const from = ids.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    await reorder(ids);
  };

  return (
    <div className="page session-page">
      <header className="topbar">
        <Link className="button ghost" to="/" title="세션 목록">
          ←
        </Link>
        <h1 className="topbar-title" data-testid="session-name">
          {session.locked ? <span title="잠긴 세션 (읽기 전용)">🔒 </span> : null}
          {session.name}
        </h1>

        <PageTabs
          pages={pages}
          activePageId={activePage?.id}
          readOnly={readOnly}
          onSelect={(id) => navigate(`/s/${session.id}/p/${id}`)}
          onRename={renamePage}
          onDelete={deletePage}
          onMove={movePage}
          onReorder={reorder}
        />

        {!readOnly ? (
          <button
            type="button"
            className="button"
            data-testid="add-page-button"
            onClick={() => setShowNewPage(true)}
          >
            + 페이지
          </button>
        ) : null}

        <div className="spacer" />
        {unresolvedComments > 0 && activePage?.type === "canvas" ? (
          <span className="pill" data-testid="comment-count" title="이 페이지의 미해결 댓글">
            💬 {unresolvedComments}
          </span>
        ) : null}
        {badge ? (
          <span className="pill" data-testid={badge.testId} title={badge.title}>
            {badge.text}
          </span>
        ) : null}
        {readOnly ? <span className="pill" data-testid="readonly-pill">읽기 전용</span> : null}
        <UserMenu />
      </header>

      <main className="session-body">
        {activePage === undefined ? (
          <div className="centered-page">
            <p className="muted" data-testid="no-pages">
              아직 페이지가 없습니다. 「+ 페이지」로 첫 페이지를 만들어 보세요.
            </p>
          </div>
        ) : activePage.type === "canvas" ? (
          <CanvasPage
            key={activePage.id}
            page={activePage}
            readOnly={readOnly}
            username={user?.username ?? "익명"}
            userId={user?.id ?? ""}
            isAdmin={user?.role === "admin"}
            onCollabState={setCollab}
            onRoomLockedChange={onRoomLockedChange}
            onUnresolvedComments={setUnresolvedComments}
          />
        ) : (
          <SheetPage
            key={activePage.id}
            page={activePage}
            readOnly={readOnly}
            username={user?.username ?? "익명"}
            onCollabState={setCollab}
          />
        )}
      </main>

      {showNewPage ? (
        <NewPageDialog onCancel={() => setShowNewPage(false)} onCreate={createPage} />
      ) : null}
    </div>
  );
}

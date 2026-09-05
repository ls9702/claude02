import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Page, type PageType, type Session, type SheetTemplate } from "../api";
import { CanvasPage } from "../canvas/CanvasPage";
import { ROOM_RECHECK_MS } from "../collab/constants";
import { collabBadge, type CollabConnection } from "../collab/status";
import { ErrorNotice } from "../components/ErrorNotice";
import { Spinner } from "../components/Spinner";
import { UserMenu } from "../components/UserMenu";
import { SheetPage } from "../sheet/SheetPage";
import { useAuth } from "../auth/AuthContext";
import { NewPageDialog } from "./NewPageDialog";
import { PageTabs } from "./PageTabs";
import { useSessionEvents } from "./useSessionEvents";

interface LoadState {
  session: Session;
  pages: Page[];
}

/** 세션 목록으로 되돌아갈 때 함께 넘기는 안내 문구 (SessionListPage 가 띄운다) */
export interface SessionListNoticeState {
  notice?: string;
}

const PAGE_DELETED_NOTICE = "이 페이지가 삭제되었습니다.";
const SESSION_DELETED_NOTICE = "이 세션이 삭제되었습니다.";
const MEMBER_REMOVED_NOTICE = "이 세션에 대한 접근 권한이 해제되었습니다.";

export function SessionPage() {
  const { sessionId, pageId } = useParams<{ sessionId: string; pageId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<LoadState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showNewPage, setShowNewPage] = useState(false);
  /** 페이지가 삭제되는 등 화면이 저절로 바뀐 이유를 알리는 배너 */
  const [notice, setNotice] = useState<string | null>(null);
  /** 현재 캔버스 페이지(룸)의 접속자 수·연결 상태 */
  const [collab, setCollab] = useState<{
    collaboratorCount: number;
    connection: CollabConnection;
  }>({ collaboratorCount: 0, connection: "idle" });
  /** 현재 페이지의 미해결 댓글 수 (상단 바 배지) */
  const [unresolvedComments, setUnresolvedComments] = useState(0);

  /** 이벤트 핸들러가 최신 값을 보게 하는 거울 (핸들러는 소켓을 다시 열지 않는다) */
  const stateRef = useRef<LoadState | null>(null);
  stateRef.current = state;
  const pageIdRef = useRef<string | undefined>(pageId);
  pageIdRef.current = pageId;
  const userIdRef = useRef<string | undefined>(user?.id);
  userIdRef.current = user?.id;

  /** 안내와 함께 세션 목록으로 돌아간다 (세션 삭제·멤버 해제). */
  const leaveToSessionList = useCallback(
    (message: string) => {
      const listState: SessionListNoticeState = { notice: message };
      navigate("/", { replace: true, state: listState });
    },
    [navigate],
  );

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

  /**
   * 안내가 "어느 페이지에서 보여야 하는지" 를 기억한다.
   * 페이지 삭제 안내는 **옮겨 간 다음 페이지에서** 보여야 하므로, 이동 목적지를 여기 적어 둔다.
   * 사용자가 스스로 다른 탭으로 옮기면 안내는 사라진다.
   */
  const noticePageRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (noticePageRef.current !== undefined && (pageId ?? null) === noticePageRef.current) return;
    noticePageRef.current = undefined;
    setNotice(null);
  }, [pageId]);

  /** 안내를 띄우고, 그 안내가 살아 있어야 할 페이지를 기록한다. */
  const showNotice = useCallback((message: string, forPageId: string | null) => {
    noticePageRef.current = forPageId;
    setNotice(message);
  }, []);

  /**
   * 보조 폴링.
   *
   * 실시간 채널(`/ws/session/:id`)이 주 경로지만, WebSocket 이 막힌 환경이나 이벤트를
   * 놓친 구간을 메우기 위해 `ROOM_RECHECK_MS`(기본 30초, E2E 2초) 주기로 세션을 다시 읽는다.
   * 여기서도 "보고 있던 페이지가 사라졌다 / 세션이 사라졌다" 를 같은 방식으로 처리한다.
   */
  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const data = await api.getSession(sessionId);
          setState({ session: data.session, pages: data.pages });
          setError(null);
          const current = pageIdRef.current;
          if (current && !data.pages.some((p) => p.id === current)) {
            const next = data.pages[0];
            showNotice(PAGE_DELETED_NOTICE, next?.id ?? null);
            navigate(next ? `/s/${sessionId}/p/${next.id}` : `/s/${sessionId}`, { replace: true });
          }
        } catch (err) {
          if (!(err instanceof ApiError)) return;
          // 이미 세션을 한 번 읽은 뒤라면 삭제·권한 해제로 본다 (첫 로딩 실패는 위 load 가 다룬다).
          if (err.status === 404 && stateRef.current) leaveToSessionList(SESSION_DELETED_NOTICE);
          else if (err.status === 403 && stateRef.current) leaveToSessionList(MEMBER_REMOVED_NOTICE);
        }
      })();
    }, ROOM_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, navigate, leaveToSessionList, showNotice]);

  /** 현재 페이지가 사라졌을 때: 안내 후 남은 첫 페이지(없으면 세션 목록)로 옮긴다. */
  const handlePageDeleted = useCallback(
    (deletedId: string) => {
      const current = stateRef.current;
      const remaining = current ? current.pages.filter((p) => p.id !== deletedId) : [];
      setState((prev) => (prev ? { ...prev, pages: prev.pages.filter((p) => p.id !== deletedId) } : prev));
      if (deletedId !== pageIdRef.current || !sessionId) return;
      const next = remaining[0];
      showNotice(PAGE_DELETED_NOTICE, next?.id ?? null);
      navigate(next ? `/s/${sessionId}/p/${next.id}` : `/s/${sessionId}`, { replace: true });
    },
    [navigate, sessionId, showNotice],
  );

  // 실시간 세션 이벤트 — 탭 목록·잠금·삭제를 즉시 반영한다.
  useSessionEvents(sessionId, {
    onPageCreated: (page) =>
      setState((prev) =>
        prev && !prev.pages.some((p) => p.id === page.id)
          ? { ...prev, pages: [...prev.pages, page].sort((a, b) => a.position - b.position) }
          : prev,
      ),
    onPageUpdated: (page) =>
      setState((prev) =>
        prev ? { ...prev, pages: prev.pages.map((p) => (p.id === page.id ? page : p)) } : prev,
      ),
    onPageDeleted: handlePageDeleted,
    onPagesReordered: (pages) => setState((prev) => (prev ? { ...prev, pages } : prev)),
    onSessionUpdated: (session) => setState((prev) => (prev ? { ...prev, session } : prev)),
    onSessionDeleted: () => leaveToSessionList(SESSION_DELETED_NOTICE),
    onMemberRemoved: (userId) => {
      if (userId === userIdRef.current) leaveToSessionList(MEMBER_REMOVED_NOTICE);
    },
    onResubscribed: () => void load(),
  });

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

  const badge = useMemo(() => collabBadge(collab), [collab]);

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

  const createPage = async (name: string, type: PageType, template: SheetTemplate) => {
    const { page } = await api.createPage(session.id, name, type, template);
    setState((prev) =>
      prev && !prev.pages.some((p) => p.id === page.id)
        ? { ...prev, pages: [...prev.pages, page] }
        : prev,
    );
    setShowNewPage(false);
    navigate(`/s/${session.id}/p/${page.id}`);
  };

  const renamePage = async (id: string, name: string) => {
    const { page } = await api.renamePage(id, name);
    setState((prev) =>
      prev ? { ...prev, pages: prev.pages.map((p) => (p.id === id ? page : p)) } : prev,
    );
  };

  const deletePage = async (id: string) => {
    const target = pages.find((p) => p.id === id);
    if (!target) return;
    if (!window.confirm(`'${target.name}' 페이지를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api.deletePage(id);
    const remaining = pages.filter((p) => p.id !== id);
    setState((prev) => (prev ? { ...prev, pages: prev.pages.filter((p) => p.id !== id) } : prev));
    if (id === pageId) {
      const next = remaining[0];
      navigate(next ? `/s/${session.id}/p/${next.id}` : `/s/${session.id}`, { replace: true });
    }
  };

  const reorder = async (ids: string[]) => {
    const optimistic = ids
      .map((id) => pages.find((p) => p.id === id))
      .filter((p): p is Page => Boolean(p));
    setState((prev) => (prev ? { ...prev, pages: optimistic } : prev));
    const { pages: saved } = await api.reorderPages(session.id, ids);
    setState((prev) => (prev ? { ...prev, pages: saved } : prev));
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

      {notice ? (
        <div className="session-notice" data-testid="session-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="안내 닫기"
            data-testid="session-notice-dismiss"
            onClick={() => setNotice(null)}
          >
            ✕
          </button>
        </div>
      ) : null}

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

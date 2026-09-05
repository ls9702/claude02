import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  getSceneVersion,
  newElementWith,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  Gesture,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { AiAskSheet } from "../ai/AiAskSheet";
import { useAiEnabled } from "../ai/aiSettings";
import { api, ApiError, type Page } from "../api";
import { Collab, type CollabPublicState, type SaveStatus } from "../collab/Collab";
import { collabNotice } from "../collab/status";
import { CommentsLayer, type CommentsLayerHandle } from "../comments/CommentsLayer";
import type { SocketUpdateDataSource } from "../collab/types";
import { Spinner } from "../components/Spinner";

/** 썸네일 업로드 최소 간격 */
const THUMBNAIL_INTERVAL_MS = 30_000;
/** 썸네일 가로 폭 */
const THUMBNAIL_WIDTH = 320;

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "",
  saving: "저장 중…",
  saved: "저장됨",
  error: "저장 실패",
};

/** 개발 모드 또는 E2E 실행일 때만 테스트 훅을 노출한다. */
const EXPOSE_TEST_HOOKS = import.meta.env.DEV || import.meta.env.VITE_E2E === "1";

const INITIAL_COLLAB_STATE: CollabPublicState = {
  saveStatus: "idle",
  collaboratorCount: 0,
  isCollaborating: false,
  errorMessage: null,
  connection: "idle",
};

export interface CanvasPageProps {
  page: Page;
  readOnly: boolean;
  username: string;
  /** 댓글 권한 판단용 (본인 글 수정·삭제, 관리자) */
  userId: string;
  isAdmin: boolean;
  /** 상단 탭 바에 "접속 N명"·"재연결 중…" 을 그리기 위해 세션 화면으로 올려 준다. */
  onCollabState?: (state: Pick<CollabPublicState, "collaboratorCount" | "connection">) => void;
  /** 서버가 알려 준 세션 잠금 상태가 바뀌었을 때 (세션 정보를 다시 읽는다). */
  onRoomLockedChange?: (locked: boolean) => void;
  /** 상단 바 미해결 댓글 배지 */
  onUnresolvedComments?: (count: number) => void;
}

export function CanvasPage({
  page,
  readOnly,
  username,
  userId,
  isAdmin,
  onCollabState,
  onRoomLockedChange,
  onUnresolvedComments,
}: CanvasPageProps) {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collabState, setCollabState] = useState<CollabPublicState>(INITIAL_COLLAB_STATE);
  const [aiOpen, setAiOpen] = useState(false);
  // ✨ 는 세 조건(사용자 토글 · 서버 키 · 계정 허용)이 모두 참일 때만 나온다 (PLAN §2.6).
  const aiEnabled = useAiEnabled();

  const collabRef = useRef<Collab | null>(null);
  const commentsRef = useRef<CommentsLayerHandle | null>(null);
  const lastThumbnailAt = useRef(0);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // ---- 초기 로딩 -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setInitialData(null);
    setLoadError(null);
    setCollabState(INITIAL_COLLAB_STATE);

    api
      .getScene(page.id)
      .then((scene) => {
        if (cancelled) return;
        setInitialData({
          elements: scene.elements as ExcalidrawInitialDataState["elements"],
          appState: {
            ...scene.appState,
            collaborators: new Map(),
          } as ExcalidrawInitialDataState["appState"],
          scrollToContent: true,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "캔버스를 불러오지 못했습니다.");
      });

    return () => {
      cancelled = true;
    };
  }, [page.id]);

  useEffect(() => {
    setAiOpen(false);
  }, [page.id]);

  useEffect(() => {
    if (!aiEnabled) setAiOpen(false);
  }, [aiEnabled]);

  // ---- 썸네일 -----------------------------------------------------------
  const maybeUploadThumbnail = useCallback(async () => {
    const instance = excalidrawAPI;
    if (!instance || readOnlyRef.current) return;
    // 빈 씬은 썸네일을 만들 수 없다 — 간격 제한 슬롯도 쓰지 않는다.
    // (페이지를 열자마자 일어나는 첫 저장이 슬롯을 삼켜 버리면 실제 그림의 썸네일이 30초 동안 올라가지 못한다.)
    const elements = instance.getSceneElements();
    if (elements.length === 0) return;
    const now = Date.now();
    if (now - lastThumbnailAt.current < THUMBNAIL_INTERVAL_MS) return;
    lastThumbnailAt.current = now;
    try {
      const blob = await exportToBlob({
        elements,
        files: instance.getFiles(),
        appState: { ...instance.getAppState(), exportBackground: true },
        mimeType: "image/png",
        maxWidthOrHeight: THUMBNAIL_WIDTH,
      });
      if (blob.size > 200 * 1024) return;
      await api.putThumbnail(page.id, blob);
    } catch {
      // 썸네일은 부가 기능이므로 실패해도 무시한다.
    }
  }, [excalidrawAPI, page.id]);

  // ---- Excalidraw → Collab 연결 ----------------------------------------
  const onChange = useCallback((elements: readonly OrderedExcalidrawElement[]) => {
    // 댓글 핀은 줌·스크롤·요소 이동을 모두 여기서 알게 된다 (내부에서 rAF 로 스로틀).
    commentsRef.current?.onSceneChange();
    const collab = collabRef.current;
    if (!collab) return;
    // 큰 이미지는 업로드 전에 줄이고 씬의 fileId 를 교체한다.
    collab.normalizeImages();
    collab.syncElements(elements);
  }, []);

  const onPointerUpdate = useCallback(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      collabRef.current?.onPointerUpdate(payload);
    },
    [],
  );

  useEffect(() => {
    onCollabState?.({
      collaboratorCount: collabState.collaboratorCount,
      connection: collabState.connection,
    });
  }, [collabState.collaboratorCount, collabState.connection, onCollabState]);

  useEffect(
    () => () => onCollabState?.({ collaboratorCount: 0, connection: "idle" }),
    [onCollabState],
  );

  // ---- E2E 훅 -----------------------------------------------------------
  useEffect(() => {
    if (!EXPOSE_TEST_HOOKS) return;
    window.__excalidrawAPI = excalidrawAPI ?? undefined;
    window.__excalidrawLib = {
      convertToExcalidrawElements,
      getSceneVersion,
      CaptureUpdateAction,
      newElementWith,
    };
    window.__flushScene = async () => {
      collabRef.current?.flushSave({ keepalive: false });
    };
    window.__closeCollabTransport = () => {
      collabRef.current?.closeTransportForTest();
    };
    return () => {
      if (window.__excalidrawAPI === excalidrawAPI) window.__excalidrawAPI = undefined;
    };
  }, [excalidrawAPI]);

  useEffect(() => {
    if (!EXPOSE_TEST_HOOKS) return;
    window.__saveStatus = collabState.saveStatus;
    window.__collaboratorCount = collabState.collaboratorCount;
    window.__collabConnection = collabState.connection;
  }, [collabState.saveStatus, collabState.collaboratorCount, collabState.connection]);

  if (loadError && !initialData) {
    return (
      <div className="centered-page">
        <p className="error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!initialData) return <Spinner label="캔버스를 여는 중…" />;

  const notice = collabNotice(collabState.connection);

  return (
    <div className="canvas-wrapper" data-testid="canvas-wrapper">
      <div className="canvas-status">
        <div
          className="save-status"
          data-testid="save-status"
          data-status={collabState.saveStatus}
          aria-live="polite"
        >
          {STATUS_LABEL[collabState.saveStatus]}
        </div>
        {collabState.errorMessage ? (
          <div className="collab-error" data-testid="collab-error" role="alert">
            {collabState.errorMessage}
          </div>
        ) : null}
        {notice ? (
          <div className="collab-notice" data-testid="collab-notice" role="status">
            {notice}
          </div>
        ) : null}
      </div>
      <Excalidraw
        excalidrawAPI={(instance) => {
          setExcalidrawAPI(instance);
        }}
        initialData={initialData}
        langCode="ko-KR"
        viewModeEnabled={readOnly}
        isCollaborating={collabState.isCollaborating}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />
      {aiEnabled && excalidrawAPI ? (
        <div className="ai-toolbar">
          <button
            type="button"
            className={`button small${aiOpen ? " primary" : ""}`}
            data-testid="ai-open"
            aria-pressed={aiOpen}
            title="AI에게 묻고 답을 카드로 붙입니다"
            onClick={() => setAiOpen((prev) => !prev)}
          >
            ✨ AI
          </button>
        </div>
      ) : null}
      {aiEnabled && aiOpen && excalidrawAPI ? (
        <AiAskSheet
          pageId={page.id}
          excalidrawAPI={excalidrawAPI}
          username={username}
          readOnly={readOnly}
          onClose={() => setAiOpen(false)}
        />
      ) : null}
      {excalidrawAPI ? (
        <CommentsLayer
          ref={commentsRef}
          pageId={page.id}
          excalidrawAPI={excalidrawAPI}
          currentUserId={userId}
          isAdmin={isAdmin}
          readOnly={readOnly}
          onUnresolvedChange={onUnresolvedComments}
        />
      ) : null}
      {excalidrawAPI ? (
        <Collab
          ref={(instance) => {
            collabRef.current = instance;
          }}
          excalidrawAPI={excalidrawAPI}
          pageId={page.id}
          username={username}
          readOnly={readOnly}
          onStateChange={setCollabState}
          onSaved={maybeUploadThumbnail}
          onRoomLockedChange={onRoomLockedChange}
        />
      ) : null}
    </div>
  );
}

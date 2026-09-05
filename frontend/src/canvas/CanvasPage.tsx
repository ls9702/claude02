import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  getSceneVersion,
  newElementWith,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Page } from "../api";
import { Spinner } from "../components/Spinner";
import { MAX_IMAGE_DIMENSION, dataUrlToBlob, resizeDataUrlIfNeeded } from "../utils/image";
import { pickSharedAppState, sharedAppStateEquals, type SharedAppState } from "./appState";

/** 저장 디바운스 */
const SAVE_DEBOUNCE_MS = 1500;
/** 썸네일 업로드 최소 간격 */
const THUMBNAIL_INTERVAL_MS = 30_000;
/** 썸네일 가로 폭 */
const THUMBNAIL_WIDTH = 320;

type SaveStatus = "idle" | "saving" | "saved" | "error";

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "",
  saving: "저장 중…",
  saved: "저장됨",
  error: "저장 실패",
};

/** 개발 모드 또는 E2E 실행일 때만 테스트 훅을 노출한다. */
const EXPOSE_TEST_HOOKS = import.meta.env.DEV || import.meta.env.VITE_E2E === "1";

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });

/** 이미지 요소가 가리키는 fileId 를 바꾼다 (리사이즈본으로 교체할 때 사용). */
function replaceFileIdInScene(
  instance: ExcalidrawImperativeAPI,
  fromId: string,
  toId: string,
): void {
  const elements = instance.getSceneElementsIncludingDeleted();
  let changed = false;
  const next = elements.map((element) => {
    const el = element as unknown as { type?: string; fileId?: string | null };
    if (el.type !== "image" || el.fileId !== fromId) return element;
    changed = true;
    return newElementWith(element as never, { fileId: toId } as never);
  });
  if (!changed) return;
  instance.updateScene({ elements: next as never });
}

export function CanvasPage({ page, readOnly }: { page: Page; readOnly: boolean }) {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");

  /** 마지막으로 서버에 반영된 씬 버전 (getSceneVersion) */
  const savedSceneVersion = useRef<number>(-1);
  /** 마지막으로 서버에 반영된 공유 appState (배경색·그리드 등). null 이면 아직 기준선 없음 */
  const savedAppState = useRef<SharedAppState | null>(null);
  /** 서버에서 받아 화면에 반영한 공유 appState (같은 값을 반복 적용하지 않기 위한 기록) */
  const appliedServerAppState = useRef<SharedAppState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  /** 서버에 이미 있는 fileId */
  const uploadedFiles = useRef<Set<string>>(new Set());
  /** 업로드 진행 중인 fileId */
  const uploadingFiles = useRef<Set<string>>(new Set());
  const lastThumbnailAt = useRef(0);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // ---- 초기 로딩 -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setInitialData(null);
    setLoadError(null);
    savedSceneVersion.current = -1;
    savedAppState.current = null;
    appliedServerAppState.current = null;
    uploadedFiles.current = new Set();

    api
      .getScene(page.id)
      .then((scene) => {
        if (cancelled) return;
        setInitialData({
          elements: scene.elements as ExcalidrawInitialDataState["elements"],
          appState: { ...scene.appState, collaborators: new Map() } as ExcalidrawInitialDataState["appState"],
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

  // ---- 저장된 이미지 파일 복원 -----------------------------------------
  useEffect(() => {
    if (!excalidrawAPI || !initialData) return;
    let cancelled = false;

    const elements = (initialData.elements ?? []) as unknown as ReadonlyArray<{
      type?: string;
      fileId?: string | null;
    }>;
    const ids = new Set<string>();
    for (const el of elements) {
      if (el && el.type === "image" && typeof el.fileId === "string" && el.fileId) ids.add(el.fileId);
    }
    if (ids.size === 0) return;

    void (async () => {
      const loaded: BinaryFileData[] = [];
      for (const id of ids) {
        try {
          const response = await fetch(`/files/${encodeURIComponent(id)}`, { credentials: "same-origin" });
          if (!response.ok) continue;
          const blob = await response.blob();
          const dataURL = await blobToDataUrl(blob);
          uploadedFiles.current.add(id);
          loaded.push({
            id,
            dataURL,
            mimeType: blob.type || "image/png",
            created: Date.now(),
          } as unknown as BinaryFileData);
        } catch {
          // 개별 파일 실패는 무시하고 나머지를 계속 불러온다.
        }
      }
      if (!cancelled && loaded.length > 0) excalidrawAPI.addFiles(loaded);
    })();

    return () => {
      cancelled = true;
    };
  }, [excalidrawAPI, initialData]);

  // ---- 저장 -------------------------------------------------------------
  const flush = useCallback(
    async (opts: { keepalive?: boolean } = {}) => {
      const instance = apiRef.current;
      if (!instance || readOnlyRef.current) return;
      if (savingRef.current) {
        pendingRef.current = true;
        return;
      }
      const elements = instance.getSceneElementsIncludingDeleted();
      const localVersion = getSceneVersion(elements);
      const appState = instance.getAppState() as unknown as Record<string, unknown>;
      const localShared = pickSharedAppState(appState);
      // 요소가 그대로여도 공유 appState(배경색·그리드 등)가 바뀌었으면 저장해야 한다.
      const appStateDirty =
        savedAppState.current === null || !sharedAppStateEquals(localShared, savedAppState.current);
      if (localVersion === savedSceneVersion.current && !appStateDirty) return;

      savingRef.current = true;
      setStatus("saving");
      try {
        const result = await api.saveScene(page.id, elements, appState, opts);
        savedSceneVersion.current = localVersion;
        savedAppState.current = localShared;

        // 서버가 병합해 돌려준 appState 가 로컬과 다르면(다른 사용자가 바꿈) 화면에 반영한다.
        // 같은 값은 한 번만 적용한다 — 로컬이 그 값을 받아들이지 않을 때 저장 루프가 생기지 않게.
        const serverShared = pickSharedAppState(result.appState);
        const alreadyApplied =
          appliedServerAppState.current !== null &&
          sharedAppStateEquals(serverShared, appliedServerAppState.current);
        if (!sharedAppStateEquals(serverShared, localShared) && !alreadyApplied) {
          appliedServerAppState.current = serverShared;
          instance.updateScene({
            appState: serverShared as never,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }

        if (result.changed) {
          // 다른 사용자의 변경이 병합되어 돌아왔다 → 화면에 반영한다.
          instance.updateScene({
            elements: result.elements as never,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          savedSceneVersion.current = getSceneVersion(instance.getSceneElementsIncludingDeleted());
        }
        setStatus("saved");
        void maybeUploadThumbnail(instance);
      } catch (err) {
        setStatus("error");
        if (err instanceof ApiError && err.status === 403) {
          setLoadError("잠긴 세션이라 저장할 수 없습니다. (읽기 전용)");
        }
      } finally {
        savingRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          void flush();
        }
      }
    },
    [page.id],
  );

  const maybeUploadThumbnail = useCallback(
    async (instance: ExcalidrawImperativeAPI) => {
      if (readOnlyRef.current) return;
      const now = Date.now();
      if (now - lastThumbnailAt.current < THUMBNAIL_INTERVAL_MS) return;
      lastThumbnailAt.current = now;
      try {
        const elements = instance.getSceneElements();
        if (elements.length === 0) return;
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
    },
    [page.id],
  );

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // ---- 이미지 업로드 ----------------------------------------------------
  const syncFiles = useCallback(
    async (files: BinaryFiles) => {
      const instance = apiRef.current;
      if (!instance || readOnlyRef.current) return;

      for (const [id, file] of Object.entries(files)) {
        if (uploadedFiles.current.has(id) || uploadingFiles.current.has(id)) continue;
        if (!file?.dataURL) continue;
        uploadingFiles.current.add(id);
        try {
          // 장변 2048px 를 넘으면 업로드 전에 줄인다.
          const resized = await resizeDataUrlIfNeeded(String(file.dataURL));
          let uploadId = id;

          if (resized.resized) {
            // Excalidraw 의 addFiles 는 이미 존재하는 fileId 의 내용을 갱신하지 않는다.
            // 그래서 리사이즈본은 새 fileId 로 등록하고, 이미지 요소가 그것을 가리키게 바꾼다.
            uploadId = `${id}-r${MAX_IMAGE_DIMENSION}`.slice(0, 120);
            instance.addFiles([
              {
                ...file,
                id: uploadId,
                dataURL: resized.dataUrl,
                mimeType: resized.mime,
                created: Date.now(),
              } as unknown as BinaryFileData,
            ]);
            replaceFileIdInScene(instance, id, uploadId);
            // 원본(큰 이미지)은 서버에 올리지 않는다.
            uploadedFiles.current.add(id);
          }

          const blob = dataUrlToBlob(resized.dataUrl);
          await api.uploadFile(page.id, uploadId, resized.mime, blob);
          uploadedFiles.current.add(uploadId);
        } catch {
          // 다음 onChange 에서 다시 시도한다.
        } finally {
          uploadingFiles.current.delete(id);
        }
      }
    },
    [page.id],
  );

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: BinaryFiles) => {
      void syncFiles(files);
      if (readOnlyRef.current) return;

      const shared = pickSharedAppState(appState);
      // 첫 onChange 값을 기준선으로 삼는다 (불러온 씬의 appState 가 이미 반영된 상태).
      if (savedAppState.current === null) savedAppState.current = shared;

      const version = getSceneVersion(elements as never);
      const appStateChanged = !sharedAppStateEquals(shared, savedAppState.current);
      if (version === savedSceneVersion.current && !appStateChanged) return;
      scheduleSave();
    },
    [scheduleSave, syncFiles],
  );

  // ---- 이탈 시 즉시 저장 -------------------------------------------------
  useEffect(() => {
    const flushNow = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushNow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushNow);
      flushNow();
    };
  }, [flush]);

  // ---- E2E 훅 -----------------------------------------------------------
  useEffect(() => {
    if (!EXPOSE_TEST_HOOKS) return;
    window.__excalidrawAPI = excalidrawAPI ?? undefined;
    window.__excalidrawLib = { convertToExcalidrawElements, getSceneVersion, CaptureUpdateAction };
    window.__flushScene = () => flush();
    return () => {
      if (window.__excalidrawAPI === excalidrawAPI) window.__excalidrawAPI = undefined;
    };
  }, [excalidrawAPI, flush]);

  useEffect(() => {
    if (EXPOSE_TEST_HOOKS) window.__saveStatus = status;
  }, [status]);

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

  return (
    <div className="canvas-wrapper" data-testid="canvas-wrapper">
      <div className="save-status" data-testid="save-status" data-status={status} aria-live="polite">
        {STATUS_LABEL[status]}
      </div>
      <Excalidraw
        excalidrawAPI={(instance) => {
          apiRef.current = instance;
          setExcalidrawAPI(instance);
        }}
        initialData={initialData}
        langCode="ko-KR"
        viewModeEnabled={readOnly}
        onChange={onChange}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />
    </div>
  );
}

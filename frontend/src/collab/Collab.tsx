/**
 * 협업 컨트롤러.
 *
 * 출처: excalidraw.com 앱의 `excalidraw-app/collab/Collab.tsx` (MIT).
 * 브로드캐스트·커서·유휴 상태·접속자·따라가기·파일 동기화·재접속 로직은 원본 그대로다.
 * 바꾼 것(작업지시서의 교체표):
 *
 * | 원본 | 우리 구현 |
 * |---|---|
 * | Firebase 저장/로드 | `PUT`/`GET /api/pages/:id/scene` (`collab/storage.ts`) |
 * | Firebase Storage 파일 | `POST /api/pages/:id/files`, `GET /files/:id` (`collab/files.ts`) |
 * | `#room=id,key` 링크 생성·파싱 | `GET /api/pages/:id/room` (URL 에 키를 넣지 않는다) |
 * | `@excalidraw/excalidraw/data/encryption` | `collab/encryption.ts` (원본 사본) |
 * | i18n `t()`, `ErrorDialog`, jotai, `trackEvent`, LocalData/tabSync | 제거 — 한국어 문자열 + React state |
 * | 협업 시작/중지 UI | 없음 — 페이지를 열면 자동 참여, 떠나면 자동 이탈 |
 * | localStorage username | 로그인 사용자의 username |
 *
 * 저장 경로는 이 클래스의 `saveScene()` **하나뿐**이다 (CanvasPage 의 디바운스 저장도 여기로 합쳤다).
 */
import {
  CaptureUpdateAction,
  getSceneVersion,
  getVisibleSceneBounds,
  reconcileElements,
  restoreElements,
  zoomToFitBounds,
} from "@excalidraw/excalidraw";
import type { UserIdleState as UserIdleStateType } from "@excalidraw/excalidraw";
import { UserIdleState } from "@excalidraw/excalidraw";
import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  Gesture,
  SocketId,
  UserToFollow,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/excalidraw/utility-types";
import throttle from "lodash.throttle";
import { PureComponent } from "react";
import type { Socket } from "socket.io-client";
import { ApiError, api } from "../api";
import { pickSharedAppState, sharedAppStateEquals, type SharedAppState } from "../canvas/appState";
import {
  ACTIVE_THRESHOLD,
  CURSOR_SYNC_TIMEOUT,
  IDLE_THRESHOLD,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  SAVE_DEBOUNCE_MS,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
  WS_SUBTYPES,
} from "./constants";
import { decryptData } from "./encryption";
import {
  FileManager,
  loadFilesFromServer,
  normalizeOversizedImages,
  resizedFileId,
  saveFilesToServer,
  updateStaleImageStatuses,
} from "./files";
import { Portal } from "./Portal";
import { SceneVersionCache, loadSceneFromServer, saveSceneToServer } from "./storage";
import {
  getSyncableElements,
  type SocketUpdateDataSource,
  type SyncableExcalidrawElement,
} from "./types";
import {
  assertNever,
  bumpElementVersions,
  cloneJSON,
  isInitializedImageElement,
  preventUnload,
  throttleRAF,
  toBrandedType,
  withBatchedUpdates,
} from "./utils";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface CollabPublicState {
  saveStatus: SaveStatus;
  /** 이 페이지(룸)에 접속한 사람 수 — 자기 자신을 포함한다 */
  collaboratorCount: number;
  isCollaborating: boolean;
  errorMessage: string | null;
}

export interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
  pageId: string;
  /** 로그인 사용자 이름 (원본의 localStorage username 대체) */
  username: string;
  /** 잠긴 세션 등 읽기 전용이면 저장하지 않는다 (브로드캐스트·커서는 그대로) */
  readOnly: boolean;
  onStateChange: (state: CollabPublicState) => void;
  /** 저장이 성공했을 때 (썸네일 업로드 트리거) */
  onSaved?: () => void;
}

interface CollabState {
  errorMessage: string | null;
}

export class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: ExcalidrawImperativeAPI;
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();
  /** the socket ids of the users following the current user */
  private followedBy = new Set<SocketId>();
  private userToFollow: UserToFollow | null = null;

  /** 서버에 반영된 씬 버전 (원본 `firebaseSceneVersionCache` 대응) */
  private sceneVersionCache = new SceneVersionCache();
  private savedAppState: SharedAppState | null = null;
  private appliedServerAppState: SharedAppState | null = null;
  private saving = false;
  private savePending = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveStatus: SaveStatus = "idle";
  private collaboratorCount = 0;
  private collaborating = false;
  private initialized = false;
  private unmounted = false;
  /**
   * 마운트 세대 번호. React StrictMode 는 같은 인스턴스를 마운트→언마운트→마운트 하므로,
   * 이전 세대에서 시작한 비동기 작업이 새 세대의 소켓을 건드리지 않게 이 값으로 구분한다.
   */
  private generation = 0;
  /** 리사이즈 검사를 이미 끝냈거나 진행 중인 fileId */
  private normalizedFiles = new Set<string>();
  /** 진행 중인 리사이즈 작업 수 — 0 이 아니면 업로드를 미룬다 */
  private pendingNormalization = 0;

  constructor(props: CollabProps) {
    super(props);
    this.state = { errorMessage: null };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      getFiles: async (fileIds) => loadFilesFromServer(fileIds),
      saveFiles: async ({ addedFiles }) => {
        // 리사이즈가 끝나기 전에는 올리지 않는다. 큰 원본을 올려 버리면
        // 리사이즈본으로 교체된 뒤 서버에 고아 파일이 남는다.
        if (this.pendingNormalization > 0 || this.props.readOnly) {
          return { savedFiles: new Map(), erroredFiles: new Map() };
        }
        return saveFilesToServer({ pageId: this.props.pageId, addedFiles });
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  get username(): string {
    return this.props.username;
  }

  private onUnmount: (() => void) | null = null;

  override componentDidMount(): void {
    // StrictMode 에서는 같은 인스턴스가 다시 마운트된다 — 언마운트 표시를 되돌린다.
    this.unmounted = false;
    this.generation += 1;
    window.addEventListener("beforeunload", this.beforeUnload);
    window.addEventListener("unload", this.onUnload);
    document.addEventListener("visibilitychange", this.onDocumentVisibilityFlush);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.setUserToFollow(payload.action === "FOLLOW" ? payload.userToFollow : null);
    });
    const throttledRelayUserViewportBounds = throttleRAF(this.relayVisibleSceneBounds);
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUnmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    // 소켓 연결과 무관하게 저장된 이미지는 복원한다.
    void this.restoreImageFiles();
    void this.startCollaboration();
  }

  override componentWillUnmount(): void {
    this.unmounted = true;
    this.generation += 1;
    window.removeEventListener("beforeunload", this.beforeUnload);
    window.removeEventListener("unload", this.onUnload);
    document.removeEventListener("visibilitychange", this.onDocumentVisibilityFlush);
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUnmount?.();
    this.stopCollaboration();
  }

  // ---- 외부 상태 통지 ---------------------------------------------------

  private publishState = (): void => {
    this.props.onStateChange({
      saveStatus: this.saveStatus,
      collaboratorCount: this.collaboratorCount,
      isCollaborating: this.collaborating,
      errorMessage: this.state.errorMessage,
    });
  };

  private setSaveStatus = (status: SaveStatus): void => {
    if (this.saveStatus === status) return;
    this.saveStatus = status;
    this.publishState();
  };

  private setIsCollaborating = (value: boolean): void => {
    if (this.collaborating === value) return;
    this.collaborating = value;
    this.publishState();
  };

  isCollaborating = (): boolean => this.collaborating;

  setErrorMessage = (errorMessage: string | null): void => {
    if (this.state.errorMessage === errorMessage) return;
    this.setState({ errorMessage }, this.publishState);
  };

  // ---- 이탈 처리 --------------------------------------------------------

  private onUnload = (): void => {
    this.destroySocketClient({ isUnload: true });
  };

  private onDocumentVisibilityFlush = (): void => {
    if (document.visibilityState === "hidden") this.flushSave();
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(this.getSceneElementsIncludingDeleted());

    if (
      !this.props.readOnly &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !this.sceneVersionCache.isSaved(syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      void this.saveScene({ keepalive: true });

      // 업스트림의 VITE_APP_DISABLE_PREVENT_UNLOAD 와 같은 탈출구.
      if (import.meta.env.VITE_DISABLE_PREVENT_UNLOAD !== "1") {
        preventUnload(event);
      }
    }
  });

  // ---- 저장 (유일한 저장 경로) ------------------------------------------

  /**
   * 원본 `saveCollabRoomToFirebase` 대응.
   * 요소가 그대로여도 공유 appState(배경색·그리드 등)가 바뀌었으면 저장한다.
   */
  saveScene = async (opts: { keepalive?: boolean } = {}): Promise<void> => {
    if (this.props.readOnly) return;
    if (this.saving) {
      this.savePending = true;
      return;
    }

    const all = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    const syncable = getSyncableElements(all);
    const localVersion = getSceneVersion(syncable);
    const appState = this.excalidrawAPI.getAppState() as unknown as Record<string, unknown>;
    const localShared = pickSharedAppState(appState);
    const appStateDirty =
      this.savedAppState === null || !sharedAppStateEquals(localShared, this.savedAppState);
    if (localVersion === this.sceneVersionCache.get() && !appStateDirty) return;

    this.saving = true;
    this.setSaveStatus("saving");
    try {
      const result = await saveSceneToServer(
        this.props.pageId,
        cloneJSON(syncable) as readonly SyncableExcalidrawElement[],
        appState,
        opts,
      );
      this.sceneVersionCache.set(localVersion);
      this.savedAppState = localShared;

      // 서버가 병합해 돌려준 appState 가 로컬과 다르면(다른 사용자가 바꿈) 반영한다.
      // 같은 값은 한 번만 적용한다 — 로컬이 받아들이지 않을 때 저장 루프가 생기지 않게.
      const serverShared = pickSharedAppState(result.appState);
      const alreadyApplied =
        this.appliedServerAppState !== null &&
        sharedAppStateEquals(serverShared, this.appliedServerAppState);
      if (!sharedAppStateEquals(serverShared, localShared) && !alreadyApplied) {
        this.appliedServerAppState = serverShared;
        this.excalidrawAPI.updateScene({
          appState: serverShared as never,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }

      if (result.changed && !this.unmounted) {
        // 다른 사용자의 변경이 병합되어 돌아왔다 → 원본과 같은 방식으로 화면에 반영한다.
        this.handleRemoteSceneUpdate(
          this._reconcileElements(
            toBrandedType<readonly RemoteExcalidrawElement[]>(result.elements),
          ),
        );
        this.sceneVersionCache.set(
          getSceneVersion(
            getSyncableElements(this.excalidrawAPI.getSceneElementsIncludingDeleted()),
          ),
        );
      }

      this.setSaveStatus("saved");
      this.props.onSaved?.();
    } catch (error) {
      // 페이지를 떠나며 취소된 요청은 알릴 대상이 없다 (이탈 시 flush 저장).
      if (this.unmounted) return;
      this.setSaveStatus("error");
      if (error instanceof ApiError && error.status === 403) {
        this.setErrorMessage("잠긴 세션이라 저장할 수 없습니다. (읽기 전용)");
      } else {
        this.setErrorMessage("변경 내용을 저장하지 못했습니다. 연결을 확인해 주세요.");
      }
      console.error(error);
    } finally {
      this.saving = false;
      if (this.savePending && !this.unmounted) {
        this.savePending = false;
        void this.saveScene();
      }
    }
  };

  /** 대기 중인 디바운스를 취소하고 즉시 저장한다 (탭 숨김·언마운트·이탈). */
  flushSave = (opts: { keepalive?: boolean } = { keepalive: true }): void => {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.saveScene(opts);
  };

  private scheduleSave = (): void => {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveScene();
    }, SAVE_DEBOUNCE_MS);
  };

  /**
   * 원본 `queueSaveToFirebase` 대응 — 편집이 계속되는 동안의 주기 저장.
   * 상수(`SYNC_FULL_SCENE_INTERVAL_MS`)와 `leading:false` 는 업스트림 그대로.
   */
  queueSaveScene = throttle(
    () => {
      if (this.initialized) void this.saveScene();
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  // ---- 협업 시작/중지 ---------------------------------------------------

  stopCollaboration = (): void => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveScene.cancel();
    this.loadImageFiles.cancel();
    this.onPointerUpdate.cancel();

    // 이탈 직전 마지막 저장 (디바운스 대기 중인 변경을 흘리지 않는다)
    this.flushSave();

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off("connect_error", this.fallbackInitializationHandler);
    }
    this.destroySocketClient();
  };

  private destroySocketClient = (opts?: { isUnload: boolean }): void => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    this.followedBy = new Set();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.userToFollow = null;
      this.collaborators = new Map();
      this.collaboratorCount = 0;
      if (!this.unmounted) {
        this.excalidrawAPI.updateScene({ collaborators: this.collaborators });
      }
      this.publishState();
    }
  };

  private fetchImageFilesFromServer = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" || Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);
      const decodedData = new TextDecoder("utf-8").decode(new Uint8Array(decrypted));
      return JSON.parse(decodedData) as ValueOf<SocketUpdateDataSource>;
    } catch (error) {
      console.error(error);
      this.setErrorMessage("협업 데이터를 복호화하지 못했습니다.");
      return { type: WS_SUBTYPES.INVALID_RESPONSE };
    }
  };

  private fallbackInitializationHandler: null | (() => void) = null;

  startCollaboration = async (): Promise<void> => {
    if (this.portal.socket) return;
    const generation = this.generation;
    const stale = () => this.unmounted || this.generation !== generation;

    let roomId: string;
    let roomKey: string;
    try {
      // 원본의 `#room=id,key` 링크 대신 서버에서 룸 정보를 받는다 (URL 에 키를 넣지 않는다).
      const room = await api.getRoom(this.props.pageId);
      roomId = room.roomId;
      roomKey = room.roomKey;
    } catch (error) {
      console.error(error);
      this.markInitialized();
      this.setErrorMessage("실시간 협업에 연결하지 못했습니다. 변경 내용은 계속 저장됩니다.");
      return;
    }
    if (stale()) return;

    // 이미 서버에 있는 이미지는 다시 올리지 않는다 (`files/exists`).
    await this.seedSavedFiles();
    if (stale()) return;

    this.setIsCollaborating(true);

    let socketIOClient: (typeof import("socket.io-client"))["default"];
    try {
      ({ default: socketIOClient } = await import("socket.io-client"));
    } catch (error) {
      console.error(error);
      this.markInitialized();
      this.setIsCollaborating(false);
      return;
    }
    if (stale()) return;

    const fallbackInitializationHandler = () => {
      void this.initializeRoom({ fetchScene: true });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    let socket: Socket;
    try {
      socket = this.portal.open(
        // 항상 같은 오리진(app)으로 붙는다 — app 이 `/socket.io` 를 room 으로 프록시한다.
        socketIOClient(window.location.origin, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          withCredentials: true,
        }),
        roomId,
        roomKey,
      );
      this.portal.socket = socket;
    } catch (error) {
      console.error(error);
      this.markInitialized();
      this.setIsCollaborating(false);
      this.setErrorMessage("실시간 협업에 연결하지 못했습니다.");
      return;
    }

    socket.once("connect_error", fallbackInitializationHandler);

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    socket.on("client-broadcast", async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
      if (!this.portal.roomKey) return;

      const decryptedData = await this.decryptPayload(iv, encryptedData, this.portal.roomKey);

      switch (decryptedData.type) {
        case WS_SUBTYPES.INVALID_RESPONSE:
          return;
        case WS_SUBTYPES.INIT: {
          if (!this.portal.socketInitialized) {
            void this.initializeRoom({ fetchScene: false });
            const remoteElements = toBrandedType<readonly RemoteExcalidrawElement[]>(
              decryptedData.payload.elements,
            );
            const reconciledElements = this._reconcileElements(remoteElements);
            this.handleRemoteSceneUpdate(reconciledElements);
          }
          break;
        }
        case WS_SUBTYPES.UPDATE:
          this.handleRemoteSceneUpdate(
            this._reconcileElements(
              toBrandedType<readonly RemoteExcalidrawElement[]>(decryptedData.payload.elements),
            ),
          );
          break;
        case WS_SUBTYPES.MOUSE_LOCATION: {
          const { pointer, button, username, selectedElementIds } = decryptedData.payload;
          const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
            decryptedData.payload.socketId;

          this.updateCollaborator(socketId, {
            pointer,
            button,
            selectedElementIds,
            username,
          });
          break;
        }

        case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
          const { sceneBounds, socketId } = decryptedData.payload;
          const userToFollow = this.userToFollow;

          // we're not following the user
          // (shouldn't happen, but could be late message or bug upstream)
          if (userToFollow?.socketId !== socketId) {
            console.warn(
              `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
            );
            return;
          }

          // cross-follow case, ignore updates in this case
          if (this.followedBy.has(userToFollow.socketId)) return;

          const appState = this.excalidrawAPI.getAppState();
          this.excalidrawAPI.updateScene({
            appState: zoomToFitBounds({
              appState,
              bounds: sceneBounds,
              // 0.18.1 API — 상위 버전의 `fit: "contain"` 과 같은 의미다.
              fitToViewport: false,
            }).appState,
          });
          break;
        }

        case WS_SUBTYPES.IDLE_STATUS: {
          const { userState, socketId, username } = decryptedData.payload;
          this.updateCollaborator(socketId, { userState, username });
          break;
        }

        default: {
          assertNever(decryptedData, null);
        }
      }
    });

    socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      // 방에 처음 들어왔다 → 서버 씬이 진실이다.
      await this.initializeRoom({ fetchScene: true });
    });

    socket.on(WS_EVENTS.USER_FOLLOW_ROOM_CHANGE, (followedBy: SocketId[]) => {
      this.followedBy = new Set(followedBy);
      this.relayVisibleSceneBounds({ force: true });
    });

    this.initializeIdleDetector();
  };

  /**
   * 서버에 이미 있는 파일을 FileManager 에 "저장됨" 으로 심는다.
   * (`POST /api/pages/:id/files/exists` — 페이지를 다시 열 때 재업로드를 막는다.)
   */
  private seedSavedFiles = async (): Promise<void> => {
    const ids = new Set<string>();
    for (const element of this.excalidrawAPI.getSceneElementsIncludingDeleted()) {
      if (isInitializedImageElement(element)) ids.add(element.fileId);
    }
    if (ids.size === 0) return;
    try {
      const { existing } = await api.filesExist(this.props.pageId, [...ids]);
      for (const id of existing) this.fileManager.markSaved(id as FileId);
    } catch {
      // 실패해도 업로드 경로가 중복을 걸러준다 (서버가 같은 fileId 를 dedupe 한다).
    }
  };

  private markInitialized = (): void => {
    this.initialized = true;
  };

  private initializeRoom = async ({ fetchScene }: { fetchScene: boolean }): Promise<void> => {
    clearTimeout(this.socketInitializationTimer);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off("connect_error", this.fallbackInitializationHandler);
    }
    if (fetchScene) {
      try {
        // 원본은 여기서 `resetScene()` 하지만, 우리는 페이지를 열 때 이미 서버 씬을
        // 불러온 상태다. 덮어쓰지 않고 서버 씬과 병합한다.
        const scene = await loadSceneFromServer(this.props.pageId);
        if (this.unmounted) return;
        const reconciled = this._reconcileElements(
          toBrandedType<readonly RemoteExcalidrawElement[]>(scene.elements),
        );
        this.handleRemoteSceneUpdate(reconciled);
      } catch (error) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
        this.markInitialized();
      }
    } else {
      this.portal.socketInitialized = true;
      this.markInitialized();
    }
  };

  private _reconcileElements = (
    remoteElements: readonly RemoteExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const appState = this.excalidrawAPI.getAppState();
    const existingElements = this.getSceneElementsIncludingDeleted();

    // NOTE ideally we restore _after_ reconciliation but we can't do that
    // as we'd regenerate even elements such as appState.newElement which would
    // break the state
    const restored = restoreElements(
      remoteElements as unknown as ExcalidrawElement[],
      existingElements,
    ) as unknown as readonly RemoteExcalidrawElement[];

    let reconciledElements = reconcileElements(existingElements, restored, appState);

    reconciledElements = bumpElementVersions(
      reconciledElements,
      existingElements,
    ) as ReconciledExcalidrawElement[];

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(reconciledElements));

    return reconciledElements;
  };

  /**
   * 페이지를 열 때 한 번 — 저장된 이미지를 서버에서 되살린다.
   * `forceFetchFiles` 로 status 가 `pending` 인 채 저장된 요소까지 챙긴다.
   */
  private restoreImageFiles = async (): Promise<void> => {
    const { loadedFiles, erroredFiles } = await this.fetchImageFilesFromServer({
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      forceFetchFiles: true,
    });
    if (this.unmounted) return;
    this.excalidrawAPI.addFiles(loadedFiles);
    for (const file of loadedFiles) this.normalizedFiles.add(file.id);
    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } = await this.fetchImageFilesFromServer({
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
    if (this.unmounted) return;

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (elements: ReconciledExcalidrawElement[]): void => {
    if (this.unmounted) return;
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  // ---- 유휴 상태 --------------------------------------------------------

  private onPointerMove = (): void => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(this.reportActive, ACTIVE_THRESHOLD);
    }
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(this.reportActive, ACTIVE_THRESHOLD);
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = (): void => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = (): void => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = (): void => {
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  };

  // ---- 접속자 -----------------------------------------------------------

  setCollaborators(sockets: SocketId[]): void {
    const collaborators = new Map<SocketId, Collaborator>();
    for (const socketId of sockets) {
      const isCurrentUser = socketId === this.portal.socket?.id;
      collaborators.set(
        socketId,
        Object.assign(
          // we never receive our own broadcasts, so we need to seed
          // our own collaborator entry with the local username
          isCurrentUser ? { username: this.username } : {},
          this.collaborators.get(socketId),
          { isCurrentUser },
        ),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });

    this.collaboratorCount = collaborators.size;
    this.publishState();

    // unfollow if the followed user left the room
    if (this.userToFollow && !collaborators.has(this.userToFollow.socketId)) {
      this.setUserToFollow(null);
    }
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>): void => {
    const isCurrentUser = socketId === this.portal.socket?.id;
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      // we never receive our own broadcasts, so we need to seed
      // our own collaborator entry with the local username
      isCurrentUser ? { username: this.username } : {},
      collaborators.get(socketId),
      updates,
      { isCurrentUser },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({ collaborators });
  };

  // ---- 브로드캐스트 -----------------------------------------------------

  setLastBroadcastedOrReceivedSceneVersion = (version: number): void => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  getLastBroadcastedOrReceivedSceneVersion = (): number =>
    this.lastBroadcastedOrReceivedSceneVersion;

  getSceneElementsIncludingDeleted = (): readonly OrderedExcalidrawElement[] =>
    this.excalidrawAPI.getSceneElementsIncludingDeleted();

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }): void => {
    if (this.portal.socket && (this.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        { sceneBounds: getVisibleSceneBounds(this.excalidrawAPI.getAppState()) },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleStateType): void => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]): void => {
    if (getSceneVersion(elements) > this.getLastBroadcastedOrReceivedSceneVersion()) {
      void this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  /**
   * Excalidraw `onChange` 에서 호출한다 (원본 App.tsx 의 연결 방식과 동일).
   * 브로드캐스트 + 저장 예약이 여기서 한 번에 일어난다.
   */
  syncElements = (elements: readonly OrderedExcalidrawElement[]): void => {
    this.broadcastElements(elements);
    this.queueSaveScene();
    this.scheduleSave();
  };

  /**
   * 새 이미지를 장변 2048px 로 줄이고 씬의 fileId 를 교체한다 (업로드 전 단계).
   *
   * 동기적으로 "아직 검사하지 않은 파일" 을 표시해 두므로, 이 함수가 끝나기 전에는
   * `saveFiles` 가 아무것도 올리지 않는다(위 FileManager 콜백 참고).
   */
  normalizeImages = (): void => {
    if (this.props.readOnly) return;
    const files = this.excalidrawAPI.getFiles();
    const pending: string[] = [];
    for (const id of Object.keys(files)) {
      if (this.normalizedFiles.has(id)) continue;
      this.normalizedFiles.add(id);
      // 리사이즈본 id 도 미리 표시해 두어 두 번 검사하지 않는다.
      this.normalizedFiles.add(resizedFileId(id));
      pending.push(id);
    }
    if (pending.length === 0) return;

    this.pendingNormalization += 1;
    void normalizeOversizedImages(this.excalidrawAPI, pending)
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => {
        this.pendingNormalization -= 1;
        // 리사이즈로 씬이 바뀌지 않았더라도 미뤄 둔 업로드를 다시 돌린다.
        this.portal.queueFileUpload();
      });
  };

  queueBroadcastAllElements = throttle(() => {
    void this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  // ---- 따라가기 ---------------------------------------------------------

  setUserToFollow = (userToFollow: UserToFollow | null): void => {
    const prev = this.userToFollow;

    if (prev?.socketId !== userToFollow?.socketId && this.portal.socket) {
      // leave the previous user's follow room before joining the next one
      if (prev) {
        this.portal.broadcastUserFollowed({ userToFollow: prev, action: "UNFOLLOW" });
      }
      if (userToFollow) {
        this.portal.broadcastUserFollowed({ userToFollow, action: "FOLLOW" });
      }
    }

    this.userToFollow = userToFollow;
  };

  override render(): null {
    // UI 는 CanvasPage 가 그린다 (저장 상태·접속자 수·오류 배너).
    return null;
  }
}

export default Collab;

/**
 * 협업 상수.
 *
 * 출처: excalidraw.com 앱의 `excalidraw-app/app_constants.ts` (MIT).
 * **값은 업스트림 그대로 유지한다** — 브로드캐스트·재동기화 타이밍이 바뀌면
 * 원본에서 검증된 동작(대역폭·수렴 속도)이 깨진다.
 */

// time constants (ms)
export const INITIAL_SCENE_UPDATE_TIMEOUT = 5000;
export const FILE_UPLOAD_TIMEOUT = 300;
export const LOAD_IMAGES_TIMEOUT = 500;
export const SYNC_FULL_SCENE_INTERVAL_MS = 20000;
export const CURSOR_SYNC_TIMEOUT = 33; // ~30fps
export const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000; // 1 day

/** should be aligned with MAX_ALLOWED_FILE_BYTES (서버는 5MiB 까지 받는다) */
export const FILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

export const WS_EVENTS = {
  SERVER_VOLATILE: "server-volatile-broadcast",
  SERVER: "server-broadcast",
  USER_FOLLOW_CHANGE: "user-follow",
  USER_FOLLOW_ROOM_CHANGE: "user-follow-room-change",
} as const;

export enum WS_SUBTYPES {
  INVALID_RESPONSE = "INVALID_RESPONSE",
  INIT = "SCENE_INIT",
  UPDATE = "SCENE_UPDATE",
  MOUSE_LOCATION = "MOUSE_LOCATION",
  IDLE_STATUS = "IDLE_STATUS",
  USER_VISIBLE_SCENE_BOUNDS = "USER_VISIBLE_SCENE_BOUNDS",
}

/**
 * `@excalidraw/common` 의 유휴 상태 임계값 (패키지 메인에서 export 되지 않아 값만 옮겼다).
 * `node_modules/@excalidraw/excalidraw/dist/types/excalidraw/constants.d.ts` 와 일치한다.
 */
export const IDLE_THRESHOLD = 60_000;
export const ACTIVE_THRESHOLD = 3_000;

/** AES-GCM 키 길이 (`@excalidraw/common` 의 ENCRYPTION_KEY_BITS) */
export const ENCRYPTION_KEY_BITS = 128;

/**
 * 로컬 변경을 서버에 반영하기까지의 디바운스.
 *
 * 업스트림 excalidraw.com 은 20초 간격 Firebase 저장 + 300ms 간격 localStorage 저장의
 * 2단 구조인데, 우리는 로컬 저장소가 없고 **서버가 곧 저장소**다. 그래서
 * localStorage 자리에 이 디바운스를 두고, 편집이 계속되는 동안에는
 * `SYNC_FULL_SCENE_INTERVAL_MS` 스로틀이 주기 저장을 보장한다.
 * 두 트리거 모두 `Collab.saveScene()` 한 곳으로 들어간다 (저장 경로는 하나다).
 */
export const SAVE_DEBOUNCE_MS = 1500;

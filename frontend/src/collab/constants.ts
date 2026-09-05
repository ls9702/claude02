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
 *
 * 이 값이 곧 "탭을 즉시 닫으면 잃을 수 있는 최대 구간" 이라 800ms 로 줄였다
 * (자세한 한계는 루트 `KNOWN_ISSUES.md` 참고).
 */
export const SAVE_DEBOUNCE_MS = 800;

/**
 * 이탈 플러시에서 `keepalive: true` 로 보낼 수 있는 본문의 상한.
 * 브라우저는 keepalive 요청 본문 합계를 64KiB 로 제한하므로, 그보다 큰 씬은
 * keepalive 를 포기하고 일반 fetch 로 시도한다(완주 보장은 없다).
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

/**
 * 마운트 직후 저장된 이미지를 되살리기 전에 "씬이 채워지기" 를 기다리는 폴링 간격·횟수.
 *
 * `<Collab>` 은 `excalidrawAPI` 가 생긴 다음에 마운트되지만, Excalidraw 는 `initialData` 를
 * **한 박자 뒤에** 씬에 반영한다. 그 사이에 `restoreImageFiles()` 가 돌면 요소가 하나도 없어
 * 되살릴 이미지를 찾지 못한다. 개발 모드에서는 React StrictMode 가 컴포넌트를 한 번 더
 * 마운트해 주어 두 번째 시도가 성공했지만, **프로덕션 빌드에는 그 두 번째 기회가 없다**
 * (M6 프로덕션 스모크에서 발견 — 새로고침하면 이미지가 빈 자리로 남았다).
 */
export const RESTORE_IMAGES_RETRY_MS = 150;
export const RESTORE_IMAGES_MAX_ATTEMPTS = 40; // 최대 약 6초

/** 환경변수에서 밀리초 상수를 읽는다 (E2E 에서 타이머를 줄이기 위해). */
const msFromEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * 룸 재검증 주기.
 *
 * 소켓은 핸드셰이크 때 한 번만 인증되고, 세션 잠금은 언제든 바뀔 수 있다.
 * 그래서 주기적으로 `GET /api/pages/:id/room` 을 다시 물어
 * 403/401 이면 룸을 떠나고, `{locked:true}` 면 릴레이를 끊고 뷰 모드로 내려간다.
 */
export const ROOM_RECHECK_MS = msFromEnv(import.meta.env.VITE_ROOM_RECHECK_MS, 30_000);

/** 잠긴 세션에서 뷰어가 서버 씬을 다시 읽는 주기 (릴레이를 쓰지 않으므로 폴링한다) */
export const SCENE_POLL_MS = msFromEnv(import.meta.env.VITE_SCENE_POLL_MS, 15_000);

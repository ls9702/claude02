/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
  /** "1" 이면 저장되지 않은 변경이 있어도 이탈 확인 대화상자를 띄우지 않는다. */
  readonly VITE_DISABLE_PREVENT_UNLOAD?: string;
  /** 룸 재검증 주기(ms). 기본 30000 — E2E 에서 줄인다. */
  readonly VITE_ROOM_RECHECK_MS?: string;
  /** 잠긴 세션에서 뷰어의 씬 폴링 주기(ms). 기본 15000 — E2E 에서 줄인다. */
  readonly VITE_SCENE_POLL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export {};

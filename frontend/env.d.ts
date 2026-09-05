/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
  /** "1" 이면 저장되지 않은 변경이 있어도 이탈 확인 대화상자를 띄우지 않는다. */
  readonly VITE_DISABLE_PREVENT_UNLOAD?: string;
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

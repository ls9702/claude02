import type { CaptureUpdateAction, convertToExcalidrawElements, getSceneVersion } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

declare global {
  interface Window {
    /** E2E/개발 모드에서만 노출되는 테스트 훅 */
    __excalidrawAPI?: ExcalidrawImperativeAPI | undefined;
    __excalidrawLib?: {
      convertToExcalidrawElements: typeof convertToExcalidrawElements;
      getSceneVersion: typeof getSceneVersion;
      CaptureUpdateAction: typeof CaptureUpdateAction;
    };
    __flushScene?: () => Promise<void>;
    __saveStatus?: string;
  }
}

export {};

import type {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getSceneVersion,
  newElementWith,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

declare global {
  interface Window {
    /** E2E/개발 모드에서만 노출되는 테스트 훅 */
    __excalidrawAPI?: ExcalidrawImperativeAPI | undefined;
    __excalidrawLib?: {
      convertToExcalidrawElements: typeof convertToExcalidrawElements;
      getSceneVersion: typeof getSceneVersion;
      CaptureUpdateAction: typeof CaptureUpdateAction;
      newElementWith: typeof newElementWith;
    };
    __flushScene?: () => Promise<void>;
    __saveStatus?: string;
    /** 현재 페이지(룸) 접속자 수 — 자기 자신 포함 */
    __collaboratorCount?: number;
  }
}

export {};

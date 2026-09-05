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
    /** 릴레이 소켓의 transport 를 강제로 끊는다 (재연결 표시 테스트용) */
    __closeCollabTransport?: () => void;
    __saveStatus?: string;
    /** 현재 페이지(룸) 접속자 수 — 자기 자신 포함 */
    __collaboratorCount?: number;
    /** 릴레이 연결 상태 (idle/connected/reconnecting/locked) */
    __collabConnection?: string;
    // ---- 시트 (M5) ----
    /** Fortune-sheet 인스턴스 ref (`current` 를 매번 새로 읽어야 최신 context 다) */
    __sheetRef?: { current: unknown } | undefined;
    /** 디바운스를 건너뛰고 즉시 저장한다 */
    __sheetFlush?: (() => Promise<void>) | undefined;
    /** 수식을 다시 계산한다 */
    __sheetRecalculate?: (() => void) | undefined;
    __sheetSaveStatus?: string;
    __sheetReady?: boolean;
  }
}

export {};

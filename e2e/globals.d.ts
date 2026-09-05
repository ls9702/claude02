/** 브라우저에서 접근하는 E2E 테스트 훅 (frontend 가 VITE_E2E=1 일 때 노출한다). */
interface ExcalidrawTestApi {
  updateScene(data: {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    captureUpdate?: unknown;
  }): void;
  getSceneElements(): ReadonlyArray<Record<string, unknown>>;
  getSceneElementsIncludingDeleted(): ReadonlyArray<Record<string, unknown>>;
  getFiles(): Record<string, { id: string; dataURL: string; mimeType: string }>;
  addFiles(files: Array<{ id: string; dataURL: string; mimeType: string; created: number }>): void;
  getAppState(): Record<string, unknown>;
}

interface ExcalidrawTestLib {
  convertToExcalidrawElements(skeleton: unknown[]): Array<Record<string, unknown>>;
  getSceneVersion(elements: readonly unknown[]): number;
  CaptureUpdateAction: Record<string, string>;
  /** 요소를 바꾸면서 version/versionNonce 를 올린다 (협업 병합의 기준) */
  newElementWith<T extends Record<string, unknown>>(element: T, updates: Record<string, unknown>): T;
}

interface Window {
  __excalidrawAPI?: ExcalidrawTestApi;
  __excalidrawLib?: ExcalidrawTestLib;
  __flushScene?: () => Promise<void>;
  /** 릴레이 소켓의 transport 를 강제로 끊는다 (재연결 표시 테스트용) */
  __closeCollabTransport?: () => void;
  __saveStatus?: string;
  __collaboratorCount?: number;
  /** 릴레이 연결 상태 (idle/connected/reconnecting/locked) */
  __collabConnection?: string;

  // ---- 시트 (M5) ----
  /** Fortune-sheet 인스턴스 ref — `current` 를 호출할 때마다 새로 읽어야 한다. */
  __sheetRef?: { current: SheetTestApi | null };
  /** 디바운스를 건너뛰고 즉시 저장한다 */
  __sheetFlush?: () => Promise<void>;
  /** 수식을 다시 계산한다 */
  __sheetRecalculate?: () => void;
  __sheetSaveStatus?: string;
  __sheetReady?: boolean;
}

/** Fortune-sheet 인스턴스 중 E2E 에서 쓰는 부분만 */
interface SheetTestApi {
  getAllSheets(): Array<{
    name: string;
    id?: string;
    data?: Array<Array<Record<string, unknown> | null>>;
    celldata?: Array<{ r: number; c: number; v: Record<string, unknown> | null }>;
  }>;
  getSheet(): { name: string; id?: string };
  setCellValue(row: number, column: number, value: unknown, options?: Record<string, unknown>): void;
  calculateFormula(id?: string): void;
}

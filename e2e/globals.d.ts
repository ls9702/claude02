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
  __saveStatus?: string;
  __collaboratorCount?: number;
}

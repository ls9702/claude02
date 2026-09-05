/**
 * 이미지 파일 동기화.
 *
 * `FileManager` 는 excalidraw.com 앱의 `excalidraw-app/data/FileManager.ts` (MIT) 를
 * 인터페이스 그대로 옮긴 것이다. Firebase Storage 대신 우리 파일 API 를 쓴다.
 *
 * | 원본 | 우리 구현 |
 * |---|---|
 * | `saveFilesToFirebase` (룸 키로 암호화 후 업로드) | `POST /api/pages/:id/files` (평문, 접근 제어는 세션 멤버십) |
 * | `loadFilesFromFirebase` | `GET /files/:fileId` |
 * | `encodeFilesForUpload` (compress+encrypt) | 업로드 전 장변 2048px 리사이즈 (M1 규칙 유지) |
 */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { api } from "../api";
import { MAX_IMAGE_DIMENSION, dataUrlToBlob, resizeDataUrlIfNeeded } from "../utils/image";
import { FILE_UPLOAD_MAX_BYTES } from "./constants";
import { isInitializedImageElement } from "./utils";

type FileVersion = Required<BinaryFileData>["version"];

/** 업로드 도중 룸이 닫히면 던진다 (원본 `AbortError` 대응 — 배너를 띄우지 않는다). */
export class AbortError extends Error {
  constructor(message = "요청이 취소되었습니다.") {
    super(message);
    this.name = "AbortError";
  }
}

// ---- FileManager (업스트림 사본) ----------------------------------------

export class FileManager {
  /** files being fetched */
  private fetchingFiles = new Map<FileId, true>();
  private erroredFiles_fetch = new Map<FileId, true>();
  /** files being saved */
  private savingFiles = new Map<FileId, FileVersion>();
  /* files already saved to persistent storage */
  private savedFiles = new Map<FileId, FileVersion>();
  private erroredFiles_save = new Map<FileId, FileVersion>();

  private _getFiles;
  private _saveFiles;

  constructor({
    getFiles,
    saveFiles,
  }: {
    getFiles: (fileIds: FileId[]) => Promise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>;
    saveFiles: (data: { addedFiles: Map<FileId, BinaryFileData> }) => Promise<{
      savedFiles: Map<FileId, BinaryFileData>;
      erroredFiles: Map<FileId, BinaryFileData>;
    }>;
  }) {
    this._getFiles = getFiles;
    this._saveFiles = saveFiles;
  }

  /** returns whether file is saved/errored, or being processed */
  isFileTracked = (id: FileId): boolean =>
    this.savedFiles.has(id) ||
    this.savingFiles.has(id) ||
    this.fetchingFiles.has(id) ||
    this.erroredFiles_fetch.has(id) ||
    this.erroredFiles_save.has(id);

  isFileSavedOrBeingSaved = (file: BinaryFileData): boolean => {
    const fileVersion = this.getFileVersion(file);
    return (
      this.savedFiles.get(file.id) === fileVersion || this.savingFiles.get(file.id) === fileVersion
    );
  };

  getFileVersion = (file: BinaryFileData): FileVersion => file.version ?? 1;

  /**
   * 업스트림에 없는 추가 API — 서버에 이미 있는 파일을 "저장됨" 으로 표시한다.
   * (페이지를 다시 열 때 이미 올라간 이미지를 재업로드하지 않기 위해 쓴다.
   * `POST /api/pages/:id/files/exists` 결과를 넣는다.)
   */
  markSaved = (id: FileId, version: FileVersion = 1): void => {
    this.savedFiles.set(id, version);
  };

  saveFiles = async ({
    elements,
    files,
  }: {
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
  }): Promise<{
    savedFiles: Map<FileId, BinaryFileData>;
    erroredFiles: Map<FileId, BinaryFileData>;
  }> => {
    const addedFiles: Map<FileId, BinaryFileData> = new Map();

    for (const element of elements) {
      const fileData = isInitializedImageElement(element) && files[element.fileId];

      if (
        fileData &&
        // NOTE if errored during save, won't retry due to this check
        !this.isFileSavedOrBeingSaved(fileData)
      ) {
        addedFiles.set(element.fileId, fileData);
        this.savingFiles.set(element.fileId, this.getFileVersion(fileData));
      }
    }

    try {
      const { savedFiles, erroredFiles } = await this._saveFiles({ addedFiles });

      for (const [fileId, fileData] of savedFiles) {
        this.savedFiles.set(fileId, this.getFileVersion(fileData));
      }
      for (const [fileId, fileData] of erroredFiles) {
        this.erroredFiles_save.set(fileId, this.getFileVersion(fileData));
      }

      return { savedFiles, erroredFiles };
    } finally {
      for (const [fileId] of addedFiles) {
        this.savingFiles.delete(fileId);
      }
    }
  };

  getFiles = async (
    ids: FileId[],
  ): Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }> => {
    if (!ids.length) {
      return { loadedFiles: [], erroredFiles: new Map() };
    }
    for (const id of ids) {
      this.fetchingFiles.set(id, true);
    }

    try {
      const { loadedFiles, erroredFiles } = await this._getFiles(ids);

      for (const file of loadedFiles) {
        this.savedFiles.set(file.id, this.getFileVersion(file));
      }
      for (const [fileId] of erroredFiles) {
        this.erroredFiles_fetch.set(fileId, true);
      }

      return { loadedFiles, erroredFiles };
    } finally {
      for (const id of ids) {
        this.fetchingFiles.delete(id);
      }
    }
  };

  /**
   * a file element prevents unload only if it's being saved regardless of
   * its `status`.
   */
  shouldPreventUnload = (elements: readonly ExcalidrawElement[]): boolean =>
    elements.some(
      (element) =>
        isInitializedImageElement(element) &&
        !element.isDeleted &&
        this.savingFiles.has(element.fileId),
    );

  /** helper to determine if image element status needs updating */
  shouldUpdateImageElementStatus = (
    element: ExcalidrawElement,
  ): element is InitializedExcalidrawImageElement =>
    isInitializedImageElement(element) &&
    this.savedFiles.has(element.fileId) &&
    element.status === "pending";

  reset(): void {
    this.fetchingFiles.clear();
    this.savingFiles.clear();
    this.savedFiles.clear();
    this.erroredFiles_fetch.clear();
    this.erroredFiles_save.clear();
  }
}

/** 업스트림 `updateStaleImageStatuses` 그대로. */
export const updateStaleImageStatuses = (params: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  erroredFiles: Map<FileId, true>;
  elements: readonly ExcalidrawElement[];
}): void => {
  if (!params.erroredFiles.size) return;
  params.excalidrawAPI.updateScene({
    elements: params.excalidrawAPI.getSceneElementsIncludingDeleted().map((element) => {
      if (isInitializedImageElement(element) && params.erroredFiles.has(element.fileId)) {
        return newElementWith(element, { status: "error" });
      }
      return element;
    }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

// ---- 우리 서버 구현 -----------------------------------------------------

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });

/** `GET /files/:fileId` — 원본 `loadFilesFromFirebase` 대응 */
export async function loadFilesFromServer(ids: readonly FileId[]): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    ids.map(async (id) => {
      try {
        const response = await fetch(`/files/${encodeURIComponent(id)}`, {
          credentials: "same-origin",
        });
        if (!response.ok) {
          erroredFiles.set(id, true);
          return;
        }
        const blob = await response.blob();
        loadedFiles.push({
          id,
          dataURL: (await blobToDataUrl(blob)) as BinaryFileData["dataURL"],
          mimeType: (blob.type || "image/png") as BinaryFileData["mimeType"],
          created: Date.now(),
          lastRetrieved: Date.now(),
        });
      } catch {
        erroredFiles.set(id, true);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
}

/** `POST /api/pages/:id/files` — 원본 `saveFilesToFirebase` 대응 */
export async function saveFilesToServer({
  pageId,
  addedFiles,
}: {
  pageId: string;
  addedFiles: Map<FileId, BinaryFileData>;
}): Promise<{
  savedFiles: Map<FileId, BinaryFileData>;
  erroredFiles: Map<FileId, BinaryFileData>;
}> {
  const savedFiles = new Map<FileId, BinaryFileData>();
  const erroredFiles = new Map<FileId, BinaryFileData>();

  await Promise.all(
    [...addedFiles].map(async ([id, fileData]) => {
      try {
        const blob = dataUrlToBlob(String(fileData.dataURL));
        if (blob.size > FILE_UPLOAD_MAX_BYTES) {
          erroredFiles.set(id, fileData);
          return;
        }
        await api.uploadFile(pageId, id, blob.type || String(fileData.mimeType), blob);
        savedFiles.set(id, fileData);
      } catch {
        erroredFiles.set(id, fileData);
      }
    }),
  );

  return { savedFiles, erroredFiles };
}

/** 리사이즈본 파일 id (원본 id 를 그대로 두면 addFiles 가 내용을 갱신하지 않는다) */
export const resizedFileId = (id: string): string =>
  `${id}-r${MAX_IMAGE_DIMENSION}`.slice(0, 120);

/**
 * 장변 2048px 를 넘는 이미지를 업로드 전에 줄인다 (M1 규칙 유지).
 *
 * Excalidraw 의 `addFiles` 는 이미 있는 fileId 의 내용을 갱신하지 않으므로
 * 리사이즈본은 **새 fileId** 로 등록하고 이미지 요소가 그것을 가리키게 바꾼다.
 * 원본(큰 이미지)은 서버에 올리지 않는다 (씬에서 아무도 참조하지 않게 된다).
 *
 * @param ids 이번에 검사할 fileId 목록 (호출자가 중복 검사를 막는다)
 * @returns 씬이 바뀌었으면 true
 */
export async function normalizeOversizedImages(
  excalidrawAPI: ExcalidrawImperativeAPI,
  ids: readonly string[],
): Promise<boolean> {
  const files = excalidrawAPI.getFiles();
  const replacements = new Map<string, string>();

  for (const id of ids) {
    const file = files[id];
    if (!file?.dataURL) continue;
    try {
      const resized = await resizeDataUrlIfNeeded(String(file.dataURL));
      if (!resized.resized) continue;

      const nextId = resizedFileId(id);
      excalidrawAPI.addFiles([
        {
          ...file,
          id: nextId as FileId,
          dataURL: resized.dataUrl as BinaryFileData["dataURL"],
          mimeType: resized.mime as BinaryFileData["mimeType"],
          created: Date.now(),
        },
      ]);
      replacements.set(id, nextId);
    } catch {
      // 리사이즈에 실패하면 원본을 그대로 올린다.
    }
  }

  if (replacements.size === 0) return false;

  let changed = false;
  const next = excalidrawAPI.getSceneElementsIncludingDeleted().map((element) => {
    if (!isInitializedImageElement(element)) return element;
    const to = replacements.get(element.fileId);
    if (!to) return element;
    changed = true;
    return newElementWith(element, { fileId: to as FileId });
  });
  if (!changed) return false;

  excalidrawAPI.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  return true;
}

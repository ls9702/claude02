/**
 * 씬 영속화 — 업스트림 `excalidraw-app/data/firebase.ts` 를 대체한다.
 *
 * | 원본 (Firebase) | 우리 구현 |
 * |---|---|
 * | `saveToFirebase` | `PUT /api/pages/:id/scene` (서버가 요소 단위로 병합) |
 * | `loadFromFirebase` | `GET /api/pages/:id/scene` |
 * | `isSavedToFirebase` | 로컬 `getSceneVersion` 과 마지막 저장 버전 비교 |
 *
 * 원본은 방마다 암호화해 Firestore 에 넣지만, 우리 서버는 신뢰 대상이고
 * 접근 제어는 세션 멤버십으로 하므로 씬은 평문으로 저장한다.
 * (릴레이로 오가는 브로드캐스트는 원본과 똑같이 룸 키로 암호화한다.)
 */
import { getSceneVersion } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { api, type SceneSaveResult } from "../api";
import type { SyncableExcalidrawElement } from "./types";

/**
 * 마지막으로 서버에 반영된 씬 버전.
 * 원본의 `firebaseSceneVersionCache` 자리 — 저장 여부 판단에만 쓴다.
 */
export class SceneVersionCache {
  private version = -1;

  get(): number {
    return this.version;
  }

  set(version: number): void {
    this.version = version;
  }

  reset(): void {
    this.version = -1;
  }

  /** 원본 `isSavedToFirebase` 대응 */
  isSaved(elements: readonly OrderedExcalidrawElement[]): boolean {
    return this.version === getSceneVersion(elements);
  }
}

export const loadSceneFromServer = (pageId: string) => api.getScene(pageId);

export const saveSceneToServer = (
  pageId: string,
  elements: readonly SyncableExcalidrawElement[],
  appState: Record<string, unknown>,
  opts: { keepalive?: boolean } = {},
): Promise<SceneSaveResult> => api.saveScene(pageId, elements, appState, opts);

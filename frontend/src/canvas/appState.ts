/**
 * 서버에 저장하는 공유 appState 키 목록.
 *
 * ⚠️ 백엔드 `backend/src/scenes/reconcile.ts` 의 `SHARED_APP_STATE_KEYS` 와 **같은 목록**을 유지해야 한다.
 * (백엔드는 저장할 키를 이 목록으로 거르고, 프론트는 "저장이 필요한 변경인지" 판단에 쓴다.)
 *
 * 뷰포트(scrollX/scrollY/zoom)·선택 상태·툴 상태는 사용자마다 다르므로 공유하지 않는다.
 */
export const SHARED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "objectsSnapModeEnabled",
  "name",
] as const;

export type SharedAppStateKey = (typeof SHARED_APP_STATE_KEYS)[number];
export type SharedAppState = Partial<Record<SharedAppStateKey, unknown>>;

/** appState 에서 공유 키만 뽑는다. */
export function pickSharedAppState(appState: unknown): SharedAppState {
  if (!appState || typeof appState !== "object") return {};
  const source = appState as Record<string, unknown>;
  const out: SharedAppState = {};
  for (const key of SHARED_APP_STATE_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** 공유 키 기준 얕은 비교 (요소 변경 없이 배경색·그리드만 바뀐 경우를 잡아낸다). */
export function sharedAppStateEquals(a: SharedAppState, b: SharedAppState): boolean {
  for (const key of SHARED_APP_STATE_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

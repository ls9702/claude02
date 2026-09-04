/**
 * 씬 병합 (순수 함수).
 *
 * 여러 클라이언트가 각자 전체 씬을 주기적으로 저장하면 마지막 저장이 앞선 저장을
 * 덮어쓴다. 그래서 서버는 저장된 씬과 들어온 씬을 **요소 단위**로 병합한다.
 * 규칙은 Excalidraw 의 `reconcileElements` 와 동일하다.
 *
 *  - `id` 로 매칭한다.
 *  - 같은 id 가 양쪽에 있으면 `version` 이 큰 쪽을 채택한다.
 *  - `version` 이 같으면 `versionNonce` 가 **작은** 쪽을 채택한다 (결정적 타이브레이크).
 *  - 한쪽에만 있으면 그대로 포함한다.
 *  - `isDeleted` 요소도 다른 요소와 똑같이 버전 비교 대상이다 (삭제도 하나의 변경이다).
 *
 * 결과 순서(= z-order)는 들어온 씬의 순서를 우선하고,
 * 들어온 씬에 없는(= 그 사이 다른 사용자가 추가한) 요소를 뒤에 덧붙인다.
 */

export interface ReconcilableElement {
  id: string;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

const versionOf = (el: ReconcilableElement): number =>
  typeof el.version === "number" && Number.isFinite(el.version) ? el.version : 0;

const nonceOf = (el: ReconcilableElement): number =>
  typeof el.versionNonce === "number" && Number.isFinite(el.versionNonce)
    ? el.versionNonce
    : 0;

/**
 * 같은 id 를 가진 두 요소 중 승자를 고른다.
 * 무승부(버전·논스 동일)면 `stored` 를 유지해 저장 결과가 흔들리지 않게 한다.
 */
export function pickWinner(
  stored: ReconcilableElement,
  incoming: ReconcilableElement,
): ReconcilableElement {
  const sv = versionOf(stored);
  const iv = versionOf(incoming);
  if (iv > sv) return incoming;
  if (sv > iv) return stored;

  const sn = nonceOf(stored);
  const inc = nonceOf(incoming);
  if (inc < sn) return incoming;
  return stored;
}

export function reconcileElements(
  stored: readonly ReconcilableElement[],
  incoming: readonly ReconcilableElement[],
): ReconcilableElement[] {
  const storedById = new Map<string, ReconcilableElement>();
  for (const el of stored) {
    if (el && typeof el.id === "string") storedById.set(el.id, el);
  }

  const result: ReconcilableElement[] = [];
  const seen = new Set<string>();

  for (const el of incoming) {
    if (!el || typeof el.id !== "string") continue;
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    const existing = storedById.get(el.id);
    result.push(existing ? pickWinner(existing, el) : el);
  }

  for (const el of stored) {
    if (!el || typeof el.id !== "string") continue;
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    result.push(el);
  }

  return result;
}

/**
 * 병합 결과가 클라이언트가 보낸 씬과 다른지 (= 클라이언트에 되돌려 반영해야 하는지).
 * id 순서 + 요소 동일성(참조)이 모두 같아야 "같다"고 본다.
 */
export function differsFromIncoming(
  merged: readonly ReconcilableElement[],
  incoming: readonly ReconcilableElement[],
): boolean {
  if (merged.length !== incoming.length) return true;
  for (let i = 0; i < merged.length; i += 1) {
    const a = merged[i]!;
    const b = incoming[i]!;
    if (a === b) continue;
    if (a.id !== b.id) return true;
    if (versionOf(a) !== versionOf(b)) return true;
    if (nonceOf(a) !== nonceOf(b)) return true;
  }
  return false;
}

/**
 * 저장해도 되는 appState 키 화이트리스트.
 * 뷰포트(scrollX/scrollY/zoom)·선택 상태·툴 상태는 사용자마다 다르므로 저장하지 않는다.
 */
export const SHARED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "objectsSnapModeEnabled",
  "name",
] as const;

export type SharedAppState = Partial<Record<(typeof SHARED_APP_STATE_KEYS)[number], unknown>>;

export function pickSharedAppState(appState: unknown): SharedAppState {
  if (!appState || typeof appState !== "object") return {};
  const source = appState as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SHARED_APP_STATE_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as SharedAppState;
}

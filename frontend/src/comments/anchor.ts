/**
 * 댓글 핀의 앵커 계산 (순수 함수 — Excalidraw·DOM 에 의존하지 않는다).
 *
 * 규칙 (PLAN §2.5)
 * - `elementId` 가 있고 그 요소가 살아 있으면 핀 위치는 요소의 **우상단**(`x + width`, `y`) —
 *   요소를 옮기거나 크기를 바꾸면 핀이 따라간다.
 * - 요소가 삭제되었거나(`isDeleted`) 씬에 없으면 **고아 댓글**이다. 위치는
 *   (삭제된 요소가 아직 씬에 남아 있으면) 그 요소의 마지막 위치, 없으면 저장된 `x,y` 를 쓴다.
 * - `elementId` 가 없으면 저장된 좌표를 그대로 쓴다.
 */

/** 앵커 계산에 필요한 요소의 최소 형태 */
export interface AnchorElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
}

/** 앵커 계산에 필요한 댓글의 최소 형태 */
export interface AnchorComment {
  elementId: string | null;
  x: number;
  y: number;
}

export interface ScenePoint {
  sceneX: number;
  sceneY: number;
  /** 앵커 요소가 사라져 좌표로 고정된 댓글 */
  orphaned: boolean;
}

/** 요소 배열을 id → 요소 맵으로 (삭제된 요소도 포함한다 — 고아 판정에 쓴다). */
export function indexElements(elements: readonly AnchorElement[]): Map<string, AnchorElement> {
  const map = new Map<string, AnchorElement>();
  for (const element of elements) map.set(element.id, element);
  return map;
}

/** 요소의 앵커 지점 (우상단) */
export const elementAnchor = (element: AnchorElement): { sceneX: number; sceneY: number } => ({
  sceneX: element.x + element.width,
  sceneY: element.y,
});

/** 댓글의 현재 씬 좌표와 고아 여부 */
export function anchorScenePoint(
  comment: AnchorComment,
  elements: Map<string, AnchorElement>,
): ScenePoint {
  if (!comment.elementId) return { sceneX: comment.x, sceneY: comment.y, orphaned: false };

  const element = elements.get(comment.elementId);
  if (!element) return { sceneX: comment.x, sceneY: comment.y, orphaned: true };
  if (element.isDeleted) {
    // 삭제된 요소는 아직 씬에 남아 있다 — 그 마지막 위치가 "마지막으로 알려진 위치" 다.
    return { ...elementAnchor(element), orphaned: true };
  }
  return { ...elementAnchor(element), orphaned: false };
}

/**
 * 씬 좌표 위에 있는 요소 중 **가장 위(마지막에 그려진) 것**을 고른다.
 * 회전(`angle`)은 고려하지 않는다 — 축 정렬 bounding box 로만 판정한다.
 */
export function hitTestTopmost(
  elements: readonly AnchorElement[],
  sceneX: number,
  sceneY: number,
): AnchorElement | null {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];
    if (!element || element.isDeleted) continue;
    const left = Math.min(element.x, element.x + element.width);
    const right = Math.max(element.x, element.x + element.width);
    const top = Math.min(element.y, element.y + element.height);
    const bottom = Math.max(element.y, element.y + element.height);
    if (sceneX >= left && sceneX <= right && sceneY >= top && sceneY <= bottom) return element;
  }
  return null;
}

/** 저장된 좌표를 갱신해야 하는지 (고아로 바뀐 순간 한 번만 서버에 반영한다). */
export function needsOrphanCoordUpdate(
  comment: AnchorComment,
  point: ScenePoint,
  epsilon = 0.5,
): boolean {
  if (!point.orphaned || !comment.elementId) return false;
  return Math.abs(comment.x - point.sceneX) > epsilon || Math.abs(comment.y - point.sceneY) > epsilon;
}

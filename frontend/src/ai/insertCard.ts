/**
 * 카드 요소를 실제 씬에 넣는 얇은 층 (Excalidraw 를 실제로 부르는 유일한 AI 코드).
 *
 * `convertToExcalidrawElements` 가 스켈레톤을 정식 요소로 바꿔 주고(id·seed·version 부여),
 * `updateScene` 으로 기존 요소 뒤에 붙인다. 그 뒤는 평범한 요소라 협업 브로드캐스트와
 * 씬 저장이 기존 경로로 알아서 처리한다 — 여기서 서버를 부르지 않는다.
 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { MAX_CONTEXT_TEXT, truncate } from "./prompts";
import { CARD_WIDTH, buildCardElements, type BuildCardInput } from "./cardBuilder";

/** 선택 요소 옆에 카드를 놓을 때의 간격 */
const SELECTION_GAP = 40;

interface SceneElementLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  text?: string;
  isDeleted?: boolean;
}

/** 현재 선택된(삭제되지 않은) 요소들 */
function selectedElements(excalidrawAPI: ExcalidrawImperativeAPI): SceneElementLike[] {
  const selected = excalidrawAPI.getAppState().selectedElementIds ?? {};
  return (excalidrawAPI.getSceneElements() as unknown as SceneElementLike[]).filter(
    (element) => selected[element.id] && !element.isDeleted,
  );
}

/**
 * 선택한 텍스트 요소들의 글 (질문 프리필·컨텍스트용). 없으면 빈 문자열.
 * 여러 개를 골랐으면 줄바꿈으로 잇고 컨텍스트 상한까지만 쓴다.
 */
export function selectedText(excalidrawAPI: ExcalidrawImperativeAPI): string {
  const texts = selectedElements(excalidrawAPI)
    .filter((element) => element.type === "text" && typeof element.text === "string")
    .map((element) => (element.text ?? "").trim())
    .filter(Boolean);
  return truncate(texts.join("\n"), MAX_CONTEXT_TEXT);
}

/**
 * 카드를 놓을 씬 좌표(중심).
 * 선택한 요소가 있으면 그 **오른쪽**, 없으면 지금 보이는 화면의 한가운데.
 */
export function cardCenter(excalidrawAPI: ExcalidrawImperativeAPI): { x: number; y: number } {
  const appState = excalidrawAPI.getAppState();
  const selection = selectedElements(excalidrawAPI);
  if (selection.length > 0) {
    const right = Math.max(...selection.map((element) => element.x + element.width));
    const top = Math.min(...selection.map((element) => element.y));
    const bottom = Math.max(...selection.map((element) => element.y + element.height));
    return { x: right + SELECTION_GAP + CARD_WIDTH / 2, y: (top + bottom) / 2 };
  }
  const view = {
    zoom: appState.zoom,
    offsetLeft: appState.offsetLeft,
    offsetTop: appState.offsetTop,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
  };
  const scene = viewportCoordsToSceneCoords(
    {
      clientX: appState.offsetLeft + appState.width / 2,
      clientY: appState.offsetTop + appState.height / 2,
    },
    view,
  );
  return { x: scene.x, y: scene.y };
}

export interface InsertedCard {
  groupId: string;
  elementIds: string[];
}

/**
 * 카드를 만들어 씬에 넣고 **새 요소를 선택 상태**로 둔다.
 * `captureUpdate: IMMEDIATELY` — 되돌리기(undo) 한 번으로 카드가 통째로 사라지게 한다.
 */
export function insertAiCard(
  excalidrawAPI: ExcalidrawImperativeAPI,
  input: Omit<BuildCardInput, "center"> & { center?: { x: number; y: number } },
): InsertedCard {
  const center = input.center ?? cardCenter(excalidrawAPI);
  const card = buildCardElements({ ...input, center });
  const created = convertToExcalidrawElements(
    card.elements as unknown as ExcalidrawElementSkeleton[],
  );

  const selectedElementIds: Record<string, true> = {};
  for (const element of created) selectedElementIds[element.id] = true;

  excalidrawAPI.updateScene({
    elements: [...excalidrawAPI.getSceneElementsIncludingDeleted(), ...created],
    appState: { selectedElementIds },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return { groupId: card.groupId, elementIds: created.map((element) => element.id) };
}

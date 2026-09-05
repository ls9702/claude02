/**
 * 소켓으로 오가는 페이로드 타입.
 *
 * 출처: excalidraw.com 앱의 `excalidraw-app/data/index.ts` (MIT).
 * 프로토콜을 바꾸지 않으므로 타입도 원본 그대로다.
 */
import { isInvisiblySmallElement } from "@excalidraw/excalidraw";
import type { SceneBounds } from "@excalidraw/excalidraw/element/bounds";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { UserIdleState } from "@excalidraw/excalidraw";
import type { AppState, SocketId } from "@excalidraw/excalidraw/types";
import type { MakeBrand } from "@excalidraw/excalidraw/utility-types";
import { DELETED_ELEMENT_TIMEOUT, type WS_SUBTYPES } from "./constants";

export type SyncableExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"SyncableExcalidrawElement">;

export const isSyncableElement = (
  element: OrderedExcalidrawElement,
): element is SyncableExcalidrawElement => {
  if (element.isDeleted) {
    if (element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT) {
      return true;
    }
    return false;
  }
  return !isInvisiblySmallElement(element);
};

export const getSyncableElements = (
  elements: readonly OrderedExcalidrawElement[],
): SyncableExcalidrawElement[] =>
  elements.filter((element) => isSyncableElement(element)) as SyncableExcalidrawElement[];

export type SocketUpdateDataSource = {
  INVALID_RESPONSE: {
    type: WS_SUBTYPES.INVALID_RESPONSE;
  };
  SCENE_INIT: {
    type: WS_SUBTYPES.INIT;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  SCENE_UPDATE: {
    type: WS_SUBTYPES.UPDATE;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  MOUSE_LOCATION: {
    type: WS_SUBTYPES.MOUSE_LOCATION;
    payload: {
      socketId: SocketId;
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      selectedElementIds: AppState["selectedElementIds"];
      username: string;
    };
  };
  USER_VISIBLE_SCENE_BOUNDS: {
    type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS;
    payload: {
      socketId: SocketId;
      username: string;
      sceneBounds: SceneBounds;
    };
  };
  IDLE_STATUS: {
    type: WS_SUBTYPES.IDLE_STATUS;
    payload: {
      socketId: SocketId;
      userState: UserIdleState;
      username: string;
    };
  };
};

export type SocketUpdateDataIncoming = SocketUpdateDataSource[keyof SocketUpdateDataSource];

export type SocketUpdateData = SocketUpdateDataSource[keyof SocketUpdateDataSource] & {
  _brand: "socketUpdateData";
};

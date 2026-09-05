/**
 * 브로드캐스트 페이로드 검증.
 *
 * 릴레이(룸)는 무상태라 페이로드를 검사하지 않는다. 룸 키를 아는 참가자라면
 * 누구든(버그가 있는 클라이언트 포함) 임의의 JSON 을 보낼 수 있고, 그것이 곧바로
 * `restoreElements`/`reconcileElements` 로 들어가면 다른 참가자 탭에서
 * 처리되지 않은 예외가 난다(`elements: "x"` → `.reduce is not a function` 등).
 *
 * 그래서 복호화 결과를 이 파일에서 한 번 걸러 낸다. 형태가 맞지 않으면 `null` 을
 * 돌려주고 호출부는 그 메시지를 조용히 버린다.
 */
import { WS_SUBTYPES } from "./constants";
import type { SocketUpdateDataIncoming } from "./types";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 요소 배열: 배열이고, 각 원소가 객체이며 `id` 가 문자열이어야 한다. */
export function isValidElements(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((el) => isObject(el) && typeof (el as { id?: unknown }).id === "string")
  );
}

const isPointer = (value: unknown): boolean =>
  isObject(value) && typeof value.x === "number" && typeof value.y === "number";

const isSceneBounds = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number");

/**
 * 복호화된 페이로드를 검증한다.
 * 알 수 없는 타입이거나 형태가 어긋나면 `null`.
 */
export function validateBroadcastPayload(data: unknown): SocketUpdateDataIncoming | null {
  if (!isObject(data)) return null;
  const { type } = data;
  if (typeof type !== "string") return null;

  switch (type) {
    case WS_SUBTYPES.INVALID_RESPONSE:
      return data as unknown as SocketUpdateDataIncoming;

    case WS_SUBTYPES.INIT:
    case WS_SUBTYPES.UPDATE: {
      const payload = data.payload;
      if (!isObject(payload)) return null;
      if (!isValidElements(payload.elements)) return null;
      return data as unknown as SocketUpdateDataIncoming;
    }

    case WS_SUBTYPES.MOUSE_LOCATION: {
      const payload = data.payload;
      if (!isObject(payload)) return null;
      if (typeof payload.socketId !== "string") return null;
      if (!isPointer(payload.pointer)) return null;
      if (payload.username !== undefined && typeof payload.username !== "string") return null;
      return data as unknown as SocketUpdateDataIncoming;
    }

    case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
      const payload = data.payload;
      if (!isObject(payload)) return null;
      if (typeof payload.socketId !== "string") return null;
      if (!isSceneBounds(payload.sceneBounds)) return null;
      return data as unknown as SocketUpdateDataIncoming;
    }

    case WS_SUBTYPES.IDLE_STATUS: {
      const payload = data.payload;
      if (!isObject(payload)) return null;
      if (typeof payload.socketId !== "string") return null;
      if (typeof payload.userState !== "string") return null;
      return data as unknown as SocketUpdateDataIncoming;
    }

    default:
      return null;
  }
}

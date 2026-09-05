import { describe, expect, it } from "vitest";
import { WS_SUBTYPES } from "./constants";
import { isValidElements, validateBroadcastPayload } from "./payload";

describe("validateBroadcastPayload", () => {
  it("정상적인 SCENE_UPDATE 를 통과시킨다", () => {
    const data = {
      type: WS_SUBTYPES.UPDATE,
      payload: { elements: [{ id: "a", type: "rectangle", version: 1 }] },
    };
    expect(validateBroadcastPayload(data)).toBe(data);
  });

  it("정상적인 SCENE_INIT 을 통과시킨다", () => {
    const data = { type: WS_SUBTYPES.INIT, payload: { elements: [] } };
    expect(validateBroadcastPayload(data)).toBe(data);
  });

  // QA 리포트(m2-security 발견 2-B)에서 실제로 예외를 일으킨 4종
  it.each([
    ["elements 가 배열이 아님", { type: WS_SUBTYPES.UPDATE, payload: { elements: "not-an-array" } }],
    [
      "elements 안에 null·원시값",
      { type: WS_SUBTYPES.UPDATE, payload: { elements: [{ id: "x" }, null, 42, "str"] } },
    ],
    ["payload 없음", { type: WS_SUBTYPES.UPDATE }],
    ["elements 없음", { type: WS_SUBTYPES.INIT, payload: {} }],
  ])("잘못된 페이로드를 버린다 — %s", (_label, data) => {
    expect(validateBroadcastPayload(data)).toBeNull();
  });

  it("id 없는 요소가 섞이면 버린다", () => {
    const data = { type: WS_SUBTYPES.UPDATE, payload: { elements: [{ type: "rectangle" }] } };
    expect(validateBroadcastPayload(data)).toBeNull();
  });

  it.each([[null], [undefined], [42], ["문자열"], [[]], [{}], [{ type: 7 }], [{ type: "NOPE" }]])(
    "형태가 아예 다른 값(%p)은 null 이다",
    (data) => {
      expect(validateBroadcastPayload(data)).toBeNull();
    },
  );

  it("INVALID_RESPONSE 는 그대로 통과한다 (복호화 실패 표시)", () => {
    const data = { type: WS_SUBTYPES.INVALID_RESPONSE };
    expect(validateBroadcastPayload(data)).toBe(data);
  });

  describe("MOUSE_LOCATION", () => {
    it("정상 페이로드를 통과시킨다", () => {
      const data = {
        type: WS_SUBTYPES.MOUSE_LOCATION,
        payload: {
          socketId: "s1",
          pointer: { x: 1, y: 2, tool: "pointer" },
          button: "up",
          username: "alice",
          selectedElementIds: {},
        },
      };
      expect(validateBroadcastPayload(data)).toBe(data);
    });

    it.each([
      ["socketId 누락", { pointer: { x: 1, y: 2 } }],
      ["pointer 가 객체가 아님", { socketId: "s1", pointer: "nope" }],
      ["pointer 좌표가 숫자가 아님", { socketId: "s1", pointer: { x: "1", y: 2 } }],
      ["username 이 문자열이 아님", { socketId: "s1", pointer: { x: 1, y: 2 }, username: 3 }],
    ])("잘못된 페이로드를 버린다 — %s", (_label, payload) => {
      expect(validateBroadcastPayload({ type: WS_SUBTYPES.MOUSE_LOCATION, payload })).toBeNull();
    });
  });

  describe("USER_VISIBLE_SCENE_BOUNDS", () => {
    it("숫자 4개짜리 bounds 만 통과시킨다", () => {
      const ok = {
        type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
        payload: { socketId: "s1", sceneBounds: [0, 0, 10, 10] },
      };
      expect(validateBroadcastPayload(ok)).toBe(ok);
      expect(
        validateBroadcastPayload({
          type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
          payload: { socketId: "s1", sceneBounds: [0, 0, 10] },
        }),
      ).toBeNull();
    });
  });

  describe("IDLE_STATUS", () => {
    it("userState 가 문자열이어야 한다", () => {
      const ok = {
        type: WS_SUBTYPES.IDLE_STATUS,
        payload: { socketId: "s1", userState: "active", username: "alice" },
      };
      expect(validateBroadcastPayload(ok)).toBe(ok);
      expect(
        validateBroadcastPayload({
          type: WS_SUBTYPES.IDLE_STATUS,
          payload: { socketId: "s1", userState: 1 },
        }),
      ).toBeNull();
    });
  });
});

describe("isValidElements", () => {
  it("빈 배열은 유효하다", () => {
    expect(isValidElements([])).toBe(true);
  });

  it("id 가 문자열인 객체 배열만 유효하다", () => {
    expect(isValidElements([{ id: "a" }])).toBe(true);
    expect(isValidElements([{ id: 1 }])).toBe(false);
    expect(isValidElements([[]])).toBe(false);
    expect(isValidElements(null)).toBe(false);
  });
});

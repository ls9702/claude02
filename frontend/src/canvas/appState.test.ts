import { describe, expect, it } from "vitest";
import { SHARED_APP_STATE_KEYS, pickSharedAppState, sharedAppStateEquals } from "./appState";

describe("공유 appState", () => {
  it("백엔드와 같은 키 목록을 쓴다 (reconcile.ts 의 SHARED_APP_STATE_KEYS)", () => {
    // 백엔드 backend/src/scenes/reconcile.ts 와 반드시 같아야 한다.
    expect([...SHARED_APP_STATE_KEYS]).toEqual([
      "viewBackgroundColor",
      "gridSize",
      "gridStep",
      "gridModeEnabled",
      "objectsSnapModeEnabled",
      "name",
    ]);
  });

  it("공유 키만 뽑고 뷰포트·선택 상태는 버린다", () => {
    const picked = pickSharedAppState({
      viewBackgroundColor: "#7b3de7",
      gridSize: 20,
      scrollX: 100,
      scrollY: -40,
      zoom: { value: 2 },
      selectedElementIds: { a: true },
    });
    expect(picked).toEqual({ viewBackgroundColor: "#7b3de7", gridSize: 20 });
    expect(pickSharedAppState(null)).toEqual({});
    expect(pickSharedAppState(undefined)).toEqual({});
  });

  it("배경색만 바뀌어도 다르다고 판단한다 (요소 변경 없이 저장이 걸리도록)", () => {
    const before = pickSharedAppState({ viewBackgroundColor: "#ffffff", gridModeEnabled: false });
    const after = pickSharedAppState({ viewBackgroundColor: "#7b3de7", gridModeEnabled: false });
    expect(sharedAppStateEquals(before, before)).toBe(true);
    expect(sharedAppStateEquals(before, after)).toBe(false);
  });

  it("공유하지 않는 키만 바뀌면 같다고 판단한다", () => {
    const a = pickSharedAppState({ viewBackgroundColor: "#ffffff", scrollX: 0 });
    const b = pickSharedAppState({ viewBackgroundColor: "#ffffff", scrollX: 999 });
    expect(sharedAppStateEquals(a, b)).toBe(true);
  });

  it("그리드 설정 변경도 감지한다", () => {
    const a = pickSharedAppState({ gridModeEnabled: false, gridSize: 20, gridStep: 5 });
    expect(sharedAppStateEquals(a, pickSharedAppState({ gridModeEnabled: true, gridSize: 20, gridStep: 5 }))).toBe(
      false,
    );
    expect(sharedAppStateEquals(a, pickSharedAppState({ gridModeEnabled: false, gridSize: 40, gridStep: 5 }))).toBe(
      false,
    );
    expect(sharedAppStateEquals(a, pickSharedAppState({ gridModeEnabled: false, gridSize: 20, gridStep: 10 }))).toBe(
      false,
    );
  });
});

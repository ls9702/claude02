import { describe, expect, it } from "vitest";
import { PIN_CLUSTER_RADIUS_PX, PIN_FAN_STEP_PX, fanOutPins } from "./cluster";

const pin = (id: string, left: number, top: number) => ({ id, left, top });

describe("fanOutPins", () => {
  it("겹치지 않는 핀은 그대로 둔다", () => {
    const result = fanOutPins([pin("a", 100, 100), pin("b", 400, 220)]);
    expect(result).toEqual([
      { id: "a", left: 100, top: 100, clusterIndex: 0, clusterSize: 1 },
      { id: "b", left: 400, top: 220, clusterIndex: 0, clusterSize: 1 },
    ]);
  });

  it("정확히 같은 위치의 두 핀을 가로로 펼친다 (생성 순서대로)", () => {
    const result = fanOutPins([pin("first", 100, 100), pin("second", 100, 100)]);
    expect(result[0]).toMatchObject({ id: "first", left: 100, top: 100, clusterIndex: 0 });
    expect(result[1]).toMatchObject({
      id: "second",
      left: 100 + PIN_FAN_STEP_PX,
      top: 100,
      clusterIndex: 1,
    });
    expect(result.every((p) => p.clusterSize === 2)).toBe(true);
  });

  it("겹침 반경 안이면 한 묶음, 밖이면 따로다", () => {
    const near = fanOutPins([pin("a", 100, 100), pin("b", 100 + PIN_CLUSTER_RADIUS_PX, 100)]);
    expect(near[1]!.clusterIndex).toBe(1);
    // 묶음의 기준점은 처음 만난 핀이다 — 두 번째 핀도 그 기준에서 한 칸 밀린다.
    expect(near[1]!.left).toBe(100 + PIN_FAN_STEP_PX);
    expect(near[1]!.top).toBe(100);

    const far = fanOutPins([pin("a", 100, 100), pin("b", 100 + PIN_CLUSTER_RADIUS_PX + 1, 100)]);
    expect(far[1]).toMatchObject({ clusterIndex: 0, clusterSize: 1, left: 113 });
  });

  it("세로로 겹쳐도 한 묶음이다", () => {
    const result = fanOutPins([pin("a", 100, 100), pin("b", 100, 108)]);
    expect(result[1]).toMatchObject({ clusterIndex: 1, clusterSize: 2, left: 126, top: 100 });
  });

  it("셋 이상은 한 칸씩 이어서 밀리고 서로 겹치지 않는다", () => {
    const result = fanOutPins([pin("a", 0, 0), pin("b", 5, 5), pin("c", 10, 2)]);
    expect(result.map((p) => p.left)).toEqual([0, PIN_FAN_STEP_PX, PIN_FAN_STEP_PX * 2]);
    expect(result.map((p) => p.top)).toEqual([0, 0, 0]);
    expect(result.map((p) => p.clusterSize)).toEqual([3, 3, 3]);
    // 한 칸 간격이 핀 지름 이상이어야 아래 핀이 가려지지 않는다.
    expect(PIN_FAN_STEP_PX).toBeGreaterThanOrEqual(26);
  });

  it("겹침 판정은 원래 위치로 한다 (밀린 핀이 사슬처럼 이어 밀리지 않는다)", () => {
    // b 는 a 와 겹쳐 26px 밀린다. c 는 밀린 b 의 자리(26)와 가깝지만 원래 위치(60)는 멀다.
    const result = fanOutPins([pin("a", 0, 0), pin("b", 4, 0), pin("c", 60, 0)]);
    expect(result[2]).toMatchObject({ id: "c", left: 60, clusterIndex: 0, clusterSize: 1 });
  });

  it("여러 묶음이 섞여 있어도 각각 독립적으로 펼친다", () => {
    const result = fanOutPins([
      pin("a1", 0, 0),
      pin("b1", 300, 300),
      pin("a2", 3, 3),
      pin("b2", 305, 300),
    ]);
    expect(result.map((p) => [p.left, p.top])).toEqual([
      [0, 0],
      [300, 300],
      [PIN_FAN_STEP_PX, 0],
      [300 + PIN_FAN_STEP_PX, 300],
    ]);
  });

  it("반경·간격을 바꿔 부를 수 있다", () => {
    const result = fanOutPins([pin("a", 0, 0), pin("b", 30, 0)], { radius: 40, step: 14 });
    expect(result[1]).toMatchObject({ left: 14, clusterIndex: 1, clusterSize: 2 });
  });

  it("빈 목록도 안전하다", () => {
    expect(fanOutPins([])).toEqual([]);
  });

  it("원래 속성은 그대로 남는다", () => {
    const result = fanOutPins([{ id: "a", left: 0, top: 0, body: "안녕" }]);
    expect(result[0]!.body).toBe("안녕");
  });
});

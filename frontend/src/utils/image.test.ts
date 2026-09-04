import { describe, expect, it } from "vitest";
import {
  computeResizedSize,
  MAX_IMAGE_DIMENSION,
  mimeFromDataUrl,
  outputMimeFor,
} from "./image";

describe("computeResizedSize", () => {
  it("장변이 한도 이하면 리사이즈하지 않는다", () => {
    expect(computeResizedSize(800, 600)).toBeNull();
    expect(computeResizedSize(MAX_IMAGE_DIMENSION, 100)).toBeNull();
  });

  it("가로가 긴 이미지는 가로를 한도에 맞춘다", () => {
    expect(computeResizedSize(4096, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(computeResizedSize(3000, 1000)).toEqual({ width: 2048, height: 683 });
  });

  it("세로가 긴 이미지는 세로를 한도에 맞춘다", () => {
    expect(computeResizedSize(1000, 4000)).toEqual({ width: 512, height: 2048 });
  });

  it("비율을 유지한다", () => {
    const result = computeResizedSize(3000, 1500)!;
    expect(result.width / result.height).toBeCloseTo(2, 2);
  });

  it("max 를 바꿀 수 있다", () => {
    expect(computeResizedSize(1000, 500, 100)).toEqual({ width: 100, height: 50 });
  });

  it("아주 얇은 이미지도 최소 1px 를 유지한다", () => {
    expect(computeResizedSize(10000, 1)).toEqual({ width: 2048, height: 1 });
  });

  it("잘못된 크기는 null", () => {
    expect(computeResizedSize(0, 100)).toBeNull();
    expect(computeResizedSize(Number.NaN, 100)).toBeNull();
    expect(computeResizedSize(-5, -5)).toBeNull();
  });
});

describe("mimeFromDataUrl", () => {
  it("dataURL 에서 mime 을 뽑는다", () => {
    expect(mimeFromDataUrl("data:image/jpeg;base64,AAAA")).toBe("image/jpeg");
    expect(mimeFromDataUrl("data:image/svg+xml,%3Csvg/%3E")).toBe("image/svg+xml");
  });

  it("알 수 없으면 image/png", () => {
    expect(mimeFromDataUrl("nonsense")).toBe("image/png");
  });
});

describe("outputMimeFor", () => {
  it("JPEG 은 JPEG, 나머지는 PNG 로 유지한다", () => {
    expect(outputMimeFor("image/jpeg")).toBe("image/jpeg");
    expect(outputMimeFor("image/png")).toBe("image/png");
    expect(outputMimeFor("image/webp")).toBe("image/png");
  });
});

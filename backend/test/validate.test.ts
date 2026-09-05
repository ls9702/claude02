import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { josa, requireString, withEulReul, withIGa } from "../src/validate.js";

describe("한국어 조사 처리", () => {
  it("받침 유무로 을/를, 이/가를 고른다", () => {
    expect(withEulReul("세션 이름")).toBe("세션 이름을");
    expect(withEulReul("페이지 종류")).toBe("페이지 종류를");
    expect(withEulReul("비밀번호")).toBe("비밀번호를");
    expect(withIGa("세션 이름")).toBe("세션 이름이");
    expect(withIGa("페이지 종류")).toBe("페이지 종류가");
    expect(josa("아이디", "을", "를")).toBe("를");
    // 한글이 아닌 라벨은 받침 없는 형태를 쓴다.
    expect(withEulReul("id")).toBe("id를");
  });

  it("검증 메시지에 을(를)/이(가) 병기가 남아 있지 않다", () => {
    const missing = (): unknown => requireString({}, "name", "세션 이름");
    expect(missing).toThrow(ApiError);
    expect(missing).toThrow("세션 이름을 입력해 주세요.");

    const tooLong = (): unknown =>
      requireString({ name: "가".repeat(20) }, "name", "세션 이름", { max: 10 });
    expect(tooLong).toThrow("세션 이름이 너무 깁니다. (최대 10자)");

    for (const label of ["아이디", "비밀번호", "페이지 종류"]) {
      let message = "";
      try {
        requireString({}, "x", label);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toContain("을(를)");
      expect(message).not.toContain("이(가)");
    }
  });
});

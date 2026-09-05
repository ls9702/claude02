import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { collabBadge, collabNotice, saveErrorMessage } from "./status";

describe("collabBadge", () => {
  it("연결되어 있으면 접속자 수를 보여 준다", () => {
    expect(collabBadge({ connection: "connected", collaboratorCount: 2 })).toEqual({
      testId: "collab-count",
      text: "접속 2명",
      title: "이 페이지에 접속한 사람",
    });
  });

  it("끊기면 접속자 수 대신 '재연결 중…' 을 보여 준다", () => {
    // 룸이 죽어 있는데 마지막 접속자 수를 계속 보여 주면 안 된다 (m2-collab §8).
    const badge = collabBadge({ connection: "reconnecting", collaboratorCount: 2 });
    expect(badge?.testId).toBe("collab-reconnecting");
    expect(badge?.text).toBe("재연결 중…");
  });

  it("잠긴 세션은 릴레이를 쓰지 않으므로 배지를 숨긴다", () => {
    expect(collabBadge({ connection: "locked", collaboratorCount: 3 })).toBeNull();
  });

  it("접속자가 없으면 배지가 없다", () => {
    expect(collabBadge({ connection: "idle", collaboratorCount: 0 })).toBeNull();
  });
});

describe("collabNotice", () => {
  it("재연결 중에는 저장이 계속된다고 알린다", () => {
    expect(collabNotice("reconnecting")).toContain("변경 내용은 계속 저장됩니다");
  });

  it("잠긴 세션에는 실시간 협업을 쓰지 않는다고 알린다", () => {
    expect(collabNotice("locked")).toContain("실시간 협업을 사용하지 않습니다");
  });

  it("정상 상태에는 배너가 없다", () => {
    expect(collabNotice("connected")).toBeNull();
    expect(collabNotice("idle")).toBeNull();
  });
});

describe("saveErrorMessage", () => {
  it("잠긴 세션(403)은 읽기 전용이라고 알린다", () => {
    expect(saveErrorMessage(new ApiError(403, "session_locked", "잠긴 세션은 읽기 전용입니다."))).toBe(
      "잠긴 세션이라 저장할 수 없습니다. (읽기 전용)",
    );
  });

  /**
   * 회귀: 통합 디버깅 리포트 [높음] 1 —
   * 관리자가 페이지를 지운 뒤의 404 를 "연결을 확인해 주세요" 로 오인해 안내했다.
   */
  it("페이지가 삭제되어(404) 실패하면 연결 문제가 아니라 삭제라고 알린다", () => {
    const message = saveErrorMessage(new ApiError(404, "not_found", "페이지를 찾을 수 없습니다."));
    expect(message).toContain("삭제되었습니다");
    expect(message).not.toContain("연결을 확인해 주세요");
  });

  it("그 밖의 실패는 연결 확인을 안내한다", () => {
    expect(saveErrorMessage(new ApiError(500, "internal_error", "서버 오류"))).toContain(
      "연결을 확인해 주세요",
    );
    expect(saveErrorMessage(new Error("네트워크"))).toContain("연결을 확인해 주세요");
    expect(saveErrorMessage(undefined)).toContain("연결을 확인해 주세요");
  });
});

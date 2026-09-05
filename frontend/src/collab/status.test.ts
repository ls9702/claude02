import { describe, expect, it } from "vitest";
import { collabBadge, collabNotice } from "./status";

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

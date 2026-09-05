/**
 * 협업 연결 상태 → 화면 문구.
 *
 * 배지·배너 문구를 한곳에 모아 두면 UI 컴포넌트를 띄우지 않고도 규칙을 테스트할 수 있다.
 */
import { ApiError } from "../api";

export type CollabConnection =
  /** 아직 룸에 붙기 전 (또는 룸을 쓰지 않는 상태) */
  | "idle"
  /** 릴레이에 연결됨 */
  | "connected"
  /** 소켓이 끊겨 재연결 중 — 저장 경로는 살아 있다 */
  | "reconnecting"
  /** 세션이 잠겨 릴레이를 아예 쓰지 않는다 */
  | "locked";

export interface CollabBadge {
  testId: string;
  text: string;
  title: string;
}

export interface CollabStatusInput {
  connection: CollabConnection;
  /** 자기 자신을 포함한 룸 접속자 수 */
  collaboratorCount: number;
}

/** 상단 바 배지 — 없으면 `null`. */
export function collabBadge({ connection, collaboratorCount }: CollabStatusInput): CollabBadge | null {
  if (connection === "reconnecting") {
    return {
      testId: "collab-reconnecting",
      text: "재연결 중…",
      title: "실시간 협업 연결이 끊겼습니다. 다시 연결하는 중입니다.",
    };
  }
  // 잠긴 세션은 릴레이를 쓰지 않으므로 접속자 수를 보여 주지 않는다.
  if (connection === "locked") return null;
  if (collaboratorCount > 0) {
    return {
      testId: "collab-count",
      text: `접속 ${collaboratorCount}명`,
      title: "이 페이지에 접속한 사람",
    };
  }
  return null;
}

/** 캔버스 위 안내 배너 문구 — 없으면 `null`. */
export function collabNotice(connection: CollabConnection): string | null {
  if (connection === "reconnecting") {
    return "실시간 협업 연결이 끊겼습니다. 다시 연결하는 중입니다. 변경 내용은 계속 저장됩니다.";
  }
  if (connection === "locked") {
    return "잠긴 세션이라 실시간 협업을 사용하지 않습니다. 최신 내용은 주기적으로 새로 고쳐집니다.";
  }
  return null;
}

/**
 * 씬 저장(`PUT /api/pages/:id/scene`)이 실패했을 때의 배너 문구.
 *
 * 예전에는 403 만 따로 보고 나머지는 전부 "연결을 확인해 주세요" 였다. 그런데 관리자가
 * 페이지를 지운 뒤에는 404 가 계속 나기 때문에, 접속자는 진짜 원인(페이지가 없어졌다)을
 * 모른 채 "연결 문제" 라는 오탐만 반복해서 봤다 (통합 디버깅 리포트 [높음] 1).
 */
export function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "잠긴 세션이라 저장할 수 없습니다. (읽기 전용)";
    if (error.status === 404) return "이 페이지가 삭제되었습니다. 변경 내용은 저장되지 않습니다.";
  }
  return "변경 내용을 저장하지 못했습니다. 연결을 확인해 주세요.";
}

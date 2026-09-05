/**
 * 세션 이벤트 WebSocket 레지스트리 (`/ws/session/:sessionId`).
 *
 * 댓글(`comments/sockets.ts`)·시트(`sheets/sockets.ts`) 레지스트리와 같은 구조다:
 * **세션별**(브로드캐스트) + **사용자별**(권한 회수 시 강제 종료) 이중 색인.
 *
 * 다른 점은 구독 단위가 페이지가 아니라 **세션**이라는 것이다. 세션 화면(탭 바)은
 * 페이지 목록·세션 이름·잠금 상태를 화면에 들고 있는데, 그것들은 다른 사람이
 * 언제든 바꿀 수 있다(관리자 삭제·잠금, 다른 멤버의 페이지 추가). 지금까지는
 * 마운트 시 1회 로드가 전부라, 관리자가 보고 있던 페이지를 지워도 화면은 그대로
 * 남아 저장 실패만 반복됐다. 이 채널이 그 변화를 밀어 준다.
 *
 * 서버→클라 단방향이다. 클라이언트가 보내는 메시지는 무시한다.
 */

/** 레지스트리가 쓰는 소켓의 최소 형태 (`ws` 의 WebSocket 이 만족한다) */
export interface BroadcastSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** `ws` 의 `WebSocket.OPEN` */
const OPEN = 1;

export type SessionEventType =
  | "page.created"
  | "page.updated"
  | "page.deleted"
  | "pages.reordered"
  | "session.updated"
  | "session.deleted"
  | "member.removed";

export interface SessionEvent {
  type: SessionEventType;
  payload: unknown;
}

interface Entry {
  sessionId: string;
  userId: string;
  socket: BroadcastSocket;
}

export class SessionSocketRegistry {
  private bySession = new Map<string, Set<Entry>>();
  private byUser = new Map<string, Set<Entry>>();

  /** 구독을 등록하고, 소켓이 닫힐 때 호출할 해제 함수를 돌려준다. */
  add(sessionId: string, userId: string, socket: BroadcastSocket): () => void {
    const entry: Entry = { sessionId, userId, socket };
    addTo(this.bySession, sessionId, entry);
    addTo(this.byUser, userId, entry);
    return () => {
      removeFrom(this.bySession, sessionId, entry);
      removeFrom(this.byUser, userId, entry);
    };
  }

  /** 같은 세션을 보고 있는 모든 소켓에 이벤트를 보낸다 (발신자 포함). 보낸 수를 돌려준다. */
  broadcast(sessionId: string, event: SessionEvent): number {
    const entries = this.bySession.get(sessionId);
    if (!entries) return 0;
    const data = JSON.stringify(event);
    let sent = 0;
    for (const entry of entries) {
      if (entry.socket.readyState !== OPEN) continue;
      try {
        entry.socket.send(data);
        sent += 1;
      } catch {
        // 끊기는 중인 소켓은 무시한다 — close 핸들러가 정리한다.
      }
    }
    return sent;
  }

  /**
   * 한 세션의 열린 소켓을 모두 끊는다 (세션 삭제).
   *
   * ⚠️ 안내 이벤트를 먼저 broadcast 한 **뒤에** 부른다 — `send()` 로 넣은 프레임은
   * 이미 소켓 버퍼에 들어가 있어서 close 프레임보다 앞서 나간다.
   */
  closeForSession(sessionId: string): number {
    return this.closeAll(this.bySession.get(sessionId));
  }

  /** 한 사용자의 열린 세션 소켓을 모두 끊는다 (사용자 삭제·비밀번호 재설정·로그아웃). */
  closeForUser(userId: string): number {
    return this.closeAll(this.byUser.get(userId));
  }

  /** 한 세션에서 한 사용자의 소켓만 끊는다 (그 세션의 멤버 해제). */
  closeForSessionUser(sessionId: string, userId: string): number {
    const entries = this.byUser.get(userId);
    if (!entries) return 0;
    return this.closeAll(new Set([...entries].filter((e) => e.sessionId === sessionId)));
  }

  private closeAll(entries: Set<Entry> | undefined): number {
    if (!entries) return 0;
    let closed = 0;
    for (const entry of [...entries]) {
      try {
        // 1008 (policy violation) — 클라이언트는 재접속을 시도하고 그때 인증·권한에서 걸린다.
        entry.socket.close(1008, "revoked");
      } catch {
        // 이미 닫힌 소켓은 무시한다.
      }
      removeFrom(this.bySession, entry.sessionId, entry);
      removeFrom(this.byUser, entry.userId, entry);
      closed += 1;
    }
    return closed;
  }

  /** 테스트·진단용 */
  countForSession(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  /** 테스트·진단용 */
  countForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

function addTo(map: Map<string, Set<Entry>>, key: string, entry: Entry): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(entry);
}

function removeFrom(map: Map<string, Set<Entry>>, key: string, entry: Entry): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) map.delete(key);
}

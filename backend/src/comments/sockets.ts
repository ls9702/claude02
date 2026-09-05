/**
 * 댓글 WebSocket 레지스트리.
 *
 * `/ws/comments/:pageId` 로 붙은 소켓을 **페이지별**(브로드캐스트용)과
 * **사용자별**(권한 회수 시 강제 종료용)로 동시에 색인한다.
 *
 * 협업 릴레이(`collab/sockets.ts`)와 달리 여기서는 소켓이 어떤 페이지에 붙었는지
 * 서버가 알고 있다 — 구독 대상이 URL 에 들어 있기 때문이다. 그래서 브로드캐스트는
 * 페이지 단위로 정확히 나간다.
 *
 * 인증은 핸드셰이크 1회뿐이라, 로그아웃·멤버 해제·사용자 삭제·비밀번호 재설정처럼
 * 권한이 회수되는 순간에는 `closeForUser()` 로 서버가 직접 끊는다. 클라이언트는
 * 지수 백오프로 재접속을 시도하고, 그때 쿠키 인증과 페이지 권한을 다시 지난다.
 *
 * (세션 잠금은 여기서 끊지 않는다 — 잠긴 세션에서도 댓글 **읽기·해결**은 허용이므로
 *  구독을 유지하는 편이 맞다. 작성 차단은 REST 라우트에서 매 요청 검사한다.)
 */

/** 레지스트리가 쓰는 소켓의 최소 형태 (`ws` 의 WebSocket 이 만족한다) */
export interface BroadcastSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** `ws` 의 `WebSocket.OPEN` */
const OPEN = 1;

export type CommentEventType =
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "reply.created"
  | "reply.deleted";

export interface CommentEvent {
  type: CommentEventType;
  payload: unknown;
}

interface Entry {
  pageId: string;
  userId: string;
  socket: BroadcastSocket;
}

export class CommentSocketRegistry {
  private byPage = new Map<string, Set<Entry>>();
  private byUser = new Map<string, Set<Entry>>();

  /** 구독을 등록하고, 소켓이 닫힐 때 호출할 해제 함수를 돌려준다. */
  add(pageId: string, userId: string, socket: BroadcastSocket): () => void {
    const entry: Entry = { pageId, userId, socket };
    addTo(this.byPage, pageId, entry);
    addTo(this.byUser, userId, entry);
    return () => {
      removeFrom(this.byPage, pageId, entry);
      removeFrom(this.byUser, userId, entry);
    };
  }

  /** 같은 페이지를 보고 있는 모든 소켓에 이벤트를 보낸다 (발신자 포함). 보낸 수를 돌려준다. */
  broadcast(pageId: string, event: CommentEvent): number {
    const entries = this.byPage.get(pageId);
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

  /** 한 사용자의 열린 댓글 소켓을 모두 끊는다 (권한 회수). 끊은 수를 돌려준다. */
  closeForUser(userId: string): number {
    const entries = this.byUser.get(userId);
    if (!entries) return 0;
    let closed = 0;
    for (const entry of [...entries]) {
      try {
        // 1008 (policy violation) — 클라이언트는 재접속을 시도하고 그때 인증에서 걸린다.
        entry.socket.close(1008, "revoked");
      } catch {
        // 이미 닫힌 소켓은 무시한다.
      }
      removeFrom(this.byPage, entry.pageId, entry);
      removeFrom(this.byUser, entry.userId, entry);
      closed += 1;
    }
    return closed;
  }

  closeForUsers(userIds: Iterable<string>): number {
    let closed = 0;
    for (const userId of userIds) closed += this.closeForUser(userId);
    return closed;
  }

  /** 테스트·진단용 */
  countForPage(pageId: string): number {
    return this.byPage.get(pageId)?.size ?? 0;
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

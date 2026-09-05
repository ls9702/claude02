/**
 * 시트 WebSocket 레지스트리 (`/ws/sheet/:pageId`).
 *
 * 댓글 채널(`comments/sockets.ts`)과 같은 구조다: 페이지별(브로드캐스트) + 사용자별
 * (권한 회수 시 강제 종료) 이중 색인. 다른 점은 **양방향** 이라는 것 —
 * 클라이언트가 보낸 Fortune-sheet op 를 같은 페이지의 **다른** 접속자에게만 중계한다
 * (자기 에코 제외). 순번(seq)은 페이지별로 증가시켜 디버깅·순서 확인에 쓴다.
 *
 * 서버는 op 를 해석하지 않는다(Fortune-sheet 의 op 적용 로직을 서버에서 재현하지 않는다).
 * 실제 저장은 클라이언트가 5초 디바운스로 보내는 `PUT /api/pages/:id/sheet` 가 담당한다
 * (m5 작업지시서의 "대안" 방식). 그래서 이 레지스트리는 상태를 갖지 않는 릴레이다.
 */

/** 레지스트리가 쓰는 소켓의 최소 형태 (`ws` 의 WebSocket 이 만족한다) */
export interface SheetSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** `ws` 의 `WebSocket.OPEN` */
const OPEN = 1;

export interface SheetEvent {
  type: string;
  payload: unknown;
}

export interface SheetMember {
  /** 접속 식별자 — 같은 사용자가 탭을 여럿 열 수 있으므로 소켓마다 다르다. */
  clientId: string;
  userId: string;
  username: string;
}

interface Entry extends SheetMember {
  pageId: string;
  socket: SheetSocket;
}

export class SheetSocketRegistry {
  private byPage = new Map<string, Set<Entry>>();
  private byUser = new Map<string, Set<Entry>>();
  private seqByPage = new Map<string, number>();

  /** 접속을 등록하고 해제 함수를 돌려준다. */
  add(pageId: string, member: SheetMember, socket: SheetSocket): () => void {
    const entry: Entry = { ...member, pageId, socket };
    addTo(this.byPage, pageId, entry);
    addTo(this.byUser, member.userId, entry);
    return () => {
      removeFrom(this.byPage, pageId, entry);
      removeFrom(this.byUser, member.userId, entry);
      // 마지막 접속자가 나가면 방(순번)도 정리한다.
      if (!this.byPage.has(pageId)) this.seqByPage.delete(pageId);
    };
  }

  /** 다음 op 순번 */
  nextSeq(pageId: string): number {
    const next = (this.seqByPage.get(pageId) ?? 0) + 1;
    this.seqByPage.set(pageId, next);
    return next;
  }

  /** 같은 페이지의 모든 접속자에게 (발신자 포함) */
  broadcast(pageId: string, event: SheetEvent): number {
    return this.send(pageId, event, null);
  }

  /** 같은 페이지의 **다른** 접속자에게만 (에코 제외) */
  broadcastExcept(pageId: string, clientId: string, event: SheetEvent): number {
    return this.send(pageId, event, clientId);
  }

  private send(pageId: string, event: SheetEvent, exceptClientId: string | null): number {
    const entries = this.byPage.get(pageId);
    if (!entries) return 0;
    const data = JSON.stringify(event);
    let sent = 0;
    for (const entry of entries) {
      if (exceptClientId !== null && entry.clientId === exceptClientId) continue;
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
   * 이 페이지 접속자들에게 각자의 `readOnly` 를 다시 알린다 (세션 잠금 변경).
   *
   * 잠금은 소켓이 살아 있는 동안에도 바뀌므로, 핸드셰이크 때 받은 `ready.readOnly`
   * 만으로는 화면이 낡은 값에 갇힌다(잠금 해제 뒤에도 "읽기 전용"). 관리자 라우트가
   * 잠금을 바꿀 때 이 메서드로 밀어 준다. 값은 사용자마다 다르다(관리자는 늘 편집 가능).
   */
  notifyReadOnly(pageId: string, readOnlyFor: (userId: string) => boolean): number {
    const entries = this.byPage.get(pageId);
    if (!entries) return 0;
    let sent = 0;
    for (const entry of entries) {
      if (entry.socket.readyState !== OPEN) continue;
      try {
        entry.socket.send(
          JSON.stringify({
            type: "readonly",
            payload: { readOnly: readOnlyFor(entry.userId) },
          }),
        );
        sent += 1;
      } catch {
        // 끊기는 중인 소켓은 무시한다 — close 핸들러가 정리한다.
      }
    }
    return sent;
  }

  /** 현재 이 페이지를 보고 있는 사람들 (같은 사용자의 여러 탭은 하나로 센다) */
  members(pageId: string): Array<{ userId: string; username: string }> {
    const entries = this.byPage.get(pageId);
    if (!entries) return [];
    const byUser = new Map<string, string>();
    for (const entry of entries) byUser.set(entry.userId, entry.username);
    return [...byUser].map(([userId, username]) => ({ userId, username }));
  }

  /** 접속 소켓 수 (탭 단위) */
  countForPage(pageId: string): number {
    return this.byPage.get(pageId)?.size ?? 0;
  }

  countForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  /** 한 사용자의 열린 시트 소켓을 모두 끊는다 (권한 회수·세션 잠금). */
  closeForUser(userId: string): number {
    const entries = this.byUser.get(userId);
    if (!entries) return 0;
    let closed = 0;
    for (const entry of [...entries]) {
      try {
        // 1008 (policy violation) — 클라이언트는 재접속하고 그때 인증·권한에서 걸린다.
        entry.socket.close(1008, "revoked");
      } catch {
        // 이미 닫힌 소켓은 무시한다.
      }
      removeFrom(this.byPage, entry.pageId, entry);
      removeFrom(this.byUser, entry.userId, entry);
      if (!this.byPage.has(entry.pageId)) this.seqByPage.delete(entry.pageId);
      closed += 1;
    }
    return closed;
  }

  closeForUsers(userIds: Iterable<string>): number {
    let closed = 0;
    for (const userId of userIds) closed += this.closeForUser(userId);
    return closed;
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

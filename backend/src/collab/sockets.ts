/**
 * 열려 있는 협업 소켓 레지스트리.
 *
 * `/socket.io/*` 프록시는 **핸드셰이크 시점에만** 인증한다(WebSocket 은 연결 중에
 * 다시 검사할 지점이 없다). 그래서 로그아웃·멤버 해제·사용자 삭제·세션 잠금처럼
 * 권한이 회수되는 순간에 이미 열려 있던 소켓이 그대로 살아남는 구멍이 있었다.
 *
 * 여기서는 업그레이드 요청이 인증을 통과할 때 그 요청의 **raw TCP 소켓**을
 * 사용자별로 기록해 두고, 권한 회수 시 서버가 직접 끊는다. 끊긴 클라이언트는
 * socket.io 가 자동으로 재접속을 시도하고, 그때 `requireAuth` 와
 * `GET /api/pages/:id/room` 을 다시 지나므로 401/403/`{locked:true}` 로 정상 차단된다.
 *
 * 페이지(룸) 단위가 아니라 **사용자 단위**로 끊는다. 프록시는 어떤 룸에 들어갔는지
 * 알 수 없고(룸 참여는 소켓 위 socket.io 이벤트다), 사용자 단위로 끊어도
 * 재접속 경로에서 권한이 다시 검사되므로 결과는 같다.
 *
 * `@fastify/http-proxy` 의 `wsHooks`(onConnect/onDisconnect)는 컨텍스트로 `{ log }` 만
 * 넘겨줘서 어떤 사용자의 소켓인지 알 수 없다 — 그래서 훅 대신 인증 훅에서 raw 소켓을
 * 직접 잡는다.
 */

/** 레지스트리가 필요로 하는 소켓의 최소 형태 (`net.Socket` 이 만족한다) */
export interface ClosableSocket {
  destroy(): void;
  once(event: "close", listener: () => void): unknown;
}

export class CollabSocketRegistry {
  private byUser = new Map<string, Set<ClosableSocket>>();

  /** 인증을 통과한 업그레이드 요청의 소켓을 기록한다. 닫히면 스스로 빠진다. */
  register(userId: string, socket: ClosableSocket): void {
    let sockets = this.byUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.byUser.set(userId, sockets);
    }
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => {
      this.unregister(userId, socket);
    });
  }

  unregister(userId: string, socket: ClosableSocket): void {
    const sockets = this.byUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.byUser.delete(userId);
  }

  /** 한 사용자의 열린 소켓을 모두 끊는다. 끊은 개수를 돌려준다. */
  closeForUser(userId: string): number {
    const sockets = this.byUser.get(userId);
    if (!sockets) return 0;
    this.byUser.delete(userId);
    let closed = 0;
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // 이미 닫힌 소켓은 무시한다.
      }
      closed += 1;
    }
    return closed;
  }

  closeForUsers(userIds: Iterable<string>): number {
    let closed = 0;
    for (const userId of userIds) closed += this.closeForUser(userId);
    return closed;
  }

  /** 테스트·진단용 — 한 사용자의 열린 소켓 수 */
  countForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

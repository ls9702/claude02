/**
 * 댓글 WebSocket 하트비트 (M3 후속 수정).
 *
 * 지금까지는 30초마다 `ping()` 만 보냈다. ping 은 유휴 연결이 프록시에서 끊기지 않게 하지만,
 * **죽은 연결을 치우지는 못한다** — 탭이 강제 종료되거나 네트워크가 조용히 끊기면 close 프레임이
 * 오지 않아 소켓이 레지스트리에 좀비로 남는다(m3-comments QA "낮음/참고").
 *
 * 그래서 표준적인 `isAlive` 패턴을 쓴다: ping 을 보낼 때마다 "응답 대기" 를 하나 늘리고
 * `pong` 이 오면 0 으로 되돌린다. 대기가 {@link MAX_MISSED_PONGS} 개 쌓인 채로 다음 주기가
 * 오면 그 소켓은 죽은 것으로 보고 `terminate()` 한다(정상 close 핸들러가 정리까지 이어진다).
 *
 * 상태 전이는 타이머·소켓과 분리된 순수 함수다 — 단위 테스트가 30초를 기다리지 않아도 된다.
 */

/** 몇 번 연속으로 pong 을 놓치면 끊을지 */
export const MAX_MISSED_PONGS = 2;

/** 유휴 연결이 프록시에서 끊기지 않도록 보내는 ping 주기 */
export const DEFAULT_PING_INTERVAL_MS = 30_000;

export interface HeartbeatState {
  /** 마지막 pong 이후 답을 받지 못한 ping 수 */
  pendingPings: number;
}

/** 새 연결의 하트비트 상태 */
export const newHeartbeat = (): HeartbeatState => ({ pendingPings: 0 });

/** pong 이 왔다 — 대기를 비운다. */
export const recordPong = (_state: HeartbeatState): HeartbeatState => ({ pendingPings: 0 });

export type HeartbeatAction = "ping" | "terminate";

/**
 * 다음 주기에 할 일. 답 없는 ping 이 `maxMissed` 개 쌓였으면 더 보내지 않고 끊는다.
 * (`maxMissed = 2` 이면 ping 두 번을 연속으로 놓친 소켓이 그다음 주기에 끊긴다.)
 */
export function tickHeartbeat(
  state: HeartbeatState,
  maxMissed: number = MAX_MISSED_PONGS,
): { action: HeartbeatAction; state: HeartbeatState } {
  if (state.pendingPings >= maxMissed) return { action: "terminate", state };
  return { action: "ping", state: { pendingPings: state.pendingPings + 1 } };
}

/** {@link attachHeartbeat} 가 쓰는 소켓의 최소 형태 (`ws.WebSocket` 이 그대로 만족한다). */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  maxMissed?: number;
  /** 테스트용 타이머 주입 */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * 소켓에 하트비트를 건다. 돌려주는 함수를 부르면 타이머가 멈춘다
 * (close·error 핸들러에서 반드시 호출한다).
 */
export function attachHeartbeat(socket: HeartbeatSocket, options: HeartbeatOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const maxMissed = options.maxMissed ?? MAX_MISSED_PONGS;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;

  let state = newHeartbeat();
  socket.on("pong", () => {
    state = recordPong(state);
  });

  const timer = setTimer(() => {
    const next = tickHeartbeat(state, maxMissed);
    state = next.state;
    if (next.action === "terminate") {
      // 좀비 소켓은 close 핸드셰이크를 기다리지 않고 바로 끊는다.
      try {
        socket.terminate();
      } catch {
        // 이미 정리된 소켓이면 무시한다.
      }
      return;
    }
    try {
      socket.ping();
    } catch {
      // 닫히는 중이면 무시한다 — close 핸들러가 정리한다.
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return () => clearTimer(timer as Parameters<typeof clearInterval>[0]);
}

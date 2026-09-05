import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PING_INTERVAL_MS,
  MAX_MISSED_PONGS,
  attachHeartbeat,
  newHeartbeat,
  recordPong,
  tickHeartbeat,
} from "../src/comments/heartbeat.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, login } from "./helpers.js";

describe("하트비트 상태 기계", () => {
  it("새 연결은 대기 중인 ping 이 없다", () => {
    expect(newHeartbeat()).toEqual({ pendingPings: 0 });
  });

  it("주기마다 ping 을 보내고 대기를 하나씩 쌓는다", () => {
    const first = tickHeartbeat(newHeartbeat());
    expect(first).toEqual({ action: "ping", state: { pendingPings: 1 } });
    const second = tickHeartbeat(first.state);
    expect(second).toEqual({ action: "ping", state: { pendingPings: 2 } });
  });

  it("pong 을 연속 2회 놓치면 그다음 주기에 끊는다", () => {
    let state = newHeartbeat();
    for (let i = 0; i < MAX_MISSED_PONGS; i += 1) {
      const tick = tickHeartbeat(state);
      expect(tick.action).toBe("ping");
      state = tick.state;
    }
    expect(tickHeartbeat(state).action).toBe("terminate");
  });

  it("pong 이 오면 대기가 0 으로 돌아간다 (영원히 살아 있는 연결)", () => {
    let state = newHeartbeat();
    for (let round = 0; round < 10; round += 1) {
      const tick = tickHeartbeat(state);
      expect(tick.action).toBe("ping");
      state = recordPong(tick.state);
      expect(state).toEqual({ pendingPings: 0 });
    }
  });

  it("한 번만 놓치고 pong 이 오면 끊지 않는다", () => {
    let state = tickHeartbeat(newHeartbeat()).state; // 1회 미응답
    state = tickHeartbeat(state).state; // 2회 미응답
    state = recordPong(state); // 늦게라도 pong 이 왔다
    expect(tickHeartbeat(state).action).toBe("ping");
  });

  it("한도는 부를 때 바꿀 수 있다", () => {
    const once = tickHeartbeat(newHeartbeat(), 1);
    expect(once.action).toBe("ping");
    expect(tickHeartbeat(once.state, 1).action).toBe("terminate");
  });
});

describe("attachHeartbeat (가짜 타이머)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fakeSocket = () => {
    const calls = { ping: 0, terminate: 0 };
    let pong: (() => void) | null = null;
    return {
      calls,
      pong: () => pong?.(),
      socket: {
        ping: () => {
          calls.ping += 1;
        },
        terminate: () => {
          calls.terminate += 1;
        },
        on: (_event: "pong", listener: () => void) => {
          pong = listener;
        },
      },
    };
  };

  it("pong 이 없으면 ping 2회 뒤 terminate 한다", () => {
    const { socket, calls } = fakeSocket();
    const stop = attachHeartbeat(socket, { intervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(calls).toEqual({ ping: 1, terminate: 0 });
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual({ ping: 2, terminate: 0 });
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual({ ping: 2, terminate: 1 });

    stop();
  });

  it("pong 을 돌려주는 소켓은 끊기지 않는다", () => {
    const { socket, calls, pong } = fakeSocket();
    const stop = attachHeartbeat(socket, { intervalMs: 1000 });

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(1000);
      pong();
    }
    expect(calls.terminate).toBe(0);
    expect(calls.ping).toBe(5);

    stop();
  });

  it("정리 함수를 부르면 더 이상 ping 하지 않는다", () => {
    const { socket, calls } = fakeSocket();
    const stop = attachHeartbeat(socket, { intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(10_000);
    expect(calls.ping).toBe(1);
    expect(calls.terminate).toBe(0);
  });

  it("ping 이 던져도 타이머가 죽지 않는다", () => {
    const calls = { ping: 0, terminate: 0 };
    const stop = attachHeartbeat({
      ping: () => {
        calls.ping += 1;
        throw new Error("closing");
      },
      terminate: () => {
        calls.terminate += 1;
      },
      on: () => undefined,
    }, { intervalMs: 1000 });

    vi.advanceTimersByTime(3000);
    expect(calls).toEqual({ ping: 2, terminate: 1 });
    stop();
  });
});

describe("COMMENT_WS_PING_MS 설정", () => {
  it("기본값은 30초다", () => {
    expect(loadConfig({}).commentWsPingMs).toBe(DEFAULT_PING_INTERVAL_MS);
    expect(DEFAULT_PING_INTERVAL_MS).toBe(30_000);
  });

  it("환경변수로 줄일 수 있고, 이상한 값은 기본값으로 되돌린다", () => {
    expect(loadConfig({ COMMENT_WS_PING_MS: "50" }).commentWsPingMs).toBe(50);
    expect(loadConfig({ COMMENT_WS_PING_MS: "0" }).commentWsPingMs).toBe(DEFAULT_PING_INTERVAL_MS);
    expect(loadConfig({ COMMENT_WS_PING_MS: "말도 안 되는 값" }).commentWsPingMs).toBe(
      DEFAULT_PING_INTERVAL_MS,
    );
  });
});

/**
 * 실제 TCP 소켓 통합 검증.
 *
 * `app.injectWS()` 의 가짜 소켓은 서버→클라이언트 ping 은 전달하지만 클라이언트가 자동으로
 * 돌려주는 pong 을 서버까지 되돌리지 못한다(확인됨) — 그래서 여기서는 실제 포트를 열고
 * 진짜 `ws` 클라이언트(정상 pong)와 **pong 을 절대 보내지 않는 raw 소켓**(죽은 클라이언트)을
 * 나란히 붙여 본다. ping 주기는 40ms 로 줄여 둔다.
 */
describe("실제 댓글 소켓 (ping 주기 40ms)", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let baseUrl: string;
  let port: number;
  let pageId: string;
  let sid: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ds118-hb-"));
    const base = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      ADMIN_USERNAME,
      ADMIN_PASSWORD,
      COOKIE_SECURE: "false",
      COMMENT_WS_PING_MS: "40",
    });
    app = await buildServer({ config: { ...base, dataDir }, logger: false });
    await app.ready();
    app.db.prepare("UPDATE users SET must_change_password = 0 WHERE username = ?").run(ADMIN_USERNAME);

    sid = await login(app, ADMIN_USERNAME, ADMIN_PASSWORD);
    const session = await app.inject({
      method: "POST",
      url: "/api/admin/sessions",
      headers: authHeaders(sid),
      payload: { name: "하트비트" },
    });
    const sessionId = session.json().session.id as string;
    const page = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pages`,
      headers: authHeaders(sid),
      payload: { name: "캔버스", type: "canvas" },
    });
    pageId = page.json().page.id as string;

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("pong 을 돌려주는 클라이언트는 여러 주기를 지나도 구독이 유지된다", async () => {
    const socket = new WebSocket(`${baseUrl}/ws/comments/${pageId}`, {
      headers: { cookie: `sid=${sid}` },
    });
    const closed: number[] = [];
    socket.on("close", (code) => closed.push(code));
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });

    // 40ms × 여러 주기 — pong 추적이 없다면 3주기째에 terminate 된다.
    await new Promise((r) => setTimeout(r, 400));
    expect(closed).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(app.commentSockets.countForPage(pageId)).toBe(1);

    socket.close();
  });

  it("pong 을 보내지 않는 죽은 클라이언트는 서버가 끊는다", async () => {
    const raw = await rawHandshake(port, `/ws/comments/${pageId}`, `sid=${sid}`);
    expect(app.commentSockets.countForPage(pageId)).toBe(1);

    // ping 2회를 놓치면 그다음 주기(=120ms)에 terminate 된다. 넉넉히 기다린다.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("죽은 소켓이 끊기지 않았습니다.")), 3000);
      raw.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // 레지스트리에서도 빠졌다 (terminate → close 핸들러 → dispose).
    await new Promise((r) => setTimeout(r, 50));
    expect(app.commentSockets.countForPage(pageId)).toBe(0);
  });
});

/**
 * WebSocket 핸드셰이크만 직접 하고 그 뒤로는 **아무 프레임에도 답하지 않는** 소켓.
 * (`ws` 클라이언트는 ping 에 자동으로 pong 하므로 죽은 클라이언트를 흉내 낼 수 없다.)
 */
function rawHandshake(port: number, path: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Cookie: ${cookie}`,
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => {
      const head = chunk.toString("latin1");
      if (!head.startsWith("HTTP/1.1 101") || !head.includes(expected)) {
        reject(new Error(`핸드셰이크 실패: ${head.split("\r\n")[0]}`));
        return;
      }
      // 이후 들어오는 ping 프레임은 읽기만 하고 절대 답하지 않는다.
      socket.on("data", () => undefined);
      resolve(socket);
    });
  });
}

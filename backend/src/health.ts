import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index.js";

/**
 * `GET /api/health` — 컨테이너 HEALTHCHECK 와 운영자용 점검에 함께 쓴다.
 *
 * 응답: `{ ok, db, room, uptime, version }`
 *  - `db`   : SQLite 에 실제로 질의가 되는가 (`"ok" | "error"`)
 *  - `room` : 릴레이(excalidraw-room)에 HTTP 로 닿는가 (`"ok" | "down" | "unknown"`)
 *  - `ok`   : **이 프로세스가 요청을 받을 수 있는가** — `db` 만 본다.
 *
 * `room` 을 `ok` 에 넣지 않는 이유: 릴레이가 잠깐 죽어도 app 은 저장·댓글·시트·AI 를
 * 모두 처리할 수 있고(KNOWN_ISSUES 2번), 여기서 unhealthy 로 떨어뜨리면 도커가
 * 멀쩡한 app 컨테이너를 재시작해 오히려 서비스가 끊긴다. 릴레이 상태는 값으로만 알린다.
 *
 * 릴레이 확인은 짧은 타임아웃 + 짧은 캐시를 둔다 — HEALTHCHECK 는 주기적으로 들어오고,
 * 매 호출마다 네트워크를 때리면 헬스체크가 부하가 된다.
 */

/** 릴레이 확인 타임아웃 */
export const ROOM_PROBE_TIMEOUT_MS = 1_500;
/** 릴레이 확인 결과 캐시 수명 */
export const ROOM_PROBE_CACHE_MS = 5_000;

export type RoomStatus = "ok" | "down" | "unknown";

export interface HealthReport {
  ok: boolean;
  db: "ok" | "error";
  room: RoomStatus;
  uptime: number;
  version: string;
}

export function checkDb(db: Db): "ok" | "error" {
  try {
    db.prepare("SELECT 1").get();
    return "ok";
  } catch {
    return "error";
  }
}

/** 릴레이 루트(`/`)에 HEAD 대신 GET — 업스트림 excalidraw-room 은 GET 만 답한다. */
export async function probeRoom(roomUrl: string, timeoutMs = ROOM_PROBE_TIMEOUT_MS): Promise<RoomStatus> {
  try {
    const res = await fetch(new URL("/", roomUrl), { signal: AbortSignal.timeout(timeoutMs) });
    // 본문을 흘려보내야 소켓이 즉시 반환된다.
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

/** 캐시가 달린 릴레이 프로브를 만든다. */
export function createRoomProbe(
  roomUrl: string,
  opts: { cacheMs?: number; timeoutMs?: number } = {},
): () => Promise<RoomStatus> {
  const cacheMs = opts.cacheMs ?? ROOM_PROBE_CACHE_MS;
  const timeoutMs = opts.timeoutMs ?? ROOM_PROBE_TIMEOUT_MS;
  let cached: RoomStatus = "unknown";
  let cachedAt = 0;
  let inFlight: Promise<RoomStatus> | null = null;

  return async () => {
    const now = Date.now();
    if (now - cachedAt < cacheMs && cached !== "unknown") return cached;
    if (inFlight) return inFlight;
    inFlight = probeRoom(roomUrl, timeoutMs)
      .then((status) => {
        cached = status;
        cachedAt = Date.now();
        return status;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const roomProbe = createRoomProbe(app.config.roomUrl);
  const version = process.env.APP_VERSION ?? "dev";

  app.get("/api/health", async (_req, reply) => {
    const db = checkDb(app.db);
    const room = await roomProbe();
    const report: HealthReport = {
      ok: db === "ok",
      db,
      room,
      uptime: Math.round(process.uptime()),
      version,
    };
    // 캐시(브라우저·프록시)가 헬스 응답을 재사용하면 점검이 무의미해진다.
    reply.header("Cache-Control", "no-store");
    if (!report.ok) reply.code(503);
    return report;
  });
}

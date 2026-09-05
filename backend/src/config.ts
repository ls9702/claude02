import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  adminUsername: string;
  adminPassword: string | null;
  cookieSecure: boolean;
  /**
   * Fastify `trustProxy` 값 (TRUST_PROXY 환경변수).
   * 기본 false — X-Forwarded-For 를 무시하고 실제 소켓 주소를 req.ip 로 쓴다.
   * DSM 리버스 프록시 뒤에 둘 때만 `1`(1홉 신뢰) 또는 신뢰할 프록시 IP/CIDR 목록을 지정한다.
   */
  trustProxy: boolean | number | string;
  publicUrl: string;
  /** excalidraw-room 릴레이 주소 (`/socket.io` 프록시의 업스트림) */
  roomUrl: string;
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
}

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

/**
 * TRUST_PROXY 파싱.
 * - 미설정 / `0` / `false` → false (헤더 무시, 기본값)
 * - `1` / `true` → 1 (리버스 프록시 1홉만 신뢰)
 * - 그 밖의 문자열 → IP/CIDR 목록으로 그대로 전달 (예: `127.0.0.1,10.0.0.0/8`)
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const raw = (value ?? "").trim();
  if (raw === "") return false;
  const lower = raw.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no") return false;
  if (lower === "1" || lower === "true" || lower === "yes") return 1;
  const hops = Number.parseInt(raw, 10);
  if (String(hops) === raw && hops > 0) return hops;
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnvRaw = env.NODE_ENV ?? "development";
  const nodeEnv: AppConfig["nodeEnv"] =
    nodeEnvRaw === "production" || nodeEnvRaw === "test" ? nodeEnvRaw : "development";

  return {
    port: Number.parseInt(env.PORT ?? "3001", 10),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(process.cwd(), env.DATA_DIR ?? "./data"),
    adminUsername: env.ADMIN_USERNAME ?? "admin",
    adminPassword: env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length > 0 ? env.ADMIN_PASSWORD : null,
    cookieSecure: toBool(env.COOKIE_SECURE, false),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    publicUrl: env.PUBLIC_URL ?? "http://localhost:5173",
    roomUrl: env.ROOM_URL ?? "http://127.0.0.1:3002",
    nodeEnv,
    isProduction: nodeEnv === "production",
  };
}

/** 세션 쿠키 이름 */
export const SESSION_COOKIE = "sid";
/** 로그인 세션 유효기간: 90일 (슬라이딩) */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 슬라이딩 갱신 최소 간격: 1시간 (매 요청마다 쓰기를 피한다) */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** 업로드 파일 1개당 최대 크기: 5MB */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 썸네일 최대 크기: 200KB */
export const MAX_THUMBNAIL_BYTES = 200 * 1024;
/** 로그인 rate limit: IP 당 분당 10회 (이 값만 사용한다 — 라우트에서 참조) */
export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
/** 댓글·답글 본문 최대 길이 */
export const MAX_COMMENT_BODY = 2000;
/** 페이지당 보관하는 씬 스냅샷 수 */
export const MAX_SNAPSHOTS_PER_PAGE = 20;
/** 스냅샷 생성 주기 (저장 횟수) */
export const SNAPSHOT_EVERY_N_SAVES = 20;
/** 스냅샷 생성 주기 (경과 시간) */
export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

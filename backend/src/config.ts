import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  adminUsername: string;
  adminPassword: string | null;
  cookieSecure: boolean;
  publicUrl: string;
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
}

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

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
    publicUrl: env.PUBLIC_URL ?? "http://localhost:5173",
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
/** 페이지당 보관하는 씬 스냅샷 수 */
export const MAX_SNAPSHOTS_PER_PAGE = 20;
/** 스냅샷 생성 주기 (저장 횟수) */
export const SNAPSHOT_EVERY_N_SAVES = 20;
/** 스냅샷 생성 주기 (경과 시간) */
export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

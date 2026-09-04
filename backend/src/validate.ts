import { badRequest } from "./errors.js";

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("요청 본문이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

export function requireString(
  source: Record<string, unknown>,
  key: string,
  label: string,
  opts: { min?: number; max?: number } = {},
): string {
  const raw = source[key];
  if (typeof raw !== "string") throw badRequest(`${label}을(를) 입력해 주세요.`);
  const value = raw.trim();
  const min = opts.min ?? 1;
  const max = opts.max ?? 200;
  if (value.length < min) throw badRequest(`${label}을(를) 입력해 주세요.`);
  if (value.length > max) throw badRequest(`${label}이(가) 너무 깁니다. (최대 ${max}자)`);
  return value;
}

export function optionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
  opts: { min?: number; max?: number } = {},
): string | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return requireString(source, key, label, opts);
}

export function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === 0 || raw === 1) return raw === 1;
  throw badRequest(`${label} 값이 올바르지 않습니다.`);
}

export function requireArray(source: Record<string, unknown>, key: string, label: string): unknown[] {
  const raw = source[key];
  if (!Array.isArray(raw)) throw badRequest(`${label} 목록이 올바르지 않습니다.`);
  return raw;
}

/** 사용자 이름 규칙: 영문/숫자/._- 3~32자 */
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

export function requireUsername(source: Record<string, unknown>): string {
  const value = requireString(source, "username", "아이디", { max: 32 });
  if (!USERNAME_RE.test(value)) {
    throw badRequest("아이디는 영문·숫자·. _ - 조합 3~32자여야 합니다.");
  }
  return value;
}

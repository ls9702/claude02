import { badRequest } from "./errors.js";

/**
 * 한국어 조사 선택 — 마지막 글자의 받침 유무로 고른다.
 * ("이름을(를) 입력해 주세요." 같은 어색한 병기를 없애기 위한 유틸)
 */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  // 한글 음절이 아니면(영문·숫자 등) 받침 없는 형태를 쓴다.
  if (!last || code < 0xac00 || code > 0xd7a3) return withoutFinal;
  return (code - 0xac00) % 28 === 0 ? withoutFinal : withFinal;
}

/** `이름을` / `종류를` */
export const withEulReul = (word: string): string => `${word}${josa(word, "을", "를")}`;
/** `이름이` / `종류가` */
export const withIGa = (word: string): string => `${word}${josa(word, "이", "가")}`;

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
  if (typeof raw !== "string") throw badRequest(`${withEulReul(label)} 입력해 주세요.`);
  const value = raw.trim();
  const min = opts.min ?? 1;
  const max = opts.max ?? 200;
  if (value.length < min) throw badRequest(`${withEulReul(label)} 입력해 주세요.`);
  if (value.length > max) throw badRequest(`${withIGa(label)} 너무 깁니다. (최대 ${max}자)`);
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

/** 씬 좌표 등 유한한 수. 범위를 벗어나면 400. */
export function requireNumber(
  source: Record<string, unknown>,
  key: string,
  label: string,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw badRequest(`${withIGa(label)} 올바르지 않습니다.`);
  }
  const min = opts.min ?? -1e7;
  const max = opts.max ?? 1e7;
  if (raw < min || raw > max) throw badRequest(`${withIGa(label)} 허용 범위를 벗어났습니다.`);
  return raw;
}

export function optionalNumber(
  source: Record<string, unknown>,
  key: string,
  label: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return requireNumber(source, key, label, opts);
}

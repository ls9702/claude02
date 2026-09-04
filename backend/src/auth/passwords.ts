import bcrypt from "bcryptjs";

const ROUNDS = 10;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

export interface PasswordCheck {
  ok: boolean;
  message?: string;
}

/** 비밀번호 정책: 8자 이상 72바이트 이하 (bcrypt 입력 한계) */
export function checkPasswordPolicy(plain: unknown): PasswordCheck {
  if (typeof plain !== "string" || plain.length === 0) {
    return { ok: false, message: "비밀번호를 입력해 주세요." };
  }
  if (plain.length < 8) {
    return { ok: false, message: "비밀번호는 8자 이상이어야 합니다." };
  }
  if (Buffer.byteLength(plain, "utf8") > 72) {
    return { ok: false, message: "비밀번호가 너무 깁니다. (최대 72바이트)" };
  }
  return { ok: true };
}

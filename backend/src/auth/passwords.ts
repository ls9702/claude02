import bcrypt from "bcryptjs";

const ROUNDS = 10;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);

/**
 * 존재하지 않는 계정으로 로그인 시도가 들어와도 bcrypt 비교를 수행하기 위한 더미 해시
 * (cost 10). 실제 비밀번호와 일치하지 않으며, 응답 시간을 맞춰 계정 열거를 막는 용도다.
 */
export const DUMMY_PASSWORD_HASH = "$2b$10$1upPr2sZjtMPtwleroFbIOcO5a/SS5nUJuMlGZcujtSJC4wzxK5CW";

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

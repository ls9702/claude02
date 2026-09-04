/** API 오류: 응답은 항상 `{ error: { code, message } }` 형태, message 는 한국어. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message = "요청 형식이 올바르지 않습니다.", code = "bad_request") =>
  new ApiError(400, code, message);

export const unauthorized = (message = "로그인이 필요합니다.", code = "unauthorized") =>
  new ApiError(401, code, message);

export const forbidden = (message = "접근 권한이 없습니다.", code = "forbidden") =>
  new ApiError(403, code, message);

export const notFound = (message = "대상을 찾을 수 없습니다.", code = "not_found") =>
  new ApiError(404, code, message);

export const conflict = (message = "이미 존재합니다.", code = "conflict") =>
  new ApiError(409, code, message);

export const payloadTooLarge = (message = "파일이 너무 큽니다.", code = "payload_too_large") =>
  new ApiError(413, code, message);

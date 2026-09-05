import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  MUST_CHANGE_PASSWORD_CODE,
  request,
  setPasswordChangeRequiredHandler,
  setUnauthorizedHandler,
} from "./api";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  setPasswordChangeRequiredHandler(null);
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe("api 오류 처리", () => {
  it("must_change_password 403 을 받으면 비밀번호 변경 핸들러를 호출한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, {
          error: { code: MUST_CHANGE_PASSWORD_CODE, message: "비밀번호를 변경해야 계속 사용할 수 있습니다." },
        }),
      ),
    );
    const handler = vi.fn();
    setPasswordChangeRequiredHandler(handler);

    await expect(request("/api/sessions")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("다른 403 은 비밀번호 변경 핸들러를 호출하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: { code: "forbidden", message: "접근 권한이 없습니다." } })),
    );
    const handler = vi.fn();
    setPasswordChangeRequiredHandler(handler);

    await expect(request("/api/sessions")).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("401 은 기존대로 unauthorized 핸들러를 호출한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: { code: "unauthorized", message: "로그인이 필요합니다." } })),
    );
    const onUnauthorized = vi.fn();
    const onPassword = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setPasswordChangeRequiredHandler(onPassword);

    await expect(request("/api/sessions")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onPassword).not.toHaveBeenCalled();
  });
});

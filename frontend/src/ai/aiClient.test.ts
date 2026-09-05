import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, askAi, extractCitations, extractText, pingAi } from "./aiClient";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ask = () => askAi({ pageId: "p1", prompt: "질문", grounding: true });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractText", () => {
  it("첫 후보의 모든 text 파트를 잇는다", () => {
    expect(
      extractText({ candidates: [{ content: { parts: [{ text: "앞 " }, { text: "뒤" }] } }] }),
    ).toBe("앞 뒤");
  });

  it("모양이 다르면 빈 문자열", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
    expect(extractText({ candidates: [] })).toBe("");
    expect(extractText({ candidates: [{ content: {} }] })).toBe("");
    expect(extractText({ candidates: [{ content: { parts: [{}] } }] })).toBe("");
  });
});

describe("extractCitations", () => {
  const body = (chunks: unknown[]) => ({
    candidates: [{ content: { parts: [{ text: "x" }] }, groundingMetadata: { groundingChunks: chunks } }],
  });

  it("groundingChunks 의 web 을 {title,url} 로 읽는다", () => {
    expect(extractCitations(body([{ web: { uri: "https://a.test", title: "A" } }]))).toEqual([
      { url: "https://a.test", title: "A" },
    ]);
  });

  it("같은 url 은 한 번만, 제목이 없으면 url 을 쓴다", () => {
    const citations = extractCitations(
      body([
        { web: { uri: "https://a.test", title: "A" } },
        { web: { uri: "https://a.test", title: "또 A" } },
        { web: { uri: "https://b.test" } },
      ]),
    );
    expect(citations).toEqual([
      { url: "https://a.test", title: "A" },
      { url: "https://b.test", title: "https://b.test" },
    ]);
  });

  it("최대 5개까지만", () => {
    const chunks = Array.from({ length: 9 }, (_, i) => ({ web: { uri: `https://${i}.test` } }));
    expect(extractCitations(body(chunks))).toHaveLength(5);
  });

  it("그라운딩이 없으면 빈 배열", () => {
    expect(extractCitations({ candidates: [{ content: { parts: [{ text: "x" }] } }] })).toEqual([]);
  });
});

describe("pingAi", () => {
  it("{ai:true} 면 true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ai: true })));
    await expect(pingAi()).resolves.toBe(true);
  });

  it("{ai:false}·오류·예외는 모두 false (절대 던지지 않는다)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ai: false })));
    await expect(pingAi()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => json(503, { error: { code: "ai_disabled" } })));
    await expect(pingAi()).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(pingAi()).resolves.toBe(false);
  });
});

describe("askAi", () => {
  it("성공하면 글과 출처를 돌려주고, 요청 본문에 pageId·grounding 이 들어간다", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, {
        candidates: [
          {
            content: { parts: [{ text: "제목\n- 하나" }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://a.test", title: "A" } }] },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await askAi({ pageId: "p1", prompt: "질문", grounding: true, context: "메모" });
    expect(result.text).toBe("제목\n- 하나");
    expect(result.citations).toEqual([{ url: "https://a.test", title: "A" }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/ask");
    expect(JSON.parse(String(init.body))).toEqual({
      pageId: "p1",
      prompt: "질문",
      grounding: true,
      context: "메모",
    });
    expect(init.credentials).toBe("same-origin");
  });

  it("컨텍스트가 없으면 본문에도 없다", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { candidates: [{ content: { parts: [{ text: "글" }] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await askAi({ pageId: "p1", prompt: "질문", grounding: false });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("context");
  });

  it("전송이 실패하면 network 다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(ask()).rejects.toMatchObject({ name: "AiError", kind: "network", status: 0 });
  });

  it("429 는 rate, 503 은 unavailable, 403 코드는 auth 로 매핑한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(429, { error: { code: "rate", message: "너무 많습니다" } })));
    await expect(ask()).rejects.toMatchObject({ kind: "rate", status: 429 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(503, { error: { code: "ai_disabled", message: "AI 없음" } })),
    );
    await expect(ask()).rejects.toMatchObject({ kind: "unavailable", status: 503 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(502, { error: { code: "auth", message: "인증 실패", detail: "API key not valid" } })),
    );
    const err = await ask().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("auth");
    expect((err as AiError).message).toContain("API key not valid");
  });

  it("그 밖의 비-2xx 는 server 다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(502, { error: { code: "server", message: "업스트림 오류" } })));
    await expect(ask()).rejects.toMatchObject({ kind: "server", status: 502 });

    // 본문을 읽을 수 없어도 종류는 정해진다.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 500 })));
    await expect(ask()).rejects.toMatchObject({ kind: "server", status: 500 });
  });

  it("사용자에게 보이는 메시지는 한국어다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const err = (await ask().catch((e: unknown) => e)) as AiError;
    expect(err.message).toMatch(/[가-힣]/);
  });

  it("2xx 인데 답이 비어 있으면 parse 다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { candidates: [] })));
    await expect(ask()).rejects.toMatchObject({ kind: "parse", status: 200 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(ask()).rejects.toMatchObject({ kind: "parse" });
  });
});

/**
 * E2E 용 가짜 Gemini (`GEMINI_BASE_URL` 이 여기를 가리킨다).
 *
 * 진짜 Google 을 부르지 않고도 프록시 → 파서 → 카드까지의 길을 그대로 시험하기 위한 것이다.
 * 응답은 **질문 내용으로** 고른다(테스트가 프롬프트 한 줄로 시나리오를 정한다):
 *
 *   "규약미준수" 포함 → 첫 줄 제목·불릿이 없는 한 문단 (프론트 폴백 파서를 시험)
 *   "업스트림오류" 포함 → HTTP 500 (오류 매핑을 시험)
 *   그 밖        → 규약을 지킨 답변
 *
 * 출처(groundingMetadata)는 요청에 `tools:[{google_search:{}}]` 가 있을 때만 붙인다 —
 * 「검색 기반」 체크박스가 실제로 페이로드를 바꾸는지 확인할 수 있다.
 *
 * 순수 Node(http) 로만 짠다: e2e 워크스페이스에 런타임 의존성을 늘리지 않는다.
 */
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "3003", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

const CONFORMING = [
  "부산 2박 3일 코스",
  "- 광안리 해변 야경 산책",
  "- 자갈치 시장에서 아침 식사",
  "- 감천문화마을 골목 둘러보기",
].join("\n");

const NON_CONFORMING =
  "부산은 대한민국 제2의 도시이자 항구 도시입니다. 해운대와 광안리 해수욕장이 특히 유명합니다. 겨울에도 비교적 따뜻해 사계절 여행지로 좋습니다.";

const SOURCES = [
  { uri: "https://busan.example.test/travel", title: "부산시 공식 관광 안내" },
  { uri: "https://blog.example.test/busan", title: "부산 2박 3일 후기" },
];

const answer = (text, grounded) => ({
  candidates: [
    {
      content: { parts: [{ text }], role: "model" },
      finishReason: "STOP",
      ...(grounded
        ? { groundingMetadata: { groundingChunks: SOURCES.map((web) => ({ web })), webSearchQueries: ["부산 여행"] } }
        : {}),
    },
  ],
  usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 84 },
});

/** 지금까지 받은 요청 (테스트가 /__requests 로 확인할 수 있다) */
const received = [];

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true, received: received.length });
    return;
  }
  if (req.method === "GET" && url.pathname === "/__requests") {
    send(res, 200, { requests: received });
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/__requests") {
    received.length = 0;
    send(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || !url.pathname.includes(":generateContent")) {
    send(res, 404, { error: { message: "not found" } });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      send(res, 400, { error: { message: "bad json" } });
      return;
    }

    const grounded = Array.isArray(body?.tools) && body.tools.length > 0;
    const text = String(body?.contents?.[0]?.parts?.[0]?.text ?? "");
    received.push({
      key: req.headers["x-goog-api-key"] ?? url.searchParams.get("key"),
      model: url.pathname,
      grounded,
      text,
      system: String(body?.systemInstruction?.parts?.[0]?.text ?? ""),
    });

    if (text.includes("업스트림오류")) {
      send(res, 500, { error: { code: 500, message: "mock upstream failure", status: "INTERNAL" } });
      return;
    }
    if (text.includes("규약미준수")) {
      send(res, 200, answer(NON_CONFORMING, grounded));
      return;
    }
    send(res, 200, answer(CONFORMING, grounded));
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`mock-gemini: listening on ${HOST}:${PORT}\n`);
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 프로덕션 전용 Content-Security-Policy (KNOWN_ISSUES.md 5번의 해소).
 *
 * 개발(dev)에는 붙이지 않는다 — Vite dev 서버는 HMR 을 위해 인라인 스크립트·eval 을 쓰고,
 * 프론트는 5173, 백엔드는 3001 로 오리진이 갈라져 있어 같은 정책을 쓸 수 없다.
 * 배포에서는 app 하나가 SPA 와 API 를 같은 오리진으로 서빙하므로 `'self'` 로 충분하다.
 *
 * Excalidraw·Fortune-sheet 가 실제로 요구하는 것만 연다:
 *  - `style-src 'unsafe-inline'` : 두 라이브러리 모두 DOM 에 인라인 style 을 직접 쓴다.
 *  - `img-src data: blob:`       : 캔버스 export·붙여넣기 미리보기·아이콘(SVG data URI).
 *  - `font-src data:`            : 일부 아이콘 폰트가 data URI 로 들어온다 (자체 호스팅 폰트는 'self').
 *  - `worker-src blob:`          : Excalidraw 의 폰트/이미지 워커는 blob URL 로 만들어진다.
 *  - `media-src blob:`           : 라이브러리 내부의 blob 미디어.
 *  - `connect-src blob: data:`   : fetch(blobUrl) 로 export 결과를 읽는다.
 *  - `'wasm-unsafe-eval'`        : 이미지 처리 경로에 wasm 이 들어올 수 있다(PLAN §3).
 *                                  eval/`new Function` 은 열지 않는다.
 *
 * `index.html` 의 인라인 스크립트(`window.EXCALIDRAW_ASSET_PATH`)는 `'unsafe-inline'` 대신
 * **sha256 해시**로 허용한다. 해시는 기동 시 실제 파일에서 뽑으므로 스크립트가 바뀌면 자동으로 따라간다.
 */

/** `<script>` (src 없는 것) 본문을 뽑는다. */
export function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? "";
    if (body.trim() !== "") bodies.push(body);
  }
  return bodies;
}

/** CSP 의 `'sha256-...'` 소스 표현 */
export function sha256Source(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

/** index.html 에서 인라인 스크립트 해시 목록을 읽는다. 파일이 없으면 빈 배열. */
export function inlineScriptHashes(indexHtmlPath: string): string[] {
  try {
    return inlineScriptBodies(readFileSync(indexHtmlPath, "utf8")).map(sha256Source);
  } catch {
    return [];
  }
}

/** PUBLIC_URL 에서 WebSocket 오리진(`wss://host`)을 만든다. 파싱 실패면 null. */
export function websocketOrigin(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  } catch {
    return null;
  }
}

export interface CspOptions {
  /** index.html 의 인라인 스크립트 sha256 소스들 */
  scriptHashes?: string[];
  /** PUBLIC_URL (connect-src 의 ws 오리진을 여기서 뽑는다) */
  publicUrl?: string;
}

/** 프로덕션 CSP 헤더 값을 만든다. */
export function buildCsp(options: CspOptions = {}): string {
  const hashes = options.scriptHashes ?? [];
  const wsOrigin = options.publicUrl ? websocketOrigin(options.publicUrl) : null;

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["script-src", ["'self'", "'wasm-unsafe-eval'", ...hashes]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "data:", "blob:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["child-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["connect-src", ["'self'", "data:", "blob:", ...(wsOrigin ? [wsOrigin] : [])]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/**
 * 정적 자산의 Cache-Control.
 *  - 해시 파일명 자산(`/assets/index-BE6GJL8D.js`, 폰트 등) → 1년 immutable
 *  - `index.html`(과 그 밖의 HTML) → `no-cache` (항상 재검증 — 배포 직후 새 자산을 가리키게)
 * 사전 압축 파일(`*.js.br`)도 원본 확장자로 판단한다.
 */
export function staticCacheControl(filePath: string): string {
  const path = filePath.replace(/\\/g, "/").replace(/\.(br|gz)$/i, "");
  if (/\.html?$/i.test(path)) return "no-cache";
  if (/\/(assets|excalidraw-assets)\//.test(path)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

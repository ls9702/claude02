#!/usr/bin/env node
/**
 * 빌드 산출물 사전 압축 (PLAN §3 "빌드 시 brotli/gzip 사전 압축").
 *
 * `dist/` 의 텍스트 자산마다 `*.br` 과 `*.gz` 를 나란히 만든다.
 * 백엔드의 `@fastify/static` 은 `preCompressed: true` 로 이 파일을 그대로 흘려보낸다.
 *
 * 왜 런타임 압축(@fastify/compress)이 아닌가:
 *  - DS118 은 1.4GHz Cortex-A53 4코어다. 3MB 짜리 시트 청크를 요청마다 brotli 로 밀면
 *    그 CPU 시간이 그대로 첫 로딩 지연이 된다. 빌드는 PC 에서 한 번만 하면 된다.
 *  - 사전 압축은 최고 품질(brotli 11)을 쓸 수 있어 전송량도 더 작다 —
 *    가정용 업로드 대역폭이 병목이라는 PLAN §3 의 전제와 맞는다.
 *  - 런타임 의존성이 늘지 않는다.
 *
 * 압축하지 않는 것: 이미 압축된 포맷(woff2·png·jpg·webp·gz·br)과 아주 작은 파일
 * (헤더·왕복 비용이 이득보다 크다).
 *
 * 소스맵(`*.map`)은 압축 대상에서 뺀다 — 런타임 이미지에 넣지 않는다(.dockerignore).
 */
import { constants, brotliCompress, gzip } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", process.argv[2] ?? "dist");

/** 압축할 확장자 */
const COMPRESSIBLE = new Set([
  ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".svg", ".txt", ".xml", ".webmanifest", ".ttf", ".otf",
]);
/** 이보다 작으면 압축해도 이득이 없다 */
const MIN_BYTES = 1024;
/** 압축본이 원본의 이 비율보다 크면 버린다 */
const MAX_RATIO = 0.95;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function main() {
  try {
    await stat(distDir);
  } catch {
    console.warn(`[precompress] ${distDir} 가 없어 건너뜁니다. (먼저 vite build 를 실행하세요)`);
    return;
  }

  let files = 0;
  let rawTotal = 0;
  let brTotal = 0;
  let gzTotal = 0;
  const started = Date.now();

  for await (const path of walk(distDir)) {
    const ext = extname(path).toLowerCase();
    if (!COMPRESSIBLE.has(ext)) continue;
    if (path.endsWith(".map")) continue;

    const raw = await readFile(path);
    if (raw.byteLength < MIN_BYTES) continue;

    const [br, gz] = await Promise.all([
      brotliAsync(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
        },
      }),
      gzipAsync(raw, { level: 9 }),
    ]);

    let wrote = false;
    if (br.byteLength < raw.byteLength * MAX_RATIO) {
      await writeFile(`${path}.br`, br);
      brTotal += br.byteLength;
      wrote = true;
    }
    if (gz.byteLength < raw.byteLength * MAX_RATIO) {
      await writeFile(`${path}.gz`, gz);
      gzTotal += gz.byteLength;
      wrote = true;
    }
    if (wrote) {
      files += 1;
      rawTotal += raw.byteLength;
    }
  }

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;
  console.log(
    `[precompress] ${files}개 파일: 원본 ${mb(rawTotal)} → br ${mb(brTotal)} / gz ${mb(gzTotal)} ` +
      `(${((Date.now() - started) / 1000).toFixed(1)}초)`,
  );
}

await main();

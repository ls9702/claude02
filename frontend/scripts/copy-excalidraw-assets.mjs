#!/usr/bin/env node
/**
 * Excalidraw 폰트 자체 호스팅.
 *
 * `@excalidraw/excalidraw` 는 기본적으로 폰트를 외부 CDN(unpkg)에서 내려받는다.
 * 오프라인/자체 호스팅 환경을 위해 패키지의 `dist/prod/fonts` 를
 * `frontend/public/excalidraw-assets/fonts` 로 복사하고,
 * `index.html` 에서 `window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/"` 를 지정한다.
 *
 * postinstall / prebuild 에서 실행된다. 패키지가 아직 설치되지 않았으면 조용히 넘어간다.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, "..");
const repoRoot = resolve(frontendRoot, "..");

const candidates = [
  resolve(frontendRoot, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
  resolve(repoRoot, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
];

const destRoot = resolve(frontendRoot, "public/excalidraw-assets");
const dest = resolve(destRoot, "fonts");

async function exists(p) {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

let source = null;
for (const c of candidates) {
  if (await exists(c)) {
    source = c;
    break;
  }
}

if (!source) {
  console.warn(
    "[excalidraw-assets] @excalidraw/excalidraw dist/prod/fonts 를 찾지 못해 복사를 건너뜁니다. " +
      "(npm install 이후 다시 실행됩니다)",
  );
  process.exit(0);
}

await rm(dest, { recursive: true, force: true });
await mkdir(destRoot, { recursive: true });
await cp(source, dest, { recursive: true });
console.log(`[excalidraw-assets] 폰트 복사 완료: ${source} -> ${dest}`);

import { expect, type Browser, type Page } from "@playwright/test";
import { waitForExcalidraw } from "../tests/fixtures";

export interface CspViolation {
  directive: string;
  blockedURI: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

/**
 * CSP 위반을 페이지 안에서 모은다.
 * `securitypolicyviolation` 은 브라우저가 무언가를 **실제로 막았을 때만** 뜬다 —
 * 콘솔 문자열을 긁는 것보다 정확하고, 번역/포맷 변화에 흔들리지 않는다.
 */
export async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations!.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });
}

export async function cspViolations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(() => window.__cspViolations ?? []);
}

/**
 * Excalidraw 는 `@font-face` 의 **두 번째** src 로 언제나 업스트림 CDN(esm.sh)을 적어 둔다
 * (`FontMetadata.createUrls` 가 `ASSETS_FALLBACK_URL` 을 무조건 덧붙인다).
 * 첫 번째 src 는 우리가 자체 호스팅한 `/excalidraw-assets/...` 이고 실제 로딩은 그쪽에서 된다 —
 * CSP 는 쓰이지 않는 CDN 후보만 막는다. 이것은 **의도한 결과**다(NAS 가 외부로 나가지 않는다).
 * 그래서 이 한 가지만 허용 목록에 둔다. KNOWN_ISSUES.md 19번 참고.
 */
const EXCALIDRAW_CDN_FALLBACK = "https://esm.sh/@excalidraw/excalidraw";

export function unexpectedViolations(violations: CspViolation[]): CspViolation[] {
  return violations.filter(
    (v) => !(v.directive === "font-src" && v.blockedURI.startsWith(EXCALIDRAW_CDN_FALLBACK)),
  );
}

/** 예상하지 못한 CSP 차단이 없었는지 확인한다 (막혔으면 무엇이 막혔는지 그대로 보여준다). */
export async function expectNoCspViolations(page: Page): Promise<void> {
  const unexpected = unexpectedViolations(await cspViolations(page));
  expect(unexpected, `예상하지 못한 CSP 위반: ${JSON.stringify(unexpected)}`).toEqual([]);
}

/** CSP 수집기를 붙인 새 컨텍스트를 연다. */
export async function openPage(
  browser: Browser,
  storageState: string,
  url?: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await collectCspViolations(page);
  if (url) await page.goto(url);
  return { page, close: () => context.close() };
}

/** 캔버스 페이지를 열고 Excalidraw 준비까지 기다린다. */
export async function openCanvas(
  browser: Browser,
  storageState: string,
  url: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const opened = await openPage(browser, storageState, url);
  await waitForExcalidraw(opened.page);
  return opened;
}

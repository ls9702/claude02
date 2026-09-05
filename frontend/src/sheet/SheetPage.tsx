/**
 * 시트 페이지 진입점.
 *
 * Fortune-sheet 와 SheetJS 는 무거워서(수 MB) **여기서만 지연 로드**한다.
 * 그림판만 쓰는 사람은 이 청크를 내려받지 않는다 (PLAN §2.7 성능 항목).
 */
import { lazy, Suspense } from "react";
import type { Page } from "../api";
import type { CollabConnection } from "../collab/status";
import { Spinner } from "../components/Spinner";

const SheetWorkbook = lazy(() => import("./SheetWorkbook"));

export interface SheetPageProps {
  page: Page;
  readOnly: boolean;
  username: string;
  onCollabState?: (state: { collaboratorCount: number; connection: CollabConnection }) => void;
}

export function SheetPage(props: SheetPageProps) {
  return (
    <Suspense fallback={<Spinner label="시트를 여는 중…" />}>
      <SheetWorkbook {...props} />
    </Suspense>
  );
}

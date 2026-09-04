import type { Page } from "../api";

/** 시트 페이지는 M5에서 Fortune-sheet 로 구현한다. */
export function SheetPlaceholder({ page }: { page: Page }) {
  return (
    <div className="centered-page">
      <div className="card notice" data-testid="sheet-placeholder">
        <h2>📊 {page.name}</h2>
        <p>시트 페이지는 준비 중입니다 (M5)</p>
        <p className="muted small">엑셀형 표·수식·회비 장부 템플릿이 이 자리에 들어갑니다.</p>
      </div>
    </div>
  );
}

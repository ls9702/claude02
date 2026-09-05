import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PageType, SheetTemplate } from "../api";

export function NewPageDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (name: string, type: PageType, template: SheetTemplate) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PageType>("canvas");
  const [template, setTemplate] = useState<SheetTemplate>("ledger");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("페이지 이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed, type, template);
    } catch (err) {
      setError(err instanceof Error ? err.message : "페이지를 만들지 못했습니다.");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="card form modal"
        role="dialog"
        aria-modal="true"
        aria-label="새 페이지"
        data-testid="new-page-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>새 페이지</h2>
        <label htmlFor="page-name">이름</label>
        <input
          id="page-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 행사 기획"
          data-testid="new-page-name"
        />
        <fieldset className="radio-group">
          <legend>종류</legend>
          <label>
            <input
              type="radio"
              name="page-type"
              value="canvas"
              checked={type === "canvas"}
              onChange={() => setType("canvas")}
              data-testid="new-page-type-canvas"
            />
            🎨 그림판
          </label>
          <label>
            <input
              type="radio"
              name="page-type"
              value="sheet"
              checked={type === "sheet"}
              onChange={() => setType("sheet")}
              data-testid="new-page-type-sheet"
            />
            📊 시트
          </label>
        </fieldset>
        {type === "sheet" ? (
          <fieldset className="radio-group" data-testid="new-page-template">
            <legend>시트 시작 방식</legend>
            <label>
              <input
                type="radio"
                name="sheet-template"
                value="ledger"
                checked={template === "ledger"}
                onChange={() => setTemplate("ledger")}
                data-testid="new-page-template-ledger"
              />
              💰 회비 장부 (수입·지출·잔액 자동 계산)
            </label>
            <label>
              <input
                type="radio"
                name="sheet-template"
                value="blank"
                checked={template === "blank"}
                onChange={() => setTemplate("blank")}
                data-testid="new-page-template-blank"
              />
              📄 빈 시트
            </label>
          </fieldset>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={busy} data-testid="new-page-submit">
            {busy ? "만드는 중…" : "만들기"}
          </button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Page } from "../api";

const ICON: Record<Page["type"], string> = { canvas: "🎨", sheet: "📊" };

export interface PageTabsProps {
  pages: Page[];
  activePageId: string | undefined;
  readOnly: boolean;
  onSelect: (pageId: string) => void;
  onRename: (pageId: string, name: string) => Promise<void>;
  onDelete: (pageId: string) => Promise<void>;
  onMove: (pageId: string, direction: -1 | 1) => Promise<void>;
  onReorder: (pageIds: string[]) => Promise<void>;
}

export function PageTabs({
  pages,
  activePageId,
  readOnly,
  onSelect,
  onRename,
  onDelete,
  onMove,
  onReorder,
}: PageTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startEdit = (page: Page) => {
    if (readOnly) return;
    setEditingId(page.id);
    setDraft(page.name);
  };

  const commitEdit = async () => {
    const id = editingId;
    if (!id) return;
    const name = draft.trim();
    setEditingId(null);
    const original = pages.find((p) => p.id === id);
    if (!name || !original || name === original.name) return;
    await onRename(id, name);
  };

  const handleDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = pages.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    setDragId(null);
    await onReorder(ids);
  };

  return (
    <div className="page-tabs" role="tablist" aria-label="페이지 목록">
      {pages.map((page, index) => {
        const active = page.id === activePageId;
        return (
          <div
            key={page.id}
            className={`page-tab${active ? " active" : ""}`}
            data-testid="page-tab"
            data-page-id={page.id}
            data-page-type={page.type}
            draggable={!readOnly && editingId !== page.id}
            onDragStart={() => setDragId(page.id)}
            onDragOver={(e) => {
              if (dragId) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              void handleDrop(page.id);
            }}
          >
            {editingId === page.id ? (
              <input
                ref={inputRef}
                className="page-tab-input"
                data-testid="page-tab-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitEdit()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitEdit();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="page-tab-button"
                data-testid="page-tab-button"
                onClick={() => onSelect(page.id)}
                onDoubleClick={() => startEdit(page)}
                title="더블클릭하면 이름을 바꿀 수 있습니다"
              >
                <span aria-hidden="true">{ICON[page.type]}</span>
                <span className="page-tab-name">{page.name}</span>
              </button>
            )}

            {!readOnly ? (
              <span className="page-tab-actions">
                <button
                  type="button"
                  className="icon-button"
                  title="앞으로 이동"
                  aria-label={`${page.name} 앞으로 이동`}
                  data-testid="page-move-left"
                  disabled={index === 0}
                  onClick={() => void onMove(page.id, -1)}
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="뒤로 이동"
                  aria-label={`${page.name} 뒤로 이동`}
                  data-testid="page-move-right"
                  disabled={index === pages.length - 1}
                  onClick={() => void onMove(page.id, 1)}
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  title="페이지 삭제"
                  aria-label={`${page.name} 삭제`}
                  data-testid="page-delete"
                  onClick={() => void onDelete(page.id)}
                >
                  ✕
                </button>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 시트 페이지 본체 (Fortune-sheet).
 *
 * **이 파일만 `@fortune-sheet/react` 와 `xlsx` 를 import 한다.** `SheetPage` 가
 * `React.lazy` 로 불러오므로 그림판만 쓰는 경로의 번들에는 들어가지 않는다.
 *
 * 동기화·저장 (m5 작업지시서의 "대안" 방식):
 * - 내 편집 → `onOp` → `/ws/sheet/:pageId` 로 방송(서버는 발신자에게 되돌리지 않는다).
 * - 남의 편집 → `applyOp` (이 경로는 op 를 다시 만들지 않는다 — noHistory).
 * - 5초 디바운스로 전체 문서를 `PUT /api/pages/:id/sheet` 에 저장한다. 페이지를 떠날 때는 즉시.
 *
 * 수식 (실측으로 확인한 Fortune-sheet 1.0.4 의 성질 — templates.ts 주석 참고):
 * - 저장된 수식은 불러오는 것만으로 계산되지 않는다 → 마운트 후 `calculateFormula` 를 부른다.
 * - 한 번의 계산은 **행 우선**이라 "보조 열 → 집계" 같은 의존성이 한 번에 안 풀린다 → 2회 돈다.
 * - 사용자가 값을 고치면 엔진이 의존 셀을 다시 계산하지만, 방금 입력한 날짜 텍스트는
 *   내부 캐시에 날짜 직렬값으로 남아 있어 `LEFT()` 결과가 잠깐 틀린다 → 편집 후에도 한 번 더 돈다.
 */
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import type { Op, Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Page } from "../api";
import { collabNotice, type CollabConnection } from "../collab/status";
import { Spinner } from "../components/Spinner";
import { normalizeDoc, toStorableDoc, type WorkSheet } from "./schema";
import { useSheetSync } from "./useSheetSync";
import {
  bytesToWorkbook,
  sheetToCsv,
  sheetsToWorkbook,
  workbookToBytes,
  workbookToSheets,
} from "./xlsx";

/** 전체 저장 디바운스 */
const SAVE_DEBOUNCE_MS = 5_000;
/** 편집 후 수식 보정 디바운스 */
const RECALC_DEBOUNCE_MS = 600;
/** 초기 계산으로 생긴 op 를 내보내지 않는 시간 (React 상태 갱신이 비동기라 시간 창으로 막는다) */
const SUPPRESS_MS = 800;
/** 가져오기를 op 로 반영할 수 있는 최대 셀 수 (넘으면 화면만 교체하고 저장한다) */
const MAX_IMPORT_OPS_CELLS = 4_000;

const EXPOSE_TEST_HOOKS = import.meta.env.DEV || import.meta.env.VITE_E2E === "1";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "",
  saving: "저장 중…",
  saved: "저장됨",
  error: "저장 실패",
};

export interface SheetWorkbookProps {
  page: Page;
  /** 세션 잠금으로 인한 읽기 전용 */
  readOnly: boolean;
  username: string;
  /** 상단 탭 바에 "접속 N명"·"재연결 중…" 을 그리기 위해 세션 화면으로 올려 준다. */
  onCollabState?: (state: { collaboratorCount: number; connection: CollabConnection }) => void;
}

export default function SheetWorkbook({
  page,
  readOnly,
  username,
  onCollabState,
}: SheetWorkbookProps) {
  const [sheets, setSheets] = useState<WorkSheet[] | null>(null);
  /** 문서를 통째로 갈아 끼울 때(가져오기) 워크북을 새로 마운트하기 위한 키 */
  const [docKey, setDocKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [serverReadOnly, setServerReadOnly] = useState(false);

  const workbookRef = useRef<WorkbookInstance>(null);
  const versionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recalcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressUntilRef = useRef(0);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const aliveRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editable = !readOnly && !serverReadOnly;

  // ---- 초기 로딩 --------------------------------------------------------
  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getSheet(page.id);
        if (cancelled) return;
        const doc = normalizeDoc(result.data);
        versionRef.current = result.version;
        setServerReadOnly(result.readOnly);
        setSheets(doc.sheets);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "시트를 불러오지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, [page.id]);

  /**
   * 잠금 해제의 **보조 경로**.
   *
   * 주 경로는 시트 소켓의 `readonly` 이벤트지만, 그 순간 소켓이 재접속 중이었다면 놓칠 수 있다.
   * 세션 화면은 `session.updated` + 주기 폴링으로 `readOnly` prop 을 갱신하므로,
   * "세션은 안 잠겼는데 서버가 읽기 전용이라고 했던" 상태가 남으면 서버에 한 번 더 물어 정리한다.
   */
  useEffect(() => {
    if (readOnly || !serverReadOnly) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getSheet(page.id);
        if (cancelled || !aliveRef.current) return;
        if (result.version > versionRef.current) versionRef.current = result.version;
        setServerReadOnly(result.readOnly);
      } catch {
        // 실패하면 다음 신호(소켓 readonly 이벤트)를 기다린다.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [readOnly, serverReadOnly, page.id]);

  // ---- 수식 계산 --------------------------------------------------------
  const recalculate = useCallback((options: { broadcast: boolean }) => {
    const workbook = workbookRef.current;
    if (!workbook) return;
    let sheetId: string | undefined;
    try {
      sheetId = workbook.getSheet().id;
    } catch {
      return;
    }
    if (!sheetId) return;
    if (!options.broadcast) suppressUntilRef.current = Date.now() + SUPPRESS_MS;
    // 2회: 보조 열(=LEFT(...))이 먼저 채워져야 집계(SUMIFS)가 맞는다.
    workbook.calculateFormula(sheetId);
    workbook.calculateFormula(sheetId);
  }, []);

  const scheduleRecalculate = useCallback(() => {
    if (recalcTimerRef.current) return;
    recalcTimerRef.current = setTimeout(() => {
      recalcTimerRef.current = null;
      recalculate({ broadcast: true });
    }, RECALC_DEBOUNCE_MS);
  }, [recalculate]);

  // ---- 저장 -------------------------------------------------------------
  const save = useCallback(
    async (options: { keepalive?: boolean } = {}) => {
      const workbook = workbookRef.current;
      if (!workbook || !editable) return;
      if (savingRef.current) return;
      const all = workbook.getAllSheets() as unknown as WorkSheet[];
      if (!all || all.length === 0) return;

      savingRef.current = true;
      dirtyRef.current = false;
      if (aliveRef.current) setSaveStatus("saving");
      const doc = toStorableDoc(all);
      try {
        const result = await api.saveSheet(page.id, doc, versionRef.current, options);
        versionRef.current = result.version;
        if (aliveRef.current) {
          setSaveStatus("saved");
          setNotice(null);
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === "version_conflict") {
          // 다른 사람이 먼저 저장했다 — 최신 버전을 받아 한 번 더 시도한다.
          // (셀 단위 편집은 이미 실시간으로 합쳐져 있으므로 내용 손실은 없다.)
          try {
            const latest = await api.getSheet(page.id);
            versionRef.current = latest.version;
            const retry = await api.saveSheet(page.id, doc, latest.version, options);
            versionRef.current = retry.version;
            if (aliveRef.current) setSaveStatus("saved");
          } catch {
            if (aliveRef.current) setSaveStatus("error");
          }
        } else if (err instanceof ApiError && err.code === "session_locked") {
          if (aliveRef.current) {
            setServerReadOnly(true);
            setSaveStatus("idle");
          }
        } else if (aliveRef.current) {
          setSaveStatus("error");
        }
      } finally {
        savingRef.current = false;
      }
    },
    [editable, page.id],
  );

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimerRef.current) return;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  }, [save]);

  // ---- 실시간 동기화 -----------------------------------------------------
  const handleRemoteOps = useCallback((ops: unknown[]) => {
    try {
      workbookRef.current?.applyOp(ops as Op[]);
    } catch {
      // 적용할 수 없는 op 는 버린다 — 다음 저장·새로고침에서 맞춰진다.
    }
  }, []);

  const handleSaved = useCallback((version: number) => {
    // 다른 사람이 저장했다 — 내 baseVersion 을 맞춰 두면 불필요한 409 를 피한다.
    if (version > versionRef.current) versionRef.current = version;
  }, []);

  const handleReady = useCallback(
    (info: { version: number; readOnly: boolean; reconnected: boolean }) => {
      setServerReadOnly(info.readOnly);
      if (info.version > versionRef.current) versionRef.current = info.version;
      if (info.reconnected) {
        // 끊겨 있던 동안 남의 편집을 놓쳤을 수 있다 — 저장을 한 번 예약해 최신본을 남긴다.
        setNotice("연결이 끊겼던 동안의 변경은 새로고침하면 정확히 맞춰집니다.");
      }
    },
    [],
  );

  /**
   * 세션 잠금이 바뀌었다 — 서버가 소켓을 끊지 않고 새 `readOnly` 를 밀어 준다.
   * 예전에는 `ready` 시점 값만 썼기 때문에, 잠금 중에 열어 둔 시트는 관리자가 잠금을
   * 풀어도 새로고침 전까지 읽기 전용에 갇혀 있었다 (디버깅 리포트 [높음] 2).
   */
  const handleReadOnly = useCallback((next: boolean) => {
    setServerReadOnly(next);
  }, []);

  const sync = useSheetSync(page.id, {
    onOps: handleRemoteOps,
    onSaved: handleSaved,
    onReady: handleReady,
    onReadOnly: handleReadOnly,
  });

  const handleOp = useCallback(
    (ops: Op[]) => {
      // 초기 계산(또는 프로그램적 보정)으로 생긴 op 는 내보내지 않는다.
      if (Date.now() < suppressUntilRef.current) return;
      if (!editable) return;
      sync.sendOps(ops);
      scheduleSave();
      scheduleRecalculate();
    },
    [editable, scheduleRecalculate, scheduleSave, sync],
  );

  // 상단 바 배지 (M2 와 같은 UI 재사용 — "접속 N명"·"재연결 중…")
  useEffect(() => {
    onCollabState?.({ collaboratorCount: sync.members.length, connection: sync.connection });
  }, [onCollabState, sync.connection, sync.members.length]);
  useEffect(() => () => onCollabState?.({ collaboratorCount: 0, connection: "idle" }), [onCollabState]);

  // ---- 마운트 후 첫 계산 --------------------------------------------------
  useEffect(() => {
    if (!sheets) return;
    const timer = setTimeout(() => recalculate({ broadcast: false }), 150);
    return () => clearTimeout(timer);
  }, [sheets, docKey, recalculate]);

  // ---- 페이지를 떠날 때 저장 ----------------------------------------------
  useEffect(() => {
    const flush = () => {
      if (!dirtyRef.current) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void save({ keepalive: true });
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (recalcTimerRef.current) clearTimeout(recalcTimerRef.current);
    };
  }, [save]);

  // ---- 테스트 훅 (개발·E2E 전용) ------------------------------------------
  useEffect(() => {
    if (!EXPOSE_TEST_HOOKS) return;
    window.__sheetRef = workbookRef as unknown as { current: unknown };
    window.__sheetFlush = async () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await save();
    };
    window.__sheetRecalculate = () => recalculate({ broadcast: true });
    return () => {
      window.__sheetRef = undefined;
      window.__sheetFlush = undefined;
      window.__sheetRecalculate = undefined;
    };
  }, [recalculate, save]);
  useEffect(() => {
    if (!EXPOSE_TEST_HOOKS) return;
    window.__sheetSaveStatus = saveStatus;
    window.__sheetReady = sheets !== null;
  }, [saveStatus, sheets]);

  // ---- 내보내기 / 가져오기 ------------------------------------------------
  const currentSheets = useCallback((): WorkSheet[] => {
    const workbook = workbookRef.current;
    if (!workbook) return sheets ?? [];
    return workbook.getAllSheets() as unknown as WorkSheet[];
  }, [sheets]);

  const download = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    // 클릭 직후 앵커를 지우면 브라우저가 `download` 파일명을 잃고 "download" 로 저장한다.
    // URL 해제도 마찬가지로 한 박자 늦춘다.
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }, []);

  const exportXlsx = useCallback(() => {
    // Uint8Array 를 그대로 Blob 에 넣으면 lib.dom 타입(ArrayBuffer 고정)과 어긋난다 — 버퍼를 복사한다.
    const bytes = new Uint8Array(workbookToBytes(sheetsToWorkbook(currentSheets())));
    download(
      new Blob([bytes.buffer as ArrayBuffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${page.name}.xlsx`,
    );
  }, [currentSheets, download, page.name]);

  const exportCsv = useCallback(() => {
    const workbook = workbookRef.current;
    const all = currentSheets();
    let target = all[0];
    try {
      const active = workbook?.getSheet() as unknown as WorkSheet | undefined;
      if (active?.name) target = active;
    } catch {
      // 워크북이 아직 없으면 첫 시트를 쓴다.
    }
    if (!target) return;
    const csv = sheetToCsv(target);
    // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙인다.
    download(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }), `${page.name}-${target.name}.csv`);
  }, [currentSheets, download, page.name]);

  const importXlsx = useCallback(
    async (file: File) => {
      const workbook = workbookRef.current;
      if (!workbook || !editable) return;
      try {
        const parsed = workbookToSheets(bytesToWorkbook(await file.arrayBuffer()));
        const first = parsed[0];
        if (!first) {
          setNotice("가져올 시트가 없습니다.");
          return;
        }
        const cells = first.celldata ?? [];
        const rows = Math.max(...cells.map((c) => c.r), 0) + 1;
        const cols = Math.max(...cells.map((c) => c.c), 0) + 1;
        if (
          !window.confirm(
            `현재 시트의 내용을 '${file.name}' (${rows}행 × ${cols}열)로 바꿉니다. 계속할까요?`,
          )
        ) {
          return;
        }

        if (rows * cols <= MAX_IMPORT_OPS_CELLS) {
          // 작은 표는 셀 쓰기로 반영한다 — op 가 만들어져 다른 접속자에게도 바로 간다.
          const grid: Array<Array<Record<string, unknown> | null>> = Array.from(
            { length: rows },
            () => Array.from({ length: cols }, () => null),
          );
          for (const item of cells) {
            if (item.r < rows && item.c < cols) {
              grid[item.r]![item.c] = (item.v ?? null) as Record<string, unknown> | null;
            }
          }
          workbook.setCellValuesByRange(grid, { row: [0, rows - 1], column: [0, cols - 1] });
          setNotice(`'${file.name}' 을(를) 현재 시트에 가져왔습니다.`);
        } else {
          // 큰 표는 화면을 통째로 교체한다 (op 로 보내기엔 너무 크다).
          setSheets(parsed);
          setDocKey((key) => key + 1);
          setNotice(
            `'${file.name}' 을(를) 가져왔습니다. 표가 커서 다른 사람 화면에는 새로고침 후 반영됩니다.`,
          );
        }
        dirtyRef.current = true;
        setTimeout(() => {
          recalculate({ broadcast: true });
          void save();
        }, 200);
      } catch {
        setNotice("xlsx 파일을 읽지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요.");
      }
    },
    [editable, recalculate, save],
  );

  const settings = useMemo(
    () => ({
      lang: "en" as const,
      showToolbar: true,
      showFormulaBar: true,
      showSheetTabs: true,
      allowEdit: editable,
    }),
    [editable],
  );

  if (loadError) {
    return (
      <div className="centered-page">
        <p className="error" role="alert" data-testid="sheet-error">
          {loadError}
        </p>
      </div>
    );
  }
  if (!sheets) return <Spinner label="시트를 여는 중…" />;

  const collabMessage = collabNotice(sync.connection);

  return (
    <div className="sheet-wrapper" data-testid="sheet-wrapper">
      <div className="sheet-toolbar">
        <button
          type="button"
          className="button small"
          data-testid="sheet-export-xlsx"
          onClick={exportXlsx}
          title="워크북 전체를 엑셀 파일로 내려받습니다"
        >
          ⬇ xlsx 내보내기
        </button>
        <button
          type="button"
          className="button small"
          data-testid="sheet-export-csv"
          onClick={exportCsv}
          title="지금 보고 있는 시트를 CSV 로 내려받습니다"
        >
          ⬇ CSV 내보내기
        </button>
        {editable ? (
          <button
            type="button"
            className="button small"
            data-testid="sheet-import-xlsx"
            onClick={() => fileInputRef.current?.click()}
            title="엑셀 파일로 현재 시트를 바꿉니다"
          >
            ⬆ xlsx 가져오기
          </button>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          data-testid="sheet-import-input"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importXlsx(file);
          }}
        />
        <div className="spacer" />
        {sync.members.length > 1 ? (
          <span className="pill" data-testid="sheet-members" title="이 시트를 보고 있는 사람">
            👥 {sync.members.map((m) => (m.username === username ? `${m.username}(나)` : m.username)).join(", ")}
          </span>
        ) : null}
        {notice ? (
          <span className="sheet-notice" data-testid="sheet-notice" role="status">
            {notice}
          </span>
        ) : null}
        {collabMessage ? (
          <span className="sheet-notice" data-testid="collab-notice" role="status">
            {collabMessage}
          </span>
        ) : null}
        {!editable ? (
          <span className="pill" data-testid="sheet-readonly">
            읽기 전용
          </span>
        ) : null}
        <span
          className="save-status"
          data-testid="sheet-save-status"
          data-status={saveStatus}
          aria-live="polite"
        >
          {STATUS_LABEL[saveStatus]}
        </span>
      </div>

      <div className="sheet-canvas" data-testid="sheet-canvas">
        <Workbook
          key={docKey}
          ref={workbookRef}
          {...settings}
          data={sheets as unknown as Sheet[]}
          onOp={handleOp}
        />
      </div>
    </div>
  );
}

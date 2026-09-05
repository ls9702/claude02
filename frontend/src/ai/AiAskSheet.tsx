/**
 * 「AI에게 묻기」 시트 (PLAN §2.6, claude01 `AiAskSheet.tsx` 골격 이식).
 *
 * 흐름: 질문 입력 → (검색 기반 기본 ON) 물어보기 → 미리보기 카드 → 「캔버스에 추가」.
 *
 * **답변은 저장하지 않는다.** 시트를 닫으면 사라지고, 캔버스에 추가한 카드만 씬 데이터가 된다.
 * 오류도 전역으로 번지지 않는다 — 시트 안에서만 보여 주고 재시도는 사용자가 누른다.
 */
import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AiError, askAi, type AiCitation } from "./aiClient";
import { insertAiCard, selectedText } from "./insertCard";
import { MAX_SOURCES, MAX_USER_TEXT, buildAskPrompt, parseCard, truncate } from "./prompts";

export interface AiAskSheetProps {
  pageId: string;
  excalidrawAPI: ExcalidrawImperativeAPI;
  /** 카드에 남길 만든 이 */
  username: string;
  /** 잠긴 세션 — 카드 추가를 막는다 (질문은 할 수 있다) */
  readOnly: boolean;
  onClose: () => void;
}

interface Answer {
  question: string;
  grounding: boolean;
  title: string;
  bullets: string[];
  sources: AiCitation[];
  /** 규약을 지키지 않은 답변을 폴백 파서로 읽었는가 (표시용) */
  conformed: boolean;
}

const errorText = (err: unknown): string =>
  err instanceof AiError ? err.message : err instanceof Error ? err.message : "알 수 없는 오류입니다.";

export function AiAskSheet({ pageId, excalidrawAPI, username, readOnly, onClose }: AiAskSheetProps) {
  // 시트를 열 때 선택돼 있던 텍스트를 참고 자료로 붙잡아 둔다 (그 뒤 선택이 바뀌어도 흔들리지 않게).
  const picked = useRef(selectedText(excalidrawAPI)).current;
  const [question, setQuestion] = useState(() => truncate(picked, MAX_USER_TEXT));
  const [grounding, setGrounding] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ask = async (asked: string): Promise<void> => {
    const text = asked.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setAdded(false);
    // 이전 답변 미리보기를 지워 재질문 중 옛 카드가 추가되지 않게 한다.
    setAnswer(null);
    try {
      const { prompt, context } = buildAskPrompt(text, picked === text ? "" : picked);
      const result = await askAi({ pageId, prompt, grounding, context });
      const card = parseCard(result.text);
      if (!card.title && card.bullets.length === 0) {
        setError("AI 응답을 이해하지 못했습니다.");
        setAnswer(null);
        return;
      }
      setAnswer({
        question: text,
        grounding,
        title: card.title,
        bullets: card.bullets,
        sources: result.citations.slice(0, MAX_SOURCES),
        conformed: card.conformed,
      });
    } catch (err) {
      setError(errorText(err));
      setAnswer(null);
    } finally {
      setBusy(false);
    }
  };

  const addToCanvas = (): void => {
    if (!answer || readOnly) return;
    try {
      insertAiCard(excalidrawAPI, {
        title: answer.title,
        bullets: answer.bullets,
        sources: answer.sources,
        query: answer.question,
        by: username,
      });
      setAdded(true);
    } catch {
      setError("카드를 캔버스에 넣지 못했습니다.");
    }
  };

  return (
    <aside className="ai-sheet" data-testid="ai-sheet" aria-label="AI에게 묻기">
      <header className="ai-sheet-head">
        <h2>✨ AI에게 묻기</h2>
        <button type="button" className="button small" data-testid="ai-close" onClick={onClose}>
          닫기
        </button>
      </header>

      <form
        className="ai-ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <label className="ai-field">
          <span className="muted small">질문</span>
          <textarea
            autoFocus
            rows={3}
            value={question}
            maxLength={MAX_USER_TEXT}
            placeholder="예: 서울 근교 워크숍 장소 추천"
            data-testid="ai-input"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask(question);
              }
            }}
          />
        </label>

        <label className="ai-checkbox">
          <input
            type="checkbox"
            checked={grounding}
            data-testid="ai-grounding"
            onChange={(event) => setGrounding(event.target.checked)}
          />
          검색 기반 (끄면 모델이 아는 범위에서만 답합니다)
        </label>

        {picked ? (
          <p className="muted small" data-testid="ai-context-note">
            선택한 텍스트({picked.length}자)를 참고 자료로 함께 보냅니다.
          </p>
        ) : null}

        <div className="modal-actions">
          <button
            type="submit"
            className="button primary small"
            data-testid="ai-submit"
            disabled={busy || question.trim() === ""}
          >
            {busy ? "묻는 중…" : "물어보기"}
          </button>
        </div>
      </form>

      {busy ? (
        <p className="muted small" data-testid="ai-busy" role="status">
          AI가 답을 찾고 있습니다… (검색 기반은 몇 초 걸릴 수 있습니다)
        </p>
      ) : null}

      {error ? (
        <p className="error small" data-testid="ai-error" role="alert">
          {error}
        </p>
      ) : null}

      {answer ? (
        <div className="ai-preview" data-testid="ai-preview">
          <h3 data-testid="ai-preview-title">{answer.title}</h3>
          <ul>
            {answer.bullets.map((bullet, index) => (
              <li key={index} data-testid="ai-preview-bullet">
                {bullet}
              </li>
            ))}
          </ul>
          {answer.sources.length > 0 ? (
            <ul className="ai-sources">
              {answer.sources.map((source) => (
                <li key={source.url}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="ai-source"
                    title={source.url}
                  >
                    {source.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="muted small" data-testid="ai-preview-meta">
            Gemini · 검색 {answer.sources.length}건
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button small"
              data-testid="ai-retry"
              disabled={busy}
              onClick={() => void ask(answer.question)}
            >
              다시 묻기
            </button>
            {!readOnly ? (
              <button
                type="button"
                className="button primary small"
                data-testid="ai-insert"
                onClick={addToCanvas}
              >
                캔버스에 추가
              </button>
            ) : null}
          </div>
          {added ? (
            <p className="muted small" data-testid="ai-added" role="status">
              카드를 캔버스에 넣었습니다. 이제 평범한 요소라 옮기고 고칠 수 있습니다.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="muted small">
        질문은 서버를 거쳐 Google Gemini로 전송됩니다. 답변은 저장되지 않으며, 캔버스에 추가한
        카드만 남습니다.
      </p>
    </aside>
  );
}

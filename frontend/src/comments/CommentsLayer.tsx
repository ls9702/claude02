/**
 * 오브젝트 댓글 레이어 (PLAN §2.5).
 *
 * 구성
 * - **오버레이**: 캔버스 위에 겹치는 절대 위치 레이어. 평소에는 `pointer-events:none` 이고
 *   핀·팝오버만 이벤트를 받는다. "💬 댓글" 모드에서는 레이어 전체가 이벤트를 받아
 *   클릭이 Excalidraw 로 내려가지 않게 한다.
 * - **위치 계산**: 댓글의 씬 좌표(`anchor.ts`)를 `sceneCoordsToViewportCoords` 로 옮긴 뒤
 *   컨테이너 기준(`offsetLeft/offsetTop` 을 뺀 값)으로 배치한다. 줌·스크롤·요소 이동은
 *   Excalidraw `onChange` 에서 알려 주고(부모가 `onSceneChange()` 호출),
 *   계산은 `requestAnimationFrame` 으로 한 프레임에 한 번만 한다.
 * - **고아 전환**: 앵커 요소가 삭제되면 핀은 마지막 위치에 남고 "요소 삭제됨" 을 표시한다.
 *   이때 저장 좌표를 **한 번만** 서버에 반영한다(이후에는 좌표 앵커처럼 동작한다).
 */
import { CaptureUpdateAction, sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Comment } from "../api";
import {
  anchorScenePoint,
  elementAnchor,
  hitTestTopmost,
  indexElements,
  needsOrphanCoordUpdate,
  type AnchorElement,
} from "./anchor";
import { CommentsSidebar } from "./CommentsSidebar";
import { CommentThread } from "./CommentThread";
import { colorOf, initialOf } from "./format";
import { useComments } from "./useComments";

/** 부모(CanvasPage)가 씬 변경을 알려 주는 핸들 */
export interface CommentsLayerHandle {
  /** Excalidraw `onChange` 마다 호출 — 다음 프레임에 핀 위치를 다시 계산한다. */
  onSceneChange(): void;
}

export interface CommentsLayerProps {
  pageId: string;
  excalidrawAPI: ExcalidrawImperativeAPI;
  currentUserId: string;
  isAdmin: boolean;
  /** 잠긴 세션 — 작성·답글·삭제를 감춘다 (해결 처리는 남긴다). */
  readOnly: boolean;
  /** 상단 바 배지용 미해결 수 */
  onUnresolvedChange?: (count: number) => void;
}

type Mode = "idle" | "picking" | "composing";

interface Placement {
  left: number;
  top: number;
}

interface Pin extends Placement {
  comment: Comment;
  orphaned: boolean;
  sceneX: number;
  sceneY: number;
}

interface Draft {
  elementId: string | null;
  sceneX: number;
  sceneY: number;
}

/** 팝오버가 컨테이너 밖으로 나가지 않게 살짝 밀어 넣는다. */
function clamp(placement: Placement, size: { width: number; height: number }, popover: { w: number; h: number }): Placement {
  const left = Math.max(8, Math.min(placement.left, Math.max(8, size.width - popover.w - 8)));
  const top = Math.max(8, Math.min(placement.top, Math.max(8, size.height - popover.h - 8)));
  return { left, top };
}

const toStyle = (placement: Placement) => ({ left: `${placement.left}px`, top: `${placement.top}px` });

export const CommentsLayer = forwardRef<CommentsLayerHandle, CommentsLayerProps>(
  function CommentsLayer(
    { pageId, excalidrawAPI, currentUserId, isAdmin, readOnly, onUnresolvedChange },
    ref,
  ) {
    const { comments, unresolvedCount, loading, error, connection, actions } = useComments(pageId);

    const [mode, setMode] = useState<Mode>("idle");
    const [draft, setDraft] = useState<Draft | null>(null);
    const [draftBody, setDraftBody] = useState("");
    const [draftError, setDraftError] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [showResolved, setShowResolved] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [pins, setPins] = useState<Pin[]>([]);
    const [draftPlacement, setDraftPlacement] = useState<Placement | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    /** 고아 전환 좌표를 이미 서버에 반영한 댓글 (한 번만 보낸다) */
    const orphanPatched = useRef(new Set<string>());
    const frameRef = useRef<number | null>(null);
    const recomputeRef = useRef<() => void>(() => {});

    const visible = useMemo(
      () => (showResolved ? comments : comments.filter((c) => !c.resolved)),
      [comments, showResolved],
    );

    useEffect(() => {
      onUnresolvedChange?.(unresolvedCount);
    }, [unresolvedCount, onUnresolvedChange]);

    useEffect(() => () => onUnresolvedChange?.(0), [onUnresolvedChange]);

    // ---- 핀 위치 계산 ---------------------------------------------------
    const recompute = useCallback(() => {
      const appState = excalidrawAPI.getAppState();
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as unknown as AnchorElement[];
      const index = indexElements(elements);
      const view = {
        zoom: appState.zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        offsetLeft: appState.offsetLeft,
        offsetTop: appState.offsetTop,
      };
      const place = (sceneX: number, sceneY: number): Placement => {
        const viewport = sceneCoordsToViewportCoords({ sceneX, sceneY }, view);
        // 오버레이는 Excalidraw 컨테이너와 같은 상자다 — 페이지 기준 오프셋을 뺀다.
        return { left: viewport.x - view.offsetLeft, top: viewport.y - view.offsetTop };
      };

      setSize({ width: appState.width, height: appState.height });
      setPins(
        visible.map((comment) => {
          const point = anchorScenePoint(comment, index);
          return {
            comment,
            orphaned: point.orphaned,
            sceneX: point.sceneX,
            sceneY: point.sceneY,
            ...place(point.sceneX, point.sceneY),
          };
        }),
      );

      if (draft) {
        // 작성 중인 댓글의 팝오버도 같은 규칙으로 따라간다 (요소 앵커면 요소를 따라감).
        const point = anchorScenePoint(
          { elementId: draft.elementId, x: draft.sceneX, y: draft.sceneY },
          index,
        );
        setDraftPlacement(place(point.sceneX, point.sceneY));
      } else {
        setDraftPlacement(null);
      }

      // 고아로 바뀐 댓글의 저장 좌표를 한 번만 갱신한다 (잠긴 세션에서는 하지 않는다).
      if (readOnly) return;
      for (const comment of comments) {
        if (orphanPatched.current.has(comment.id)) continue;
        const point = anchorScenePoint(comment, index);
        if (!needsOrphanCoordUpdate(comment, point)) continue;
        orphanPatched.current.add(comment.id);
        void actions.patch(comment.id, { x: point.sceneX, y: point.sceneY }).catch(() => {
          // 실패해도 다시 시도하지 않는다 — 화면 표시는 이미 마지막 위치를 쓰고 있다.
        });
      }
    }, [excalidrawAPI, visible, comments, draft, readOnly, actions]);

    recomputeRef.current = recompute;

    const schedule = useCallback(() => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        recomputeRef.current();
      });
    }, []);

    useImperativeHandle(ref, () => ({ onSceneChange: schedule }), [schedule]);

    // 댓글 목록·모드가 바뀌면 즉시 다시 계산한다.
    useEffect(() => {
      recompute();
    }, [recompute]);

    // 줌·스크롤은 onChange 로도 오지만, 창 크기 변경과 함께 여기서도 받아 둔다.
    useEffect(() => {
      const unsubscribe = excalidrawAPI.onScrollChange?.(() => schedule());
      window.addEventListener("resize", schedule);
      return () => {
        unsubscribe?.();
        window.removeEventListener("resize", schedule);
      };
    }, [excalidrawAPI, schedule]);

    useEffect(() => {
      return () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      };
    }, []);

    // 열려 있던 댓글이 사라지면 팝오버도 닫는다.
    useEffect(() => {
      if (openId && !comments.some((c) => c.id === openId)) setOpenId(null);
    }, [comments, openId]);

    // ESC: 모드·팝오버 취소
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        if (mode !== "idle" || draft) {
          setMode("idle");
          setDraft(null);
          setDraftBody("");
        } else if (openId) {
          setOpenId(null);
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [mode, draft, openId]);

    // ---- 댓글 만들기 ----------------------------------------------------
    const onOverlayPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mode === "idle") return;
      // 팝오버 안쪽 클릭은 여기까지 오지 않는다 (자식에서 stopPropagation) —
      // 여기로 왔다면 바깥을 누른 것이므로 작성을 취소한다.
      if (mode === "composing") {
        cancelDraft();
        return;
      }
      event.preventDefault();

      const appState = excalidrawAPI.getAppState();
      const scene = viewportCoordsToSceneCoords(
        { clientX: event.clientX, clientY: event.clientY },
        {
          zoom: appState.zoom,
          offsetLeft: appState.offsetLeft,
          offsetTop: appState.offsetTop,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
        },
      );
      const elements = excalidrawAPI.getSceneElements() as unknown as AnchorElement[];
      const hit = hitTestTopmost(elements, scene.x, scene.y);
      const anchor = hit ? elementAnchor(hit) : { sceneX: scene.x, sceneY: scene.y };

      setDraft({ elementId: hit?.id ?? null, sceneX: anchor.sceneX, sceneY: anchor.sceneY });
      setDraftBody("");
      setDraftError(null);
      setMode("composing");
      setOpenId(null);
    };

    const submitDraft = async (event: FormEvent) => {
      event.preventDefault();
      if (!draft) return;
      const body = draftBody.trim();
      if (!body) {
        setDraftError("댓글 내용을 입력해 주세요.");
        return;
      }
      try {
        await actions.create({ elementId: draft.elementId, x: draft.sceneX, y: draft.sceneY, body });
        setDraft(null);
        setDraftBody("");
        setDraftError(null);
        setMode("idle");
      } catch (err) {
        setDraftError(err instanceof Error ? err.message : "댓글을 저장하지 못했습니다.");
      }
    };

    const cancelDraft = () => {
      setDraft(null);
      setDraftBody("");
      setDraftError(null);
      setMode("idle");
    };

    // ---- 목록에서 이동 --------------------------------------------------
    const focusComment = (comment: Comment) => {
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as unknown as AnchorElement[];
      const point = anchorScenePoint(comment, indexElements(elements));
      const appState = excalidrawAPI.getAppState();
      const zoom = appState.zoom.value;
      excalidrawAPI.updateScene({
        appState: {
          scrollX: appState.width / 2 / zoom - point.sceneX,
          scrollY: appState.height / 2 / zoom - point.sceneY,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (comment.resolved) setShowResolved(true);
      setOpenId(comment.id);
      schedule();
    };

    const openPin = pins.find((pin) => pin.comment.id === openId) ?? null;
    const openComment = comments.find((c) => c.id === openId) ?? null;

    return (
      <>
        <div
          className={`comments-overlay${mode === "idle" ? "" : " capturing"}`}
          data-testid="comments-overlay"
          data-mode={mode}
          onPointerDown={onOverlayPointerDown}
        >
          {pins.map((pin) => (
            <div
              key={pin.comment.id}
              className="comment-pin-wrap"
              style={{ left: `${pin.left}px`, top: `${pin.top}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className={`comment-pin${pin.comment.resolved ? " resolved" : ""}`}
                style={pin.comment.resolved ? undefined : { background: colorOf(pin.comment.author?.username) }}
                data-testid="comment-pin"
                data-comment-id={pin.comment.id}
                data-resolved={pin.comment.resolved ? "1" : "0"}
                data-orphaned={pin.orphaned ? "1" : "0"}
                title={pin.comment.body}
                onClick={() => setOpenId((prev) => (prev === pin.comment.id ? null : pin.comment.id))}
              >
                {initialOf(pin.comment.author?.username)}
              </button>
              {pin.orphaned ? (
                <span className="comment-pin-orphan" data-testid="comment-pin-orphan">
                  요소 삭제됨
                </span>
              ) : null}
            </div>
          ))}

          {openComment && openPin ? (
            <div
              className="comment-popover"
              style={toStyle(clamp({ left: openPin.left + 24, top: openPin.top }, size, { w: 280, h: 260 }))}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <CommentThread
                comment={openComment}
                currentUserId={currentUserId}
                isAdmin={isAdmin}
                readOnly={readOnly}
                onReply={async (body) => {
                  await actions.reply(openComment.id, body);
                }}
                onToggleResolved={async () => {
                  await actions.patch(openComment.id, { resolved: !openComment.resolved });
                  if (!openComment.resolved && !showResolved) setOpenId(null);
                }}
                onDelete={async () => {
                  await actions.remove(openComment.id);
                  setOpenId(null);
                }}
                onDeleteReply={async (replyId) => {
                  await actions.removeReply(replyId, openComment.id);
                }}
                onClose={() => setOpenId(null)}
              />
            </div>
          ) : null}

          {draft && draftPlacement ? (
            <form
              className="comment-popover comment-composer"
              data-testid="comment-composer"
              style={toStyle(
                clamp({ left: draftPlacement.left + 24, top: draftPlacement.top }, size, { w: 280, h: 160 }),
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onSubmit={submitDraft}
            >
              <p className="muted small">
                {draft.elementId ? "선택한 요소에 댓글을 답니다." : "이 위치에 댓글을 답니다."}
              </p>
              <textarea
                autoFocus
                rows={3}
                value={draftBody}
                placeholder="댓글 내용을 입력하세요"
                data-testid="comment-input"
                onChange={(event) => setDraftBody(event.target.value)}
              />
              {draftError ? (
                <p className="error small" role="alert">
                  {draftError}
                </p>
              ) : null}
              <div className="modal-actions">
                <button type="button" className="button small" onClick={cancelDraft}>
                  취소
                </button>
                <button type="submit" className="button primary small" data-testid="comment-submit">
                  저장
                </button>
              </div>
            </form>
          ) : null}
        </div>

        <div className={`comments-toolbar${sidebarOpen ? " with-sidebar" : ""}`}>
          {!readOnly ? (
            <button
              type="button"
              className={`button small${mode === "idle" ? "" : " primary"}`}
              data-testid="comment-mode"
              data-active={mode === "idle" ? "0" : "1"}
              aria-pressed={mode !== "idle"}
              onClick={() => {
                if (mode === "idle") {
                  setMode("picking");
                  setOpenId(null);
                } else {
                  cancelDraft();
                }
              }}
            >
              💬 댓글{mode === "picking" ? " (캔버스를 클릭)" : ""}
            </button>
          ) : null}
          <button
            type="button"
            className="button small"
            data-testid="comments-sidebar-toggle"
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen((prev) => !prev)}
          >
            목록 {unresolvedCount}
          </button>
          {connection === "reconnecting" ? (
            <span className="pill" data-testid="comments-reconnecting" title="댓글 실시간 연결이 끊겼습니다">
              댓글 재연결 중…
            </span>
          ) : null}
        </div>

        {sidebarOpen ? (
          <CommentsSidebar
            comments={comments}
            showResolved={showResolved}
            loading={loading}
            error={error}
            onToggleResolved={setShowResolved}
            onSelect={focusComment}
            onClose={() => setSidebarOpen(false)}
          />
        ) : null}
      </>
    );
  },
);

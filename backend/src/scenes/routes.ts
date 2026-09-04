import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import {
  MAX_SNAPSHOTS_PER_PAGE,
  MAX_THUMBNAIL_BYTES,
  SNAPSHOT_EVERY_N_SAVES,
  SNAPSHOT_MAX_AGE_MS,
} from "../config.js";
import { badRequest, notFound, payloadTooLarge } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { SceneRow } from "../types.js";
import { asObject } from "../validate.js";
import {
  differsFromIncoming,
  pickSharedAppState,
  reconcileElements,
  type ReconcilableElement,
} from "./reconcile.js";

interface IdParams {
  id: string;
}
interface SnapshotParams {
  id: string;
  snapId: string;
}

function readScene(app: FastifyInstance, pageId: string): SceneRow {
  const row = app.db
    .prepare<[string], SceneRow>("SELECT * FROM scenes WHERE page_id = ?")
    .get(pageId);
  if (row) return row;
  const at = nowIso();
  app.db
    .prepare(
      "INSERT INTO scenes (page_id, elements, app_state, version, updated_at, updated_by) VALUES (?, '[]', '{}', 0, ?, NULL)",
    )
    .run(pageId, at);
  return app.db.prepare<[string], SceneRow>("SELECT * FROM scenes WHERE page_id = ?").get(pageId)!;
}

function parseElements(json: string): ReconcilableElement[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReconcilableElement[]) : [];
  } catch {
    return [];
  }
}

function parseAppState(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function maybeSnapshot(app: FastifyInstance, pageId: string, version: number, elements: string, appState: string): void {
  const latest = app.db
    .prepare<[string], { created_at: string }>(
      "SELECT created_at FROM scene_snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(pageId);

  const byCount = version % SNAPSHOT_EVERY_N_SAVES === 0;
  const age = latest ? Date.now() - Date.parse(latest.created_at) : Number.POSITIVE_INFINITY;
  const byAge = age >= SNAPSHOT_MAX_AGE_MS;
  if (!byCount && !byAge) return;

  app.db
    .prepare(
      "INSERT INTO scene_snapshots (id, page_id, elements, app_state, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(newId(), pageId, elements, appState, nowIso());

  // 페이지당 최근 N개만 남긴다.
  app.db
    .prepare(
      `DELETE FROM scene_snapshots
        WHERE page_id = ?
          AND id NOT IN (
            SELECT id FROM scene_snapshots WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
          )`,
    )
    .run(pageId, pageId, MAX_SNAPSHOTS_PER_PAGE);
}

export async function sceneRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: IdParams }>("/api/pages/:id/scene", async (req) => {
    const { page } = requirePageAccess(app.db, req.user!, req.params.id);
    if (page.type !== "canvas") throw badRequest("캔버스 페이지가 아닙니다.");
    const scene = readScene(app, page.id);
    return {
      elements: parseElements(scene.elements),
      appState: parseAppState(scene.app_state),
      version: scene.version,
    };
  });

  app.put<{ Params: IdParams }>("/api/pages/:id/scene", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    if (page.type !== "canvas") throw badRequest("캔버스 페이지가 아닙니다.");
    assertWritable(session, req.user!);

    const body = asObject(req.body);
    const incomingRaw = body.elements;
    if (!Array.isArray(incomingRaw)) throw badRequest("elements 는 배열이어야 합니다.");
    const incoming = incomingRaw as ReconcilableElement[];

    const scene = readScene(app, page.id);
    const stored = parseElements(scene.elements);
    const merged = reconcileElements(stored, incoming);
    const changed = differsFromIncoming(merged, incoming);

    const appState = { ...parseAppState(scene.app_state), ...pickSharedAppState(body.appState) };
    const version = scene.version + 1;
    const at = nowIso();
    const elementsJson = JSON.stringify(merged);
    const appStateJson = JSON.stringify(appState);

    app.db
      .prepare(
        "UPDATE scenes SET elements = ?, app_state = ?, version = ?, updated_at = ?, updated_by = ? WHERE page_id = ?",
      )
      .run(elementsJson, appStateJson, version, at, req.user!.id, page.id);
    app.db.prepare("UPDATE pages SET updated_at = ? WHERE id = ?").run(at, page.id);

    maybeSnapshot(app, page.id, version, elementsJson, appStateJson);

    return { elements: merged, appState, version, changed };
  });

  app.get<{ Params: IdParams }>("/api/pages/:id/snapshots", async (req) => {
    const { page } = requirePageAccess(app.db, req.user!, req.params.id);
    const rows = app.db
      .prepare<[string], { id: string; created_at: string }>(
        "SELECT id, created_at FROM scene_snapshots WHERE page_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(page.id);
    return { snapshots: rows };
  });

  app.post<{ Params: SnapshotParams }>("/api/pages/:id/snapshots/:snapId/restore", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);

    const snap = app.db
      .prepare<[string, string], { elements: string; app_state: string }>(
        "SELECT elements, app_state FROM scene_snapshots WHERE id = ? AND page_id = ?",
      )
      .get(req.params.snapId, page.id);
    if (!snap) throw notFound("스냅샷을 찾을 수 없습니다.");

    const scene = readScene(app, page.id);
    const version = scene.version + 1;
    const at = nowIso();
    app.db
      .prepare(
        "UPDATE scenes SET elements = ?, app_state = ?, version = ?, updated_at = ?, updated_by = ? WHERE page_id = ?",
      )
      .run(snap.elements, snap.app_state, version, at, req.user!.id, page.id);

    return {
      elements: parseElements(snap.elements),
      appState: parseAppState(snap.app_state),
      version,
    };
  });

  // ---- 썸네일 ----------------------------------------------------------
  app.put<{ Params: IdParams }>(
    "/api/pages/:id/thumbnail",
    { bodyLimit: MAX_THUMBNAIL_BYTES },
    async (req) => {
      const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
      assertWritable(session, req.user!);
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw badRequest("PNG 이미지가 필요합니다.");
      if (body.length > MAX_THUMBNAIL_BYTES) throw payloadTooLarge("썸네일은 200KB 이하여야 합니다.");
      app.db
        .prepare("UPDATE pages SET thumbnail = ?, updated_at = ? WHERE id = ?")
        .run(body, nowIso(), page.id);
      return { ok: true };
    },
  );

  app.get<{ Params: IdParams }>("/api/pages/:id/thumbnail", async (req, reply) => {
    const { page } = requirePageAccess(app.db, req.user!, req.params.id);
    const row = app.db
      .prepare<[string], { thumbnail: Buffer | null }>("SELECT thumbnail FROM pages WHERE id = ?")
      .get(page.id);
    if (!row?.thumbnail) throw notFound("썸네일이 없습니다.");
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "private, max-age=60");
    return reply.send(row.thumbnail);
  });
}

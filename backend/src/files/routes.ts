import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { MAX_FILE_BYTES } from "../config.js";
import { badRequest, forbidden, notFound, payloadTooLarge } from "../errors.js";
import { nowIso } from "../ids.js";
import type { FileRow } from "../types.js";
import { asObject } from "../validate.js";
import { canAccessFile, fileIdsForPages, filePathFor } from "./storage.js";

interface IdParams {
  id: string;
}
interface FileParams {
  fileId: string;
}

/** Excalidraw fileId 는 해시 문자열이다. 경로 조작을 막기 위해 엄격히 검사한다. */
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `files/exists` 한 번에 확인할 수 있는 최대 id 수 */
const MAX_EXISTS_IDS = 500;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{ Params: IdParams }>("/api/pages/:id/files", async (req, reply) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);

    if (!req.isMultipart()) throw badRequest("multipart/form-data 요청이 필요합니다.");

    const fields: Record<string, string> = {};
    let buffer: Buffer | null = null;
    let detectedMime: string | null = null;
    let truncated = false;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        truncated = part.file.truncated;
        buffer = Buffer.concat(chunks);
        detectedMime = part.mimetype || null;
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }

    if (truncated) throw payloadTooLarge("파일은 5MB 이하여야 합니다.");
    if (!buffer || buffer.length === 0) throw badRequest("업로드할 파일이 없습니다.");
    if (buffer.length > MAX_FILE_BYTES) throw payloadTooLarge("파일은 5MB 이하여야 합니다.");

    const fileId = fields.fileId ?? "";
    if (!FILE_ID_RE.test(fileId)) throw badRequest("fileId 형식이 올바르지 않습니다.");

    const mime = fields.mime || detectedMime || "";
    if (!ALLOWED_MIME.has(mime)) throw badRequest("지원하지 않는 이미지 형식입니다.");

    const link = app.db.prepare(
      "INSERT OR IGNORE INTO page_files (page_id, file_id, created_at) VALUES (?, ?, ?)",
    );

    const existing = app.db
      .prepare<[string], FileRow>("SELECT * FROM files WHERE id = ?")
      .get(fileId);
    if (existing) {
      // 같은 fileId 는 같은 내용이다 (Excalidraw 가 내용 해시로 만든다).
      // 파일은 다시 저장하지 않고, 이 페이지와의 링크만 추가한다.
      link.run(page.id, existing.id, nowIso());
      reply.code(200);
      return { id: existing.id, deduplicated: true };
    }

    const relative = filePathFor(fileId);
    const absolute = join(app.config.dataDir, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);

    const at = nowIso();
    app.db.transaction(() => {
      app.db
        .prepare(
          "INSERT INTO files (id, mime, size, path, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(fileId, mime, buffer.length, relative, at, req.user!.id);
      link.run(page.id, fileId, at);
    })();

    reply.code(201);
    return { id: fileId, deduplicated: false };
  });

  /**
   * 협업 중 FileManager 가 "이 파일들은 이미 서버에 있나?" 를 묻는 엔드포인트.
   * 이미 있는 파일은 다시 올리지 않는다.
   *
   * 판정은 **이 페이지에 링크된 파일**(`page_files`)로 한정한다. 전역 `files` 테이블을
   * 그대로 조회하면 fileId(= 내용 해시)를 아는 사람이 "그 이미지가 다른 세션에
   * 올라와 있는지" 를 알아낼 수 있는 교차 세션 존재-오라클이 된다.
   */
  app.post<{ Params: IdParams }>("/api/pages/:id/files/exists", async (req) => {
    const { page } = requirePageAccess(app.db, req.user!, req.params.id);

    const body = asObject(req.body);
    const raw = body.ids;
    if (!Array.isArray(raw)) throw badRequest("ids 는 배열이어야 합니다.");
    if (raw.length > MAX_EXISTS_IDS) throw badRequest("한 번에 확인할 수 있는 파일 수를 넘었습니다.");

    const ids = raw.filter((id): id is string => typeof id === "string" && FILE_ID_RE.test(id));
    if (ids.length === 0) return { existing: [] };

    const linked = new Set(fileIdsForPages(app.db, [page.id]));
    return { existing: ids.filter((id) => linked.has(id)) };
  });

  app.get<{ Params: FileParams }>("/files/:fileId", async (req, reply) => {
    const { fileId } = req.params;
    if (!FILE_ID_RE.test(fileId)) throw notFound("파일을 찾을 수 없습니다.");

    const row = app.db.prepare<[string], FileRow>("SELECT * FROM files WHERE id = ?").get(fileId);
    if (!row) throw notFound("파일을 찾을 수 없습니다.");

    // 이 파일과 링크된 페이지 중 하나라도 접근할 수 있으면 통과한다.
    if (!canAccessFile(app.db, req.user!, fileId)) {
      throw forbidden("이 파일에 접근할 권한이 없습니다.");
    }

    reply.header("Content-Type", row.mime);
    reply.header("Content-Length", String(row.size));
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(createReadStream(join(app.config.dataDir, row.path)));
  });
}

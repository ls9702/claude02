import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { MAX_FILE_BYTES } from "../config.js";
import { badRequest, notFound, payloadTooLarge } from "../errors.js";
import { nowIso } from "../ids.js";
import type { FileRow } from "../types.js";

interface IdParams {
  id: string;
}
interface FileParams {
  fileId: string;
}

/** Excalidraw fileId 는 해시 문자열이다. 경로 조작을 막기 위해 엄격히 검사한다. */
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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

    const existing = app.db
      .prepare<[string], FileRow>("SELECT * FROM files WHERE id = ?")
      .get(fileId);
    if (existing) {
      // 같은 fileId 는 같은 내용이다 (Excalidraw 가 내용 해시로 만든다) — 중복 저장하지 않는다.
      reply.code(200);
      return { id: existing.id, deduplicated: true };
    }

    const dir = join(app.config.dataDir, "files", page.id);
    await mkdir(dir, { recursive: true });
    const absolute = join(dir, fileId);
    await writeFile(absolute, buffer);

    const relative = join("files", page.id, fileId);
    app.db
      .prepare(
        "INSERT INTO files (id, page_id, mime, size, path, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(fileId, page.id, mime, buffer.length, relative, nowIso(), req.user!.id);

    reply.code(201);
    return { id: fileId, deduplicated: false };
  });

  app.get<{ Params: FileParams }>("/files/:fileId", async (req, reply) => {
    const { fileId } = req.params;
    if (!FILE_ID_RE.test(fileId)) throw notFound("파일을 찾을 수 없습니다.");

    const row = app.db.prepare<[string], FileRow>("SELECT * FROM files WHERE id = ?").get(fileId);
    if (!row) throw notFound("파일을 찾을 수 없습니다.");

    // 파일이 속한 페이지에 접근 권한이 있어야 한다.
    requirePageAccess(app.db, req.user!, row.page_id);

    reply.header("Content-Type", row.mime);
    reply.header("Content-Length", String(row.size));
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(createReadStream(join(app.config.dataDir, row.path)));
  });
}

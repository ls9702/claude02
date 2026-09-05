/**
 * 시트 REST — 초기 로딩과 전체 저장.
 *
 * 실시간 편집은 `/ws/sheet/:pageId` 로 op 를 중계하고(ws.ts), **저장은 여기로** 온다:
 * 각 클라이언트가 op 를 적용한 뒤 전체 `sheets` JSON 을 5초 디바운스로 올린다.
 * `baseVersion` 이 서버의 현재 버전과 다르면 409 를 주고, 클라이언트는 최신 버전을
 * 다시 읽어 반영한 뒤 재시도한다(셀 단위 op 는 이미 실시간으로 합쳐져 있으므로
 * 실제 충돌은 "누가 마지막으로 스냅샷을 올렸나" 뿐이다).
 */
import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { badRequest, conflict } from "../errors.js";
import { nowIso } from "../ids.js";
import { asObject, optionalNumber } from "../validate.js";
import { readSheet, validateSheetDoc } from "./service.js";

interface IdParams {
  id: string;
}

export async function sheetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: IdParams }>("/api/pages/:id/sheet", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    if (page.type !== "sheet") throw badRequest("시트 페이지가 아닙니다.");
    const stored = readSheet(app.db, page.id);
    return {
      data: stored.data,
      version: stored.version,
      updatedAt: stored.updatedAt,
      readOnly: session.locked === 1 && req.user!.role !== "admin",
    };
  });

  app.put<{ Params: IdParams }>("/api/pages/:id/sheet", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    if (page.type !== "sheet") throw badRequest("시트 페이지가 아닙니다.");
    assertWritable(session, req.user!);

    const body = asObject(req.body);
    const { json } = validateSheetDoc(body.data);
    const baseVersion = optionalNumber(body, "baseVersion", "버전", { min: 0, max: 1e9 });

    const current = readSheet(app.db, page.id);
    if (baseVersion !== undefined && baseVersion !== current.version) {
      throw conflict(
        "다른 사람이 먼저 저장했습니다. 최신 내용을 불러온 뒤 다시 저장합니다.",
        "version_conflict",
      );
    }

    const version = current.version + 1;
    const at = nowIso();
    app.db
      .prepare("UPDATE sheets SET data = ?, version = ?, updated_at = ? WHERE page_id = ?")
      .run(json, version, at, page.id);
    app.db.prepare("UPDATE pages SET updated_at = ? WHERE id = ?").run(at, page.id);

    // 같은 페이지를 보고 있는 다른 접속자에게 "저장됨" 을 알린다 —
    // 그들의 baseVersion 이 낡아 409 가 반복되는 것을 막는다.
    app.sheetSockets.broadcast(page.id, {
      type: "saved",
      payload: { version, by: req.user!.id, at },
    });

    return { version, updatedAt: at };
  });
}

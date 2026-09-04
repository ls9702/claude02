import { randomBytes, randomUUID } from "node:crypto";

/** 일반 엔티티 id */
export const newId = (): string => randomUUID();

/** Excalidraw 협업 룸 id — 20자 hex */
export const newRoomId = (): string => randomBytes(10).toString("hex");

/**
 * Excalidraw 협업 룸 키.
 * excalidraw.com 규격: AES-GCM 128bit 키를 base64url 로 인코딩한 22자 문자열.
 */
export const newRoomKey = (): string => randomBytes(16).toString("base64url");

export const nowIso = (): string => new Date().toISOString();

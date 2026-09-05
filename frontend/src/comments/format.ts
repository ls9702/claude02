/** 댓글 표시용 서식 helper (순수 함수). */

/** 작성자 이니셜 (한글은 첫 글자, 영문은 대문자 한 글자) */
export function initialOf(username: string | null | undefined): string {
  const trimmed = (username ?? "").trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 1).toUpperCase();
}

/** 작성자 이름에서 안정적인 색을 고른다 (핀 배지 색). */
export function colorOf(username: string | null | undefined): string {
  const palette = ["#4a63d8", "#c0392b", "#1f8a4c", "#b06e00", "#7a3fb0", "#0f7d8c"];
  const name = (username ?? "").trim();
  if (!name) return palette[0]!;
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}

/** 작성자 표시 이름 (삭제된 사용자 대비) */
export const displayName = (username: string | null | undefined): string =>
  (username ?? "").trim() || "(삭제된 사용자)";

/** `2026. 9. 5. 오후 3:12` 형태의 짧은 시각 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 사이드바 목록용 한 줄 요약 */
export function previewOf(body: string, max = 60): string {
  const flat = body.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

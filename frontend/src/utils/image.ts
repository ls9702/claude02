/** 업로드 전 리사이즈 기준: 장변 2048px */
export const MAX_IMAGE_DIMENSION = 2048;

export interface Size {
  width: number;
  height: number;
}

/**
 * 장변이 `max` 를 넘을 때만 비율을 유지한 채 줄인 크기를 돌려준다.
 * 줄일 필요가 없으면 `null` (원본을 그대로 쓰라는 뜻).
 */
export function computeResizedSize(
  width: number,
  height: number,
  max: number = MAX_IMAGE_DIMENSION,
): Size | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= max) return null;
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** dataURL 의 mime 타입을 읽는다. 알 수 없으면 image/png. */
export function mimeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? "image/png";
}

/** 리사이즈 결과를 저장할 때 유지할 포맷 (JPEG 은 JPEG, 그 외는 PNG). */
export function outputMimeFor(sourceMime: string): string {
  return sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header = "", body = ""] = dataUrl.split(",", 2);
  const mime = mimeFromDataUrl(dataUrl);
  if (!header.includes(";base64")) {
    return new Blob([decodeURIComponent(body)], { type: mime });
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    img.src = src;
  });

export interface ResizedImage {
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
  resized: boolean;
}

/**
 * 장변이 2048px 를 넘는 이미지만 canvas 로 줄인다.
 * SVG 는 벡터라 리사이즈하지 않는다.
 */
export async function resizeDataUrlIfNeeded(
  dataUrl: string,
  max: number = MAX_IMAGE_DIMENSION,
): Promise<ResizedImage> {
  const sourceMime = mimeFromDataUrl(dataUrl);
  if (sourceMime === "image/svg+xml") {
    return { dataUrl, mime: sourceMime, width: 0, height: 0, resized: false };
  }

  const img = await loadImage(dataUrl);
  const target = computeResizedSize(img.naturalWidth, img.naturalHeight, max);
  if (!target) {
    return {
      dataUrl,
      mime: sourceMime,
      width: img.naturalWidth,
      height: img.naturalHeight,
      resized: false,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      dataUrl,
      mime: sourceMime,
      width: img.naturalWidth,
      height: img.naturalHeight,
      resized: false,
    };
  }
  ctx.drawImage(img, 0, 0, target.width, target.height);

  const outMime = outputMimeFor(sourceMime);
  const out = canvas.toDataURL(outMime, outMime === "image/jpeg" ? 0.9 : undefined);
  return { dataUrl: out, mime: outMime, width: target.width, height: target.height, resized: true };
}

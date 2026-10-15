// Jev image rules (OpenRouter multimodal guide): PNG or JPEG only, 256–1568 px per side,
// 78,400–2,458,624 px in total, at most 16 MiB decoded.
const MIN_SIDE = 256;
const MAX_SIDE = 1568;
const MIN_PIXELS = 78_400;
const MAX_PIXELS = 2_458_624;
const MAX_BYTES = 16 * 1024 * 1024;

export type ImageInfo = { format: "png" | "jpeg"; width: number; height: number };

/** Reads format and size from the file header. Returns null for anything that is not PNG or JPEG. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { format: "png", width: u32(16), height: u32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments until a start-of-frame marker, which holds height then width.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { format: "jpeg", width: u16(i + 7), height: u16(i + 5) };
      }
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

/** Why Jev would reject this image, or null when it is usable. */
export function imageProblem(info: ImageInfo | null, bytes: number): string | null {
  if (!info) return "formato não suportado (só PNG ou JPEG)";
  const { width: w, height: h } = info;
  if (bytes > MAX_BYTES) return "arquivo maior que 16 MiB";
  if (Math.min(w, h) < MIN_SIDE || w * h < MIN_PIXELS) return `imagem pequena demais (${w}×${h})`;
  if (Math.max(w, h) > MAX_SIDE || w * h > MAX_PIXELS) return `imagem grande demais (${w}×${h})`;
  return null;
}

export type ImagePart = { type: "image_url"; image_url: { url: string } };

/**
 * Downloads a product photo and returns it as a Jev image part, or the reason it can't be used.
 * Errors here are never retried: an unusable photo just sends the product to the text fallback.
 */
export async function fetchImagePart(url: string, signal: AbortSignal): Promise<ImagePart | { problem: string }> {
  if (!url) return { problem: "produto sem imagem" };
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (!res.ok) return { problem: `download falhou (HTTP ${res.status})` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    if (signal.aborted) throw error;
    return { problem: "download falhou" };
  }
  const info = sniffImage(bytes);
  const problem = imageProblem(info, bytes.length);
  if (problem) return { problem };
  return { type: "image_url", image_url: { url: `data:image/${info!.format};base64,${Buffer.from(bytes).toString("base64")}` } };
}

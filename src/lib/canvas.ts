// Small canvas helpers shared by the processing pipeline.
import type { Mask, SoftMask } from './mask';

export type Canvas = HTMLCanvasElement;

export function createCanvas(width: number, height: number): Canvas {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function ctx2d(canvas: Canvas): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available in this browser');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export function getPixels(canvas: Canvas): ImageData {
  return ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

export function fromImageData(img: ImageData): Canvas {
  const c = createCanvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

export function cloneCanvas(src: Canvas): Canvas {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Decodes an image file, honouring EXIF orientation, capped at `maxSide` px. */
export async function loadImageFile(file: Blob, maxSide = 4096): Promise<Canvas> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = createCanvas(bitmap.width * scale, bitmap.height * scale);
  ctx2d(c).drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
  return c;
}

/** High quality resize: halves repeatedly when shrinking to avoid aliasing. */
export function resizeCanvas(src: Canvas, width: number, height: number): Canvas {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  let cur = src;
  while (cur.width / 2 >= width && cur.height / 2 >= height) {
    const half = createCanvas(cur.width / 2, cur.height / 2);
    ctx2d(half).drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = createCanvas(width, height);
  ctx2d(out).drawImage(cur, 0, 0, width, height);
  return out;
}

export function fitInside(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const s = Math.min(maxW / w, maxH / h);
  return { width: w * s, height: h * s };
}

/** Paints a soft mask as a solid colour layer. */
export function softMaskToCanvas(mask: SoftMask | Mask, color: string): Canvas {
  const c = createCanvas(mask.width, mask.height);
  const ctx = ctx2d(c);
  const [r, g, b] = parseColor(color);
  const img = ctx.createImageData(mask.width, mask.height);
  const isSoft = mask.data instanceof Float32Array;
  for (let i = 0; i < mask.data.length; i++) {
    const a = isSoft ? mask.data[i] : mask.data[i] ? 1 : 0;
    const o = i * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const colorCache = new Map<string, [number, number, number]>();

export function parseColor(color: string): [number, number, number] {
  const cached = colorCache.get(color);
  if (cached) return cached;
  let rgb: [number, number, number] = [0, 0, 0];
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  } else if (typeof document !== 'undefined') {
    const c = createCanvas(1, 1);
    const ctx = ctx2d(c);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    rgb = [d[0], d[1], d[2]];
  }
  colorCache.set(color, rgb);
  return rgb;
}

export function toHex(rgb: ArrayLike<number>): string {
  return '#' + [rgb[0], rgb[1], rgb[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function canvasToBlob(canvas: Canvas, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  );
}

/** Yields to the browser so the UI can repaint between heavy steps. */
export function nextFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

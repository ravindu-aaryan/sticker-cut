// Binary / soft mask utilities. Pure functions over typed arrays so they run
// in the browser, in workers and in unit tests alike.
import { distanceTransform } from './edt';

export interface Mask {
  width: number;
  height: number;
  /** 1 = inside, 0 = outside */
  data: Uint8Array;
}

export interface SoftMask {
  width: number;
  height: number;
  /** 0..1 coverage */
  data: Float32Array;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

/** Binary mask from the alpha channel of RGBA pixels. */
export function maskFromAlpha(rgba: ArrayLike<number>, width: number, height: number, threshold = 128): Mask {
  const m = createMask(width, height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = rgba[i * 4 + 3] >= threshold ? 1 : 0;
  return m;
}

export function invert(mask: Mask): Mask {
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = mask.data[i] ? 0 : 1;
  return out;
}

export function countOn(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i];
  return n;
}

export function boundingBox(mask: Mask): Box | null {
  const { width, height, data } = mask;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Connected components (4-connectivity). Returns labels (0 = background) and component sizes (index = label). */
export function labelComponents(mask: Mask): { labels: Int32Array; sizes: number[] } {
  const { width, height, data } = mask;
  const labels = new Int32Array(width * height);
  const sizes = [0];
  const stack = new Int32Array(width * height);
  let next = 1;
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    let size = 0;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0 && data[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[sp++] = i - 1; }
      if (x < width - 1 && data[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && data[i - width] && !labels[i - width]) { labels[i - width] = next; stack[sp++] = i - width; }
      if (y < height - 1 && data[i + width] && !labels[i + width]) { labels[i + width] = next; stack[sp++] = i + width; }
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

/** Drops specks smaller than `minFraction` of the largest component. */
export function removeSmallComponents(mask: Mask, minFraction = 0.02): Mask {
  const { labels, sizes } = labelComponents(mask);
  const largest = Math.max(0, ...sizes);
  const keep = sizes.map((s) => s >= largest * minFraction && s > 0);
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = labels[i] && keep[labels[i]] ? 1 : 0;
  return out;
}

/** Fills enclosed holes: any background region not connected to the image edge. */
export function fillHoles(mask: Mask): Mask {
  const { width, height, data } = mask;
  const outside = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let sp = 0;
  const push = (i: number) => {
    if (!data[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; }
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < width * (height - 1)) push(i + width);
  }
  const out = createMask(width, height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = outside[i] ? 0 : 1;
  return out;
}

/**
 * Grows the mask by `radius` px and, when `smooth` > 0, applies a morphological
 * closing (grow by radius+smooth, shrink by smooth) which rounds concave
 * corners and bridges narrow gaps — the "bubble" sticker look.
 * Returns an anti-aliased soft mask.
 */
export function offsetOutline(mask: Mask, radius: number, smooth = 0): SoftMask {
  const { width, height } = mask;
  const dOut = distanceTransform(mask.data, width, height);
  const out = new Float32Array(width * height);
  if (smooth <= 0) {
    for (let i = 0; i < out.length; i++) out[i] = clamp01(radius - dOut[i] + 0.5);
    return { width, height, data: out };
  }
  const grown = createMask(width, height);
  const r = radius + smooth;
  for (let i = 0; i < out.length; i++) grown.data[i] = dOut[i] <= r ? 1 : 0;
  const filled = fillHoles(grown);
  const dIn = distanceTransform(invert(filled).data, width, height);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(dIn[i] - smooth + 0.5);
  return { width, height, data: out };
}

/** Shrinks a binary mask by `radius` px, anti-aliased. */
export function erodeSoft(mask: Mask, radius: number): SoftMask {
  const { width, height } = mask;
  const dIn = distanceTransform(invert(mask).data, width, height);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(dIn[i] - radius + 0.5);
  return { width, height, data: out };
}

export function binarize(soft: SoftMask, threshold = 0.5): Mask {
  const out = createMask(soft.width, soft.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = soft.data[i] >= threshold ? 1 : 0;
  return out;
}

/** Separable box blur approximating a gaussian (3 passes). */
export function blurSoft(soft: SoftMask, radius: number): SoftMask {
  const { width, height } = soft;
  let src = Float32Array.from(soft.data);
  let tmp = new Float32Array(src.length);
  const r = Math.max(1, Math.round(radius / 1.7));
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(src, tmp, width, height, r);
    boxBlurV(tmp, src, width, height, r);
  }
  return { width, height, data: src };
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * norm;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += src[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * norm;
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

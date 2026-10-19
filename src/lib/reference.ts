// Reads a reference / template sticker and derives a matching style:
// its cut shape (circle, heart, custom silhouette…), border colour and
// thickness, ink outline, and background fill.
import { createCanvas, ctx2d, getPixels, toHex, type Canvas } from './canvas';
import { keyBackgroundMask } from './background';
import { boundingBox, createMask, fillHoles, removeSmallComponents, type Mask } from './mask';
import { distanceTransform } from './edt';
import { rasterizeShape, type ShapeKind } from './shapes';
import { PRESET_STYLES, type StickerStyle } from './styles';

export interface ReferenceAnalysis {
  /** The silhouette, cropped to its bounding box. */
  silhouette: Mask;
  aspect: number;
  shape: ShapeKind | 'contour';
  shapeConfidence: number;
  borderColor: string;
  borderRatio: number;
  outlineColor: string | null;
  outlineRatio: number;
  fillColor: string;
  photoContent: boolean;
  /** Best matching parametric style. */
  matchStyle: StickerStyle;
  /** Exact silhouette of the reference used as the cut shape. */
  exactStyle: StickerStyle;
}

const ANALYSIS_SIZE = 512;
const CANDIDATES: { shape: ShapeKind; corner?: number }[] = [
  { shape: 'circle' }, { shape: 'oval' }, { shape: 'square' },
  { shape: 'rounded', corner: 0.08 }, { shape: 'rounded', corner: 0.16 }, { shape: 'rounded', corner: 0.26 }, { shape: 'rounded', corner: 0.38 },
  { shape: 'heart' }, { shape: 'star' }, { shape: 'hexagon' }, { shape: 'scallop' },
];

export function analyzeReference(src: Canvas): ReferenceAnalysis {
  const scale = Math.min(1, ANALYSIS_SIZE / Math.max(src.width, src.height));
  const small = createCanvas(src.width * scale, src.height * scale);
  ctx2d(small).drawImage(src, 0, 0, small.width, small.height);
  const img = getPixels(small);
  const { width, height, data } = img;

  // 1. Silhouette: alpha if the reference is a transparent PNG, otherwise key out the backdrop.
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  let sil = createMask(width, height);
  if (transparent / (width * height) > 0.03) {
    for (let i = 0; i < sil.data.length; i++) sil.data[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    const bg = keyBackgroundMask(data, width, height, 30);
    for (let i = 0; i < sil.data.length; i++) sil.data[i] = bg.data[i] ? 0 : 1;
  }
  sil = fillHoles(removeSmallComponents(sil, 0.05));
  const box = boundingBox(sil) ?? { x: 0, y: 0, width, height };

  // Crop silhouette and pixels to the bounding box.
  const silhouette = createMask(box.width, box.height);
  const px = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const si = (y + box.y) * width + x + box.x;
      const di = y * box.width + x;
      silhouette.data[di] = sil.data[si];
      px.set(data.subarray(si * 4, si * 4 + 4), di * 4);
    }
  }
  const W = box.width, H = box.height, L = Math.max(W, H);
  const aspect = W / H;

  // 2. Shape classification by IoU against each parametric shape.
  let best = { shape: 'contour' as ShapeKind | 'contour', corner: 0, iou: 0 };
  for (const c of CANDIDATES) {
    if (c.shape === 'circle' && Math.abs(aspect - 1) > 0.08) continue;
    if (c.shape === 'oval' && Math.abs(aspect - 1) <= 0.08) continue;
    const m = rasterizeShape(c.shape, W, H, { x: 0, y: 0, width: W, height: H }, c.corner);
    const score = iou(silhouette, m);
    if (score > best.iou) best = { shape: c.shape, corner: c.corner ?? 0, iou: score };
  }
  const isShape = best.iou >= 0.93;

  // 3. Colour bands measured inwards from the cut edge.
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < outside.length; i++) outside[i] = silhouette.data[i] ? 0 : 1;
  const padded = padOutside(outside, W, H);
  const distPadded = distanceTransform(padded, W + 2, H + 2);
  const dist = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dist[y * W + x] = distPadded[(y + 1) * (W + 2) + x + 1];

  const band = (d0: number, d1: number) => {
    const out: number[] = [];
    for (let i = 0; i < dist.length; i++) if (silhouette.data[i] && dist[i] >= d0 && dist[i] < d1) out.push(i);
    return out;
  };

  // Median colour of each 1px ring, then group consecutive rings of similar colour.
  const runs = colourRuns(px, dist, silhouette, Math.ceil(L * 0.2));
  let outlineColor: string | null = null;
  let outlineRatio = 0;
  let borderRun = runs[0];
  let next = 1;
  if (runs.length > 2 && runs[0].length / L < 0.035 && luma(runs[0].color) < luma(runs[1].color) - 40) {
    outlineColor = toHex(runs[0].color);
    outlineRatio = runs[0].length / L;
    borderRun = runs[1];
    next = 2;
  }
  let borderRatio = borderRun ? Math.min(0.15, borderRun.length / L) : 0;
  // A "border" that never ends is just a flat sticker with no distinct border.
  if (!runs[next] || borderRatio < 0.006) borderRatio = 0;
  const borderRef: RGB = borderRun?.color ?? [255, 255, 255];
  const start = (outlineRatio + borderRatio) * L;

  // 4. Background fill just inside the border (shapes) and whether it is a photo.
  const inner0 = start + L * 0.01;
  const fillPixels = band(inner0, inner0 + L * 0.05);
  const { color: fill, share } = modeColor(px, fillPixels);
  const photoContent = isShape && share < 0.35;

  const borderColor = toHex(borderRef);
  const fillColor = toHex(fill);
  const proto = PRESET_STYLES[0];
  // The ink outline is painted over the outer edge of the border, so the border includes it.

  const matchStyle: StickerStyle = isShape
    ? {
        ...proto,
        id: 'ref-match',
        name: 'Reference match',
        description: `Detected ${best.shape} (${Math.round(best.iou * 100)}% match)`,
        kind: 'shape',
        shape: best.shape as ShapeKind,
        customAspect: aspect,
        corner: best.shape === 'rounded' ? best.corner : 0,
        border: borderRatio + outlineRatio,
        borderColor,
        fill: fillColor,
        content: photoContent ? 'photo' : 'cutout',
        outline: outlineRatio,
        outlineColor: outlineColor ?? proto.outlineColor,
        padding: 0.04,
      }
    : {
        ...proto,
        id: 'ref-match',
        name: 'Reference match',
        description: 'Die-cut with the reference border',
        kind: 'contour',
        border: Math.max(borderRatio + outlineRatio, 0.01),
        smooth: Math.max(0.006, borderRatio * 0.6),
        borderColor,
        outline: outlineRatio,
        outlineColor: outlineColor ?? proto.outlineColor,
      };

  const exactStyle: StickerStyle = {
    ...proto,
    id: 'ref-exact',
    name: 'Reference shape',
    description: 'Exact cut outline of your template',
    kind: 'shape',
    shape: 'custom',
    customShape: silhouette,
    customAspect: aspect,
    border: borderRatio + outlineRatio,
    borderColor,
    fill: photoContent ? '#ffffff' : fillColor,
    content: photoContent ? 'photo' : 'cutout',
    outline: outlineRatio,
    outlineColor: outlineColor ?? proto.outlineColor,
    padding: 0.04,
  };

  return {
    silhouette, aspect, shape: isShape ? best.shape : 'contour', shapeConfidence: best.iou,
    borderColor, borderRatio, outlineColor, outlineRatio, fillColor, photoContent, matchStyle, exactStyle,
  };
}

function padOutside(outside: Uint8Array, w: number, h: number): Uint8Array {
  const pw = w + 2;
  const seed = new Uint8Array(pw * (h + 2)).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) seed[(y + 1) * pw + x + 1] = outside[y * w + x];
  return seed;
}

export function iou(a: Mask, b: Mask): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 0;
}

type RGB = [number, number, number];

function medianColor(px: Uint8ClampedArray, idx: number[]): RGB {
  if (!idx.length) return [255, 255, 255];
  const ch = (c: number) => idx.map((i) => px[i * 4 + c]).sort((a, b) => a - b)[idx.length >> 1];
  return [ch(0), ch(1), ch(2)];
}

/** Most common colour (5-bit quantised) and the share of pixels near it. */
function modeColor(px: Uint8ClampedArray, idx: number[]): { color: RGB; share: number } {
  if (!idx.length) return { color: [255, 255, 255], share: 1 };
  const counts = new Map<number, number>();
  for (const i of idx) {
    const k = ((px[i * 4] >> 3) << 10) | ((px[i * 4 + 1] >> 3) << 5) | (px[i * 4 + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let bestK = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestK = k; bestN = n; }
  const approx: RGB = [((bestK >> 10) & 31) * 8 + 4, ((bestK >> 5) & 31) * 8 + 4, (bestK & 31) * 8 + 4];
  const near = idx.filter((i) => colorDist([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], approx) < 36);
  return { color: medianColor(px, near.length ? near : idx), share: near.length / idx.length };
}

function colorDist(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function luma(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

interface Run { color: RGB; start: number; length: number }

/** Splits the inward colour profile (1px rings from the cut edge) into runs of similar colour. */
function colourRuns(px: Uint8ClampedArray, dist: Float32Array, sil: Mask, maxD: number): Run[] {
  const rings: number[][][] = Array.from({ length: maxD + 1 }, () => [[], [], []]);
  for (let i = 0; i < dist.length; i++) {
    if (!sil.data[i]) continue;
    const d = Math.floor(dist[i]);
    if (d < 1 || d > maxD) continue;
    rings[d][0].push(px[i * 4]); rings[d][1].push(px[i * 4 + 1]); rings[d][2].push(px[i * 4 + 2]);
  }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const runs: Run[] = [];
  // Ring 1 blends with the backdrop (anti-aliasing / JPEG), so start at ring 2.
  for (let d = 2; d <= maxD; d++) {
    if (!rings[d][0].length) break;
    const c: RGB = [med(rings[d][0]), med(rings[d][1]), med(rings[d][2])];
    const last = runs[runs.length - 1];
    if (last && colorDist(last.color, c) < 40) {
      last.length++;
    } else {
      runs.push({ color: c, start: d === 2 ? 1 : d, length: 1 });
    }
  }
  // Single anti-aliasing rings between two runs are absorbed by the following run.
  const merged: Run[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.length === 1 && i > 0 && i < runs.length - 1) {
      runs[i + 1] = { ...runs[i + 1], start: r.start, length: runs[i + 1].length + 1 };
      continue;
    }
    merged.push(r);
  }
  // Count the skipped edge ring with the first run.
  if (merged.length) merged[0] = { ...merged[0], length: merged[0].length + 1 };
  return merged;
}

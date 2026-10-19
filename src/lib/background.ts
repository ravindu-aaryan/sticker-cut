// Background removal. "ai" runs a segmentation model fully in the browser via
// transformers.js (WebGPU when available, WASM otherwise); "color" keys out a
// plain backdrop by flood-filling from the image edges; "none" keeps the photo.
import { createCanvas, ctx2d, getPixels, type Canvas } from './canvas';
import { blurSoft, createMask, labelComponents, type Mask } from './mask';

export type BackgroundMode = 'ai' | 'color' | 'none';

export interface AiModel {
  id: string;
  /** Hub repositories tried in order (mirrors of the same model). */
  repos: string[];
  label: string;
  note: string;
}

export const AI_MODELS: AiModel[] = [
  { id: 'birefnet-lite', repos: ['onnx-community/BiRefNet_lite-ONNX', 'onnx-community/BiRefNet_lite'], label: 'BiRefNet Lite — any subject', note: 'Best general quality (MIT)' },
  { id: 'modnet', repos: ['Xenova/modnet'], label: 'MODNet — people & portraits', note: 'Small & fast (Apache-2.0)' },
];

type Progress = (message: string, fraction?: number) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipelines = new Map<string, Promise<any>>();

async function getPipeline(modelId: string, onProgress: Progress) {
  let p = pipelines.get(modelId);
  if (!p) {
    p = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
      const attempts: { device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'fp32' }[] = hasWebGPU
        ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'fp32' }]
        : [{ device: 'wasm', dtype: 'fp32' }];
      let lastErr: unknown;
      for (const opts of attempts) {
        try {
          return await pipeline('background-removal', modelId, {
            ...opts,
            progress_callback: (info: { status: string; progress?: number }) => {
              if (info.status === 'progress_total' && typeof info.progress === 'number') {
                onProgress('Downloading AI model (first time only)', info.progress / 100);
              }
            },
          });
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    })();
    p.catch(() => pipelines.delete(modelId));
    pipelines.set(modelId, p);
  }
  return p;
}

export async function removeBackground(
  src: Canvas,
  mode: BackgroundMode,
  modelId: string,
  onProgress: Progress = () => {},
): Promise<{ canvas: Canvas; usedMode: BackgroundMode; warning?: string }> {
  if (mode === 'none') return { canvas: src, usedMode: 'none' };
  if (mode === 'ai') {
    const chosen = AI_MODELS.find((m) => m.id === modelId) ?? AI_MODELS[0];
    const order = [chosen, ...AI_MODELS.filter((m) => m !== chosen)].flatMap((m) => m.repos);
    let lastErr: unknown;
    for (const id of order) {
      try {
        const segmenter = await getPipeline(id, onProgress);
        onProgress('Removing background with AI');
        const { RawImage } = await import('@huggingface/transformers');
        // Segment a ≤1024px copy (the model's native size) and upsample the matte.
        const small = downscaleForModel(src, 1024);
        const result = await segmenter(RawImage.fromCanvas(small));
        const out = Array.isArray(result) ? result[0] : result;
        const matte = out.toCanvas() as Canvas;
        return { canvas: applyMatte(src, matte), usedMode: 'ai' };
      } catch (err) {
        console.warn(`Background model ${id} failed`, err);
        lastErr = err;
      }
    }
    const canvas = colorKey(src);
    return {
      canvas,
      usedMode: 'color',
      warning: `AI background removal unavailable (${String((lastErr as Error)?.message ?? lastErr)}). Used colour keying instead.`,
    };
  }
  return { canvas: colorKey(src), usedMode: 'color' };
}

function downscaleForModel(src: Canvas, max: number): Canvas {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  if (s === 1) return src;
  const c = createCanvas(src.width * s, src.height * s);
  ctx2d(c).drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Applies the alpha of a (possibly smaller) matte to the full resolution image. */
function applyMatte(src: Canvas, matte: Canvas): Canvas {
  const scaled = createCanvas(src.width, src.height);
  ctx2d(scaled).drawImage(matte, 0, 0, src.width, src.height);
  const alpha = getPixels(scaled).data;
  const img = getPixels(src);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = Math.min(img.data[i], alpha[i]);
  cleanAlpha(img);
  const out = createCanvas(src.width, src.height);
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}

/** Removes stray semi-transparent specks far from the subject. */
function cleanAlpha(img: ImageData) {
  const { width, height, data } = img;
  const m: Mask = createMask(width, height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = data[i * 4 + 3] > 40 ? 1 : 0;
  const { labels, sizes } = labelComponents(m);
  const largest = Math.max(0, ...sizes);
  for (let i = 0; i < m.data.length; i++) {
    const l = labels[i];
    if (l && sizes[l] < largest * 0.01) data[i * 4 + 3] = 0;
  }
}

/**
 * Keys out the background by flood-filling from the borders through pixels
 * close to the dominant edge colour. Works well on studio shots, scans and
 * illustrations on plain backgrounds.
 */
export function colorKey(src: Canvas, tolerance = 38): Canvas {
  const img = getPixels(src);
  const bg = keyBackgroundMask(img.data, img.width, img.height, tolerance);
  const soft = blurSoft({ width: img.width, height: img.height, data: Float32Array.from(bg.data, (v) => 1 - v) }, 1.2);
  for (let i = 0; i < bg.data.length; i++) img.data[i * 4 + 3] = Math.round(img.data[i * 4 + 3] * soft.data[i]);
  cleanAlpha(img);
  const out = createCanvas(src.width, src.height);
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}

/** Pixels connected to the border whose colour is near the median border colour. 1 = background. */
export function keyBackgroundMask(data: ArrayLike<number>, width: number, height: number, tolerance: number): Mask {
  const ref = edgeColor(data, width, height);
  const tol2 = tolerance * tolerance;
  const near = (i: number) => {
    const o = i * 4;
    if (data[o + 3] < 128) return true;
    const dr = data[o] - ref[0], dg = data[o + 1] - ref[1], db = data[o + 2] - ref[2];
    return dr * dr + dg * dg + db * db <= tol2;
  };
  const bg = createMask(width, height);
  const stack = new Int32Array(width * height);
  let sp = 0;
  const push = (i: number) => {
    if (!bg.data[i] && near(i)) { bg.data[i] = 1; stack[sp++] = i; }
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
  return bg;
}

/** Per-channel median of the outermost pixel ring. */
export function edgeColor(data: ArrayLike<number>, width: number, height: number): [number, number, number] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const add = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    if (data[o + 3] < 128) return;
    rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
  };
  for (let x = 0; x < width; x++) { add(x, 0); add(x, height - 1); }
  for (let y = 0; y < height; y++) { add(0, y); add(width - 1, y); }
  const med = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 255);
  return [med(rs), med(gs), med(bs)];
}

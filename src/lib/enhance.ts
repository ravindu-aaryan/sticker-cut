// Quality enhancement: AI super-resolution (ESRGAN, runs locally via
// TensorFlow.js), high quality classic upscaling, auto-levels, vibrance and
// unsharp masking.
import { createCanvas, ctx2d, getPixels, nextFrame, resizeCanvas, type Canvas } from './canvas';
import { blurSoft } from './mask';

export type UpscaleMode = 'ai' | 'classic' | 'off';

export interface EnhanceOptions {
  upscale: UpscaleMode;
  /** Images whose long side is below this get upscaled. */
  targetLongSide: number;
  autoLevels: boolean;
  /** 0..1 */
  sharpen: number;
  /** -1..1, 0 = unchanged */
  vibrance: number;
}

export const defaultEnhance: EnhanceOptions = {
  upscale: 'ai',
  targetLongSide: 2000,
  autoLevels: true,
  sharpen: 0.35,
  vibrance: 0.15,
};

type Progress = (message: string, fraction?: number) => void;

export async function enhanceImage(src: Canvas, opts: EnhanceOptions, onProgress: Progress = () => {}): Promise<Canvas> {
  let img = src;
  const long = Math.max(img.width, img.height);
  if (opts.upscale !== 'off' && long < opts.targetLongSide) {
    const factor = opts.targetLongSide / long;
    if (opts.upscale === 'ai') {
      try {
        const scale = factor > 2.5 ? 4 : 2;
        img = await aiUpscale(img, scale, (f) => onProgress(`AI upscaling ×${scale}`, f));
      } catch (err) {
        console.warn('AI upscaling failed, falling back to classic', err);
        tfPromise = null;
        onProgress('AI upscaling unavailable, using classic upscale');
      }
    }
    const remaining = opts.targetLongSide / Math.max(img.width, img.height);
    if (remaining > 1.01 || img === src) {
      img = classicUpscale(img, Math.min(remaining, opts.targetLongSide / long));
    } else if (remaining < 0.99) {
      img = resizeCanvas(img, img.width * remaining, img.height * remaining);
    }
  }
  await nextFrame();
  onProgress('Enhancing colours & detail');
  const pixels = getPixels(img === src ? cloneOf(src) : img);
  if (opts.autoLevels) autoLevels(pixels.data);
  if (opts.vibrance) vibrance(pixels.data, opts.vibrance);
  if (opts.sharpen > 0) unsharpMask(pixels, opts.sharpen * 1.2, Math.max(1, Math.max(pixels.width, pixels.height) / 900));
  const out = createCanvas(pixels.width, pixels.height);
  ctx2d(out).putImageData(pixels, 0, 0);
  return out;
}

function cloneOf(c: Canvas): Canvas {
  const out = createCanvas(c.width, c.height);
  ctx2d(out).drawImage(c, 0, 0);
  return out;
}

/** Upscales in ≤2× steps with high quality smoothing (less blur than one big jump). */
export function classicUpscale(src: Canvas, factor: number): Canvas {
  if (factor <= 1) return src;
  const tw = src.width * factor;
  const th = src.height * factor;
  let cur = src;
  while (cur.width * 2 < tw) {
    const next = createCanvas(cur.width * 2, cur.height * 2);
    ctx2d(next).drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  return resizeCanvas(cur, tw, th);
}

/** Stretches luminance between the 0.5th and 99.5th percentile of opaque pixels. */
export function autoLevels(data: Uint8ClampedArray): void {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    hist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
    n++;
  }
  if (n === 0) return;
  const lowCount = n * 0.005, highCount = n * 0.995;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lowCount) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= highCount) { hi = v; break; } }
  if (hi - lo < 10) return;
  // Don't over-stretch already well exposed images.
  lo = Math.min(lo, 40);
  hi = Math.max(hi, 215);
  const scale = 255 / (hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (v - lo) * scale;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

/** Saturation boost weighted towards muted colours (keeps skin tones natural). */
export function vibrance(data: Uint8ClampedArray, amount: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b);
    const avg = (r + g + b) / 3;
    const sat = (max - Math.min(r, g, b)) / 255;
    const k = amount * (1 - sat) * 1.5;
    data[i] = r + (r - avg) * k;
    data[i + 1] = g + (g - avg) * k;
    data[i + 2] = b + (b - avg) * k;
  }
}

/** Classic unsharp mask on RGB. */
export function unsharpMask(img: ImageData, amount: number, radius: number): void {
  const { width, height, data } = img;
  const n = width * height;
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = data[i * 4 + c];
    const blurred = blurSoft({ width, height, data: ch }, radius).data;
    for (let i = 0; i < n; i++) {
      const diff = ch[i] - blurred[i];
      // Small threshold avoids amplifying noise / JPEG artefacts.
      if (Math.abs(diff) > 2) data[i * 4 + c] = ch[i] + diff * amount;
    }
  }
}

// ---------------------------------------------------------------- AI upscaling

type TF = typeof import('@tensorflow/tfjs');
const models = new Map<number, Promise<import('@tensorflow/tfjs').LayersModel>>();
let tfPromise: Promise<TF> | null = null;
// Test hook: `?ai-cpu` lets automated tests exercise the model without a GPU.
const forceCpu = typeof location !== 'undefined' && new URLSearchParams(location.search).has('ai-cpu');

async function loadTf(): Promise<TF> {
  if (!tfPromise) {
    tfPromise = import('@tensorflow/tfjs').then(async (tf) => {
      if (forceCpu) { await tf.setBackend('cpu'); return tf; }
      // The CPU backend is far too slow (and memory hungry) for super-resolution,
      // so AI upscaling is only offered with GPU acceleration.
      const ok = await tf.setBackend('webgl').catch(() => false);
      await tf.ready();
      if (!ok || tf.getBackend() !== 'webgl') throw new Error('AI upscaling needs WebGL; using classic upscaling');
      return tf;
    });
  }
  return tfPromise;
}

function loadModel(tf: TF, scale: number) {
  let m = models.get(scale);
  if (!m) {
    m = tf.loadLayersModel(`${import.meta.env.BASE_URL}models/esrgan-slim/x${scale}/model.json`);
    m.catch(() => models.delete(scale));
    models.set(scale, m);
  }
  return m;
}

/**
 * Super-resolves an image with ESRGAN-slim, processing overlapping tiles so
 * memory stays bounded. Alpha is upscaled separately with smooth resampling.
 */
export async function aiUpscale(src: Canvas, scale: 2 | 4, onProgress: (f: number) => void = () => {}): Promise<Canvas> {
  const tf = await loadTf();
  const model = await loadModel(tf, scale);
  const TILE = 128;
  const PAD = 10;
  const out = createCanvas(src.width * scale, src.height * scale);
  const octx = ctx2d(out);
  const srcCtx = ctx2d(src);
  const tilesX = Math.ceil(src.width / TILE);
  const tilesY = Math.ceil(src.height / TILE);
  let done = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE, y0 = ty * TILE;
      const x1 = Math.min(src.width, x0 + TILE), y1 = Math.min(src.height, y0 + TILE);
      const px0 = Math.max(0, x0 - PAD), py0 = Math.max(0, y0 - PAD);
      const px1 = Math.min(src.width, x1 + PAD), py1 = Math.min(src.height, y1 + PAD);
      const tile = srcCtx.getImageData(px0, py0, px1 - px0, py1 - py0);

      const result = tf.tidy(() => {
        const input = tf.browser.fromPixels(tile, 3).toFloat().expandDims(0);
        const pred = model.predict(input) as import('@tensorflow/tfjs').Tensor4D;
        return pred.squeeze([0]).clipByValue(0, 255).round().toInt() as import('@tensorflow/tfjs').Tensor3D;
      });
      const rgb = await result.data();
      const [h, w] = result.shape;
      result.dispose();

      const img = new ImageData(w, h);
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        img.data[j] = rgb[i];
        img.data[j + 1] = rgb[i + 1];
        img.data[j + 2] = rgb[i + 2];
        img.data[j + 3] = 255;
      }
      // Paste only the un-padded core of the tile.
      octx.putImageData(img, (px0 - x0) * scale + x0 * scale, (py0 - y0) * scale + y0 * scale,
        (x0 - px0) * scale, (y0 - py0) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
      done++;
      onProgress(done / (tilesX * tilesY));
      await nextFrame();
    }
  }

  restoreAlpha(src, out);
  return out;
}

function restoreAlpha(src: Canvas, out: Canvas) {
  const s = getPixels(src).data;
  let hasAlpha = false;
  for (let i = 3; i < s.length; i += 4) if (s[i] < 250) { hasAlpha = true; break; }
  if (!hasAlpha) return;
  const alpha = getPixels(resizeCanvas(src, out.width, out.height)).data;
  const ctx = ctx2d(out);
  const o = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 3; i < o.data.length; i += 4) o.data[i] = alpha[i];
  ctx.putImageData(o, 0, 0);
}

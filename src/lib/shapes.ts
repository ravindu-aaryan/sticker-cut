// Die-cut shapes. Each shape is a vector path drawn into a box; it is then
// rasterised into a mask so every style (and custom reference shapes) share
// one rendering pipeline.
import { createCanvas, ctx2d } from './canvas';
import { createMask, type Box, type Mask } from './mask';
import { distanceTransform } from './edt';

export type ShapeKind = 'circle' | 'oval' | 'rounded' | 'square' | 'heart' | 'star' | 'hexagon' | 'scallop' | 'custom';

/** Natural width / height of a shape; `null` means "follow the content". */
export function shapeAspect(shape: ShapeKind, contentAspect: number): number {
  switch (shape) {
    case 'circle':
    case 'star':
    case 'scallop':
      return 1;
    case 'heart':
      return 1.08;
    case 'hexagon':
      return 2 / Math.sqrt(3);
    case 'oval':
      return contentAspect >= 1 ? 1.4 : 1 / 1.4;
    default:
      return Math.min(2.2, Math.max(1 / 2.2, contentAspect));
  }
}

export function traceShapePath(ctx: CanvasRenderingContext2D, shape: ShapeKind, x: number, y: number, w: number, h: number, corner = 0.16): void {
  const cx = x + w / 2, cy = y + h / 2;
  ctx.beginPath();
  switch (shape) {
    case 'circle':
    case 'oval':
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'square':
      ctx.rect(x, y, w, h);
      break;
    case 'rounded': {
      ctx.roundRect(x, y, w, h, Math.min(w, h) * corner);
      break;
    }
    case 'heart': {
      // Classic parametric heart, normalised to fill the box.
      const steps = 240;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const hx = 16 * Math.sin(t) ** 3;
        const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        // hx ∈ [-16, 16], hy ∈ [-17, ~12.1]
        const px = cx + (hx / 16) * (w / 2);
        const py = y + ((12.1 - hy) / 29.1) * h;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'star': {
      const spikes = 5;
      const outerR = Math.min(w, h) / 2;
      const innerR = outerR * 0.52;
      // Shift down slightly so the star's visual centre sits in the box.
      const oy = cy + outerR * 0.06;
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = -Math.PI / 2 + (i * Math.PI) / spikes;
        const px = cx + Math.cos(a) * r, py = oy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'hexagon': {
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const px = cx + Math.cos(a) * (w / 2), py = cy + Math.sin(a) * (h / 2);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'scallop': {
      const bumps = 18;
      const r = Math.min(w, h) / 2;
      const steps = bumps * 24;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const rr = r * (0.94 + 0.06 * Math.cos(a * bumps));
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'custom':
      ctx.rect(x, y, w, h);
      break;
  }
}

/** Rasterises a shape into a binary mask of the given canvas size, inside `box`. */
export function rasterizeShape(shape: ShapeKind, width: number, height: number, box: Box, corner?: number, custom?: Mask): Mask {
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  if (shape === 'custom' && custom) {
    const src = createCanvas(custom.width, custom.height);
    const sctx = ctx2d(src);
    const img = sctx.createImageData(custom.width, custom.height);
    for (let i = 0; i < custom.data.length; i++) img.data[i * 4 + 3] = custom.data[i] ? 255 : 0;
    sctx.putImageData(img, 0, 0);
    ctx.drawImage(src, box.x, box.y, box.width, box.height);
  } else {
    ctx.fillStyle = '#000';
    traceShapePath(ctx, shape, box.x, box.y, box.width, box.height, corner);
    ctx.fill();
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  const m = createMask(width, height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}

/**
 * Largest axis-aligned rectangle of the given aspect ratio that fits inside
 * the mask, centred on the point deepest inside the shape. Used to place the
 * artwork inside hearts, stars, custom silhouettes, etc.
 */
export function inscribedRect(mask: Mask, aspect: number): Box {
  // Work on a small copy for speed.
  const scale = Math.min(1, 160 / Math.max(mask.width, mask.height));
  const w = Math.max(1, Math.round(mask.width * scale));
  const h = Math.max(1, Math.round(mask.height * scale));
  const small = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mask.width - 1, Math.floor((x + 0.5) / scale));
      const sy = Math.min(mask.height - 1, Math.floor((y + 0.5) / scale));
      small.data[y * w + x] = mask.data[sy * mask.width + sx];
    }
  }
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < outside.length; i++) outside[i] = small.data[i] ? 0 : 1;
  // Treat the canvas edge as outside too.
  const padded = padSeeds(outside, w, h);
  const dist = distanceTransform(padded.seed, padded.w, padded.h);

  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && small.data[Math.floor(y) * w + Math.floor(x)] === 1;
  const fits = (cx: number, cy: number, rw: number, rh: number) => {
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const xs = cx - rw / 2 + t * rw, ys = cy - rh / 2 + t * rh;
      if (!inside(xs, cy - rh / 2) || !inside(xs, cy + rh / 2) || !inside(cx - rw / 2, ys) || !inside(cx + rw / 2, ys)) return false;
    }
    return true;
  };
  const sizeAt = (cx: number, cy: number) => {
    let lo = 0, hi = Math.max(w, h);
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      const rw = aspect >= 1 ? mid : mid * aspect;
      const rh = aspect >= 1 ? mid / aspect : mid;
      if (fits(cx, cy, rw, rh)) lo = mid; else hi = mid;
    }
    return lo;
  };

  // Candidate centres: the 24 deepest points, pick the one giving the biggest rect.
  const order = Array.from(dist.keys())
    .filter((i) => {
      const px = (i % padded.w) - 1, py = Math.floor(i / padded.w) - 1;
      return px >= 0 && py >= 0 && px < w && py < h && small.data[py * w + px];
    })
    .sort((a, b) => dist[b] - dist[a])
    .slice(0, 24);
  let best = { cx: w / 2, cy: h / 2, s: 0 };
  for (const i of order) {
    const cx = (i % padded.w) - 1 + 0.5, cy = Math.floor(i / padded.w) - 1 + 0.5;
    const s = sizeAt(cx, cy);
    if (s > best.s) best = { cx, cy, s };
  }
  const rw = aspect >= 1 ? best.s : best.s * aspect;
  const rh = aspect >= 1 ? best.s / aspect : best.s;
  return {
    x: (best.cx - rw / 2) / scale,
    y: (best.cy - rh / 2) / scale,
    width: rw / scale,
    height: rh / scale,
  };
}

function padSeeds(outside: Uint8Array, w: number, h: number) {
  const pw = w + 2, ph = h + 2;
  const seed = new Uint8Array(pw * ph).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) seed[(y + 1) * pw + x + 1] = outside[y * w + x];
  return { seed, w: pw, h: ph };
}

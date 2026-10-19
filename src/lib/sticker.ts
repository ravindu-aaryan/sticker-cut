// Renders one sticker (artwork + style) into a canvas plus the binary cut mask.
import { createCanvas, ctx2d, getPixels, softMaskToCanvas, type Canvas } from './canvas';
import {
  binarize, blurSoft, boundingBox, clamp01, createMask, erodeSoft, fillHoles, maskFromAlpha, offsetOutline,
  removeSmallComponents, type Box, type Mask, type SoftMask,
} from './mask';
import { distanceTransform } from './edt';
import { inscribedRect, rasterizeShape, shapeAspect } from './shapes';
import type { StickerStyle } from './styles';

export interface StickerArtwork {
  /** Background-removed subject (transparent background). */
  cutout: Canvas;
  /** Full enhanced photo (opaque). */
  photo: Canvas;
}

export interface RenderedSticker {
  canvas: Canvas;
  /** Binary cut mask, same size as `canvas`. */
  cut: Mask;
  /** Bounding box of the cut mask within the canvas. */
  cutBox: Box;
}

export interface RenderOptions {
  /** Long side of the cut outline in pixels. */
  size: number;
  shadow: boolean;
}

export function renderSticker(art: StickerArtwork, style: StickerStyle, opts: RenderOptions): RenderedSticker {
  return style.kind === 'contour' ? renderContour(art, style, opts) : renderShape(art, style, opts);
}

/** Crops a canvas to the bounding box of its opaque pixels. */
export function trimToAlpha(src: Canvas): Canvas {
  const img = getPixels(src);
  const box = boundingBox(maskFromAlpha(img.data, img.width, img.height, 24));
  if (!box) return src;
  const out = createCanvas(box.width, box.height);
  ctx2d(out).drawImage(src, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return out;
}

function renderContour(art: StickerArtwork, style: StickerStyle, { size, shadow }: RenderOptions): RenderedSticker {
  const subject = trimToAlpha(art.cutout);
  const L = size;
  const border = style.border * L;
  const inner = style.innerBorder * L;
  const smooth = style.smooth * L;
  const corner = style.corner * L;
  const grow = border + inner;
  const contentLong = Math.max(8, L - 2 * grow);
  const scale = contentLong / Math.max(subject.width, subject.height);
  const cw = subject.width * scale, ch = subject.height * scale;
  const margin = Math.ceil(grow + smooth + (shadow ? L * 0.05 : 0) + 4);
  const W = Math.ceil(cw + margin * 2), H = Math.ceil(ch + margin * 2);

  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  const art2 = createCanvas(W, H);
  ctx2d(art2).drawImage(subject, margin, margin, cw, ch);

  const pix = getPixels(art2);
  const subjectMask = fillHoles(removeSmallComponents(maskFromAlpha(pix.data, W, H, 100), 0.03));
  let cutSoft = offsetOutline(subjectMask, grow, smooth);
  if (corner > 0) cutSoft = roundCorners(binarize(cutSoft), corner);
  const cut = binarize(cutSoft);

  drawLayers(ctx, cutSoft, cut, style, L, shadow);
  if (inner > 0) {
    const ring = offsetOutline(subjectMask, inner, smooth * 0.5);
    ctx.drawImage(softMaskToCanvas(ring, style.innerBorderColor), 0, 0);
  }
  ctx.drawImage(art2, 0, 0);
  if (style.outline > 0) drawOutline(ctx, cut, cutSoft, style.outline * L, style.outlineColor);
  return { canvas, cut, cutBox: boundingBox(cut) ?? { x: 0, y: 0, width: W, height: H } };
}

function renderShape(art: StickerArtwork, style: StickerStyle, { size, shadow }: RenderOptions): RenderedSticker {
  const shape = style.shape ?? 'circle';
  const content = style.content === 'photo' ? art.photo : trimToAlpha(art.cutout);
  const contentAspect = content.width / content.height;
  let aspect = style.customAspect ?? shapeAspect(shape, contentAspect);
  if (style.contentBox) aspect = 0.86;
  const L = size;
  const bw = aspect >= 1 ? L : L * aspect;
  const bh = aspect >= 1 ? L / aspect : L;
  const margin = Math.ceil((shadow ? L * 0.05 : 0) + 4);
  const W = Math.ceil(bw + margin * 2), H = Math.ceil(bh + margin * 2);
  const box: Box = { x: margin, y: margin, width: bw, height: bh };

  let cut = rasterizeShape(shape, W, H, box, style.corner > 0 && shape === 'rounded' ? style.corner : 0.16, style.customShape);
  let cutSoft: SoftMask = softFromBinary(cut);
  if (style.corner > 0 && shape !== 'rounded') {
    cutSoft = roundCorners(cut, style.corner * L);
    cut = binarize(cutSoft);
  }

  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  // Outer layer = border colour; inner area = fill colour.
  const borderPx = style.border * L;
  drawLayers(ctx, cutSoft, cut, { ...style, borderColor: borderPx > 0 ? style.borderColor : style.fill }, L, shadow);
  const innerSoft = borderPx > 0 ? erodeSoft(cut, borderPx) : cutSoft;
  const innerMask = binarize(innerSoft);
  if (borderPx > 0) ctx.drawImage(softMaskToCanvas(innerSoft, style.fill), 0, 0);

  // Artwork placement.
  const layer = createCanvas(W, H);
  const lctx = ctx2d(layer);
  if (style.contentBox) {
    const cb = style.contentBox;
    const target: Box = { x: box.x + cb.x * bw, y: box.y + cb.y * bh, width: cb.width * bw, height: cb.height * bh };
    drawCover(lctx, content, target);
  } else if (style.content === 'photo') {
    const ib = boundingBox(innerMask) ?? box;
    drawCover(lctx, content, ib);
    clipToMask(layer, innerSoft);
  } else {
    const rect = inscribedRect(innerMask, contentAspect);
    const pad = 1 - style.padding * 2;
    const dw = rect.width * pad, dh = rect.height * pad;
    lctx.drawImage(content, rect.x + (rect.width - dw) / 2, rect.y + (rect.height - dh) / 2, dw, dh);
    clipToMask(layer, innerSoft);
  }
  ctx.drawImage(layer, 0, 0);
  if (style.outline > 0) drawOutline(ctx, cut, cutSoft, style.outline * L, style.outlineColor);
  return { canvas, cut, cutBox: boundingBox(cut) ?? box };
}

function drawLayers(ctx: CanvasRenderingContext2D, cutSoft: SoftMask, _cut: Mask, style: StickerStyle, L: number, shadow: boolean) {
  if (shadow) {
    const blurred = blurSoft(cutSoft, L * 0.018);
    const sh = softMaskToCanvas(blurred, 'rgba(20,20,40,1)');
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.drawImage(sh, L * 0.008, L * 0.018);
    ctx.restore();
  }
  ctx.drawImage(softMaskToCanvas(cutSoft, style.borderColor), 0, 0);
}

function drawOutline(ctx: CanvasRenderingContext2D, cut: Mask, cutSoft: SoftMask, width: number, color: string) {
  const inner = erodeSoft(cut, width);
  const ring = new Float32Array(cutSoft.data.length);
  for (let i = 0; i < ring.length; i++) ring[i] = clamp01(cutSoft.data[i] - inner.data[i]);
  ctx.drawImage(softMaskToCanvas({ width: cut.width, height: cut.height, data: ring }, color), 0, 0);
}

/** Morphological opening: rounds convex corners (star tips, hexagon points). */
function roundCorners(mask: Mask, radius: number): SoftMask {
  const { width, height } = mask;
  const outside = new Uint8Array(width * height);
  for (let i = 0; i < outside.length; i++) outside[i] = mask.data[i] ? 0 : 1;
  const dIn = distanceTransform(outside, width, height);
  const core = createMask(width, height);
  for (let i = 0; i < core.data.length; i++) core.data[i] = dIn[i] > radius ? 1 : 0;
  return offsetOutline(core, radius);
}

function softFromBinary(mask: Mask): SoftMask {
  // Slight blur gives anti-aliased edges to rasterised shapes.
  const soft = blurSoft({ width: mask.width, height: mask.height, data: Float32Array.from(mask.data) }, 0.8);
  return soft;
}

function clipToMask(layer: Canvas, soft: SoftMask) {
  const ctx = ctx2d(layer);
  const img = ctx.getImageData(0, 0, layer.width, layer.height);
  for (let i = 0; i < soft.data.length; i++) img.data[i * 4 + 3] = Math.round(img.data[i * 4 + 3] * soft.data[i]);
  ctx.putImageData(img, 0, 0);
}

function drawCover(ctx: CanvasRenderingContext2D, img: Canvas, target: Box) {
  const s = Math.max(target.width / img.width, target.height / img.height);
  const sw = target.width / s, sh = target.height / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, target.x, target.y, target.width, target.height);
}

// A4 sheet layout and rendering at print resolution.
import { createCanvas, ctx2d, type Canvas } from './canvas';
import type { RenderedSticker } from './sticker';
import { cutContours, type Polygon } from './trace';

export const PAPER_MM = { A4: { width: 210, height: 297 } } as const;

export interface SheetOptions {
  orientation: 'portrait' | 'landscape';
  dpi: number;
  marginMm: number;
  gapMm: number;
  /** Long side of every sticker's cut outline. */
  stickerMm: number;
  /** Repeat the selected stickers until the page is full. */
  fillPage: boolean;
  /** Print the cut lines on the sheet (useful for cutting by hand). */
  printCutLines: boolean;
  transparent: boolean;
}

export const defaultSheet: SheetOptions = {
  orientation: 'portrait',
  dpi: 300,
  marginMm: 8,
  gapMm: 4,
  stickerMm: 60,
  fillPage: true,
  printCutLines: false,
  transparent: false,
};

export interface Size { width: number; height: number }
export interface Placement { item: number; x: number; y: number; width: number; height: number }

export function pageSize(opts: Pick<SheetOptions, 'orientation'>): Size {
  const { width, height } = PAPER_MM.A4;
  return opts.orientation === 'portrait' ? { width, height } : { width: height, height: width };
}

/**
 * Shelf-packs stickers (sizes in mm) onto as many pages as needed. With
 * `fillPage`, items are cycled until no more fit on a single page. Rows are
 * centred horizontally and stickers centred vertically in their row.
 */
export function layoutSheet(sizes: Size[], copies: number[], opts: SheetOptions): Placement[][] {
  const page = pageSize(opts);
  const areaW = page.width - opts.marginMm * 2;
  const areaH = page.height - opts.marginMm * 2;
  const fits = (s: Size) => s.width <= areaW + 1e-6 && s.height <= areaH + 1e-6;
  const valid = sizes.map(fits);

  const queue: number[] = [];
  if (!opts.fillPage) {
    sizes.forEach((_, i) => { if (valid[i]) for (let c = 0; c < Math.max(0, copies[i] ?? 1); c++) queue.push(i); });
  }

  const pages: Placement[][] = [];
  let cursor = 0;
  for (let guard = 0; guard < 200; guard++) {
    const rows: { items: Placement[]; height: number; width: number }[] = [];
    let row = { items: [] as Placement[], height: 0, width: 0 };
    let usedH = 0;
    let failures = 0;

    const tryPlace = (i: number): boolean => {
      const s = sizes[i];
      const addW = (row.items.length ? opts.gapMm : 0) + s.width;
      if (row.width + addW <= areaW + 1e-6 && usedH + Math.max(row.height, s.height) <= areaH + 1e-6) {
        row.items.push({ item: i, x: row.width + (row.items.length ? opts.gapMm : 0), y: 0, width: s.width, height: s.height });
        row.width += addW;
        row.height = Math.max(row.height, s.height);
        return true;
      }
      // New row.
      const nextTop = usedH + row.height + (row.items.length ? opts.gapMm : 0);
      if (row.items.length && nextTop + s.height <= areaH + 1e-6 && s.width <= areaW) {
        rows.push(row);
        usedH = nextTop;
        row = { items: [{ item: i, x: 0, y: 0, width: s.width, height: s.height }], height: s.height, width: s.width };
        return true;
      }
      return false;
    };

    if (opts.fillPage) {
      const candidates = sizes.map((_, i) => i).filter((i) => valid[i]);
      if (!candidates.length) break;
      while (failures < candidates.length) {
        const i = candidates[cursor % candidates.length];
        cursor++;
        if (tryPlace(i)) failures = 0; else failures++;
      }
    } else {
      while (queue.length && tryPlace(queue[0])) queue.shift();
    }
    if (row.items.length) rows.push(row);
    if (!rows.length) break;

    // Absolute positions: centre the block vertically? Keep top-aligned, centre rows horizontally.
    const placements: Placement[] = [];
    let y = opts.marginMm;
    for (const r of rows) {
      const offsetX = opts.marginMm + (areaW - r.width) / 2;
      for (const p of r.items) {
        placements.push({ ...p, x: offsetX + p.x, y: y + (r.height - p.height) / 2 });
      }
      y += r.height + opts.gapMm;
    }
    pages.push(placements);
    if (opts.fillPage || !queue.length) break;
  }
  return pages;
}

export interface SheetSticker {
  sticker: RenderedSticker;
  /** Outline polygons in sticker-canvas pixels. */
  contours: Polygon[];
}

export function prepareSheetSticker(sticker: RenderedSticker): SheetSticker {
  return { sticker, contours: cutContours(sticker.cut, 0.8) };
}

/** Size in mm of a sticker's cut box when its long side is `stickerMm`. */
export function stickerSizeMm(s: RenderedSticker, stickerMm: number): Size {
  const long = Math.max(s.cutBox.width, s.cutBox.height);
  return { width: (s.cutBox.width / long) * stickerMm, height: (s.cutBox.height / long) * stickerMm };
}

/** Cut paths of a page in mm. */
export function pageCutPaths(page: Placement[], items: SheetSticker[]): Polygon[] {
  const out: Polygon[] = [];
  for (const p of page) {
    const { sticker, contours } = items[p.item];
    const k = p.width / sticker.cutBox.width;
    for (const poly of contours) {
      out.push(poly.map(([x, y]) => [p.x + (x - sticker.cutBox.x) * k, p.y + (y - sticker.cutBox.y) * k]));
    }
  }
  return out;
}

/** `guides` draws faint outlines (preview only) so white borders are visible on white paper. */
export function renderPage(page: Placement[], items: SheetSticker[], opts: SheetOptions, pxPerMm = opts.dpi / 25.4, guides = false): Canvas {
  const size = pageSize(opts);
  const canvas = createCanvas(size.width * pxPerMm, size.height * pxPerMm);
  const ctx = ctx2d(canvas);
  if (!opts.transparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  for (const p of page) {
    const { sticker } = items[p.item];
    const k = (p.width * pxPerMm) / sticker.cutBox.width;
    ctx.drawImage(
      sticker.canvas,
      (p.x * pxPerMm) - sticker.cutBox.x * k,
      (p.y * pxPerMm) - sticker.cutBox.y * k,
      sticker.canvas.width * k,
      sticker.canvas.height * k,
    );
  }
  if (opts.printCutLines || guides) {
    ctx.strokeStyle = opts.printCutLines ? '#ff00ff' : 'rgba(80, 70, 120, 0.35)';
    ctx.lineWidth = opts.printCutLines ? Math.max(1, 0.2 * pxPerMm) : 1;
    ctx.lineJoin = 'round';
    for (const poly of pageCutPaths(page, items)) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * pxPerMm, y * pxPerMm) : ctx.moveTo(x * pxPerMm, y * pxPerMm)));
      ctx.closePath();
      ctx.stroke();
    }
  }
  return canvas;
}

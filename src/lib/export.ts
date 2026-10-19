// Export helpers: 300-DPI PNG, print-ready PDF with vector cut lines,
// SVG cut file for cutting machines, and a ZIP of individual stickers.
import { canvasToBlob, type Canvas } from './canvas';
import type { Polygon } from './trace';
import type { Size } from './sheet';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Inserts (or replaces) the pHYs chunk so print software reads the correct DPI. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  // Walk chunks; drop an existing pHYs, insert ours right after IHDR.
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let off = 8;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (off < png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (type !== 'pHYs') parts.push(png.subarray(off, end));
    if (type === 'IHDR') parts.push(chunk);
    off = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function canvasToPngWithDpi(canvas: Canvas, dpi: number): Promise<Blob> {
  const blob = await canvasToBlob(canvas, 'image/png');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([setPngDpi(bytes, dpi) as BlobPart], { type: 'image/png' });
}

export function cutLinesSvg(pages: Polygon[][], page: Size): string[] {
  return pages.map((polys) => {
    const paths = polys
      .map((p) => 'M' + p.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join(' L') + ' Z')
      .map((d) => `  <path d="${d}"/>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}">
 <g id="cut" fill="none" stroke="#ff00ff" stroke-width="0.1">
${paths}
 </g>
</svg>
`;
  });
}

export async function sheetPdf(pageCanvases: Canvas[], cutPaths: Polygon[][], page: Size, vectorCutLines: boolean): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: page.width > page.height ? 'landscape' : 'portrait', compress: true });
  pageCanvases.forEach((canvas, i) => {
    if (i > 0) doc.addPage('a4', page.width > page.height ? 'landscape' : 'portrait');
    doc.addImage(canvas, 'PNG', 0, 0, page.width, page.height, undefined, 'FAST');
    if (vectorCutLines) {
      doc.setDrawColor(255, 0, 255);
      doc.setLineWidth(0.1);
      for (const poly of cutPaths[i] ?? []) {
        const [x0, y0] = poly[0];
        const deltas = poly.slice(1).map(([x, y], k) => [x - poly[k][0], y - poly[k][1]]);
        doc.lines(deltas, x0, y0, [1, 1], 'S', true);
      }
    }
  });
  return doc.output('blob');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

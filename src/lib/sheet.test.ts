import { describe, expect, it } from 'vitest';
import { defaultSheet, layoutSheet, pageSize } from './sheet';
import { crc32, setPngDpi } from './export';

describe('layoutSheet', () => {
  const opts = { ...defaultSheet, marginMm: 10, gapMm: 5 };

  it('fills an A4 page with a grid of 60mm stickers', () => {
    const [page] = layoutSheet([{ width: 60, height: 60 }], [1], opts);
    // 190mm usable width → 3 per row (60*3 + 5*2 = 190); 277mm height → 4 rows.
    expect(page.length).toBe(12);
    for (const p of page) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.x + p.width).toBeLessThanOrEqual(200 + 1e-9);
      expect(p.y + p.height).toBeLessThanOrEqual(287 + 1e-9);
    }
  });

  it('never overlaps stickers', () => {
    const [page] = layoutSheet([{ width: 50, height: 35 }, { width: 30, height: 45 }], [1, 1], opts);
    for (let i = 0; i < page.length; i++) {
      for (let j = i + 1; j < page.length; j++) {
        const a = page[i], b = page[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    expect(new Set(page.map((p) => p.item))).toEqual(new Set([0, 1]));
  });

  it('places exact copies across multiple pages', () => {
    const pages = layoutSheet([{ width: 90, height: 90 }], [7], { ...opts, fillPage: false });
    // 2 per row (185mm), 3 rows need 280mm > 277mm → 4 per page.
    expect(pages.map((p) => p.length)).toEqual([4, 3]);
  });

  it('supports landscape', () => {
    expect(pageSize({ orientation: 'landscape' })).toEqual({ width: 297, height: 210 });
  });
});

describe('setPngDpi', () => {
  it('computes the standard CRC32', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });

  it('inserts a pHYs chunk after IHDR', () => {
    // Minimal PNG skeleton: signature + IHDR + IEND (contents irrelevant for chunk walking).
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, ...new Array(13).fill(0), 0, 0, 0, 0];
    const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82];
    const out = setPngDpi(new Uint8Array([...sig, ...ihdr, ...iend]), 300);
    const type = String.fromCharCode(...out.subarray(33 + 4, 33 + 8));
    expect(type).toBe('pHYs');
    const ppm = new DataView(out.buffer).getUint32(33 + 8);
    expect(ppm).toBe(11811);
    expect(out.length).toBe(sig.length + ihdr.length + iend.length + 21);
    // Idempotent: running twice keeps a single pHYs.
    expect(setPngDpi(out, 300).length).toBe(out.length);
  });
});

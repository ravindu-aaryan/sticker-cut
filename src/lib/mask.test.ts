import { describe, expect, it } from 'vitest';
import { binarize, boundingBox, countOn, createMask, fillHoles, offsetOutline, removeSmallComponents } from './mask';
import { cutContours, signedArea, traceMask } from './trace';

function square(w: number, h: number, x0: number, y0: number, size: number) {
  const m = createMask(w, h);
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) m.data[y * w + x] = 1;
  return m;
}

describe('mask ops', () => {
  it('offsets an outline by the requested radius', () => {
    const m = square(60, 60, 25, 25, 10);
    const grown = binarize(offsetOutline(m, 5));
    expect(boundingBox(grown)).toEqual({ x: 20, y: 20, width: 20, height: 20 });
  });

  it('closing bridges two nearby blobs into one sticker', () => {
    const m = square(80, 40, 10, 10, 20);
    for (let y = 10; y < 30; y++) for (let x = 36; x < 56; x++) m.data[y * 80 + x] = 1;
    const plain = binarize(offsetOutline(m, 1));
    const bubble = binarize(offsetOutline(m, 1, 6));
    expect(cutContours(plain).length).toBe(2);
    expect(cutContours(bubble).length).toBe(1);
  });

  it('fills holes and drops specks', () => {
    const m = square(30, 30, 5, 5, 20);
    m.data[15 * 30 + 15] = 0;
    m.data[1 * 30 + 1] = 1;
    const cleaned = fillHoles(removeSmallComponents(m));
    expect(countOn(cleaned)).toBe(400);
  });
});

describe('traceMask', () => {
  it('produces one clockwise contour around a square', () => {
    const polys = traceMask(square(20, 20, 5, 5, 10));
    expect(polys.length).toBe(1);
    expect(signedArea(polys[0])).toBeGreaterThan(90);
    expect(signedArea(polys[0])).toBeLessThan(110);
  });

  it('marks holes with negative area', () => {
    const m = square(20, 20, 2, 2, 16);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) m.data[y * 20 + x] = 0;
    const areas = traceMask(m).map(signedArea).sort((a, b) => a - b);
    expect(areas.length).toBe(2);
    expect(areas[0]).toBeLessThan(0);
    expect(cutContours(m).length).toBe(1);
  });
});

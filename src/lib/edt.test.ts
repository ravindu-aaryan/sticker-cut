import { describe, expect, it } from 'vitest';
import { distanceTransform } from './edt';

describe('distanceTransform', () => {
  it('computes exact euclidean distances to the seed', () => {
    const w = 7, h = 5;
    const seed = new Uint8Array(w * h);
    seed[2 * w + 3] = 1;
    const d = distanceTransform(seed, w, h);
    expect(d[2 * w + 3]).toBe(0);
    expect(d[2 * w + 4]).toBeCloseTo(1);
    expect(d[0]).toBeCloseTo(Math.hypot(3, 2));
    expect(d[4 * w + 6]).toBeCloseTo(Math.hypot(3, 2));
  });
});

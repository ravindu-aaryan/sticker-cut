// Vectorises a binary mask into closed polygons (marching squares) so cut
// lines can be exported as SVG / PDF paths for Cricut, Silhouette, etc.
import type { Mask } from './mask';

export type Point = [number, number];
export type Polygon = Point[];

// Edge ids within a cell: 0 top, 1 right, 2 bottom, 3 left.
// Segments are oriented so the inside of the shape is on the right
// (clockwise outer contours in screen coordinates).
const SEGMENTS: number[][][] = [
  [],
  [[3, 2]],
  [[2, 1]],
  [[3, 1]],
  [[1, 0]],
  [[3, 2], [1, 0]],
  [[2, 0]],
  [[3, 0]],
  [[0, 3]],
  [[0, 2]],
  [[0, 3], [2, 1]],
  [[0, 1]],
  [[1, 3]],
  [[1, 2]],
  [[2, 3]],
  [],
];

/** Traces every boundary of the mask. Coordinates are in pixel units (pixel centres at +0.5). */
export function traceMask(mask: Mask): Polygon[] {
  const { width: w, height: h, data } = mask;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x] : 0);

  // Edge midpoint keys in a doubled grid with a 1-cell pad on each side.
  const W2 = 2 * (w + 2) + 1;
  const keyOf = (cx: number, cy: number, edge: number): number => {
    const X = 2 * (cx + 1);
    const Y = 2 * (cy + 1);
    switch (edge) {
      case 0: return Y * W2 + X + 1;
      case 1: return (Y + 1) * W2 + X + 2;
      case 2: return (Y + 2) * W2 + X + 1;
      default: return (Y + 1) * W2 + X;
    }
  };
  const pointOf = (key: number): Point => {
    const X = key % W2;
    const Y = (key - X) / W2;
    // Doubled grid → pixel space; cell corner (cx,cy) is the centre of pixel (cx,cy).
    return [X / 2 - 1 + 0.5, Y / 2 - 1 + 0.5];
  };

  const next = new Map<number, number>();
  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const idx = (at(cx, cy) << 3) | (at(cx + 1, cy) << 2) | (at(cx + 1, cy + 1) << 1) | at(cx, cy + 1);
      for (const [a, b] of SEGMENTS[idx]) next.set(keyOf(cx, cy, a), keyOf(cx, cy, b));
    }
  }

  const polygons: Polygon[] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const poly: Polygon = [];
    let k: number | undefined = start;
    while (k !== undefined && next.has(k)) {
      poly.push(pointOf(k));
      const n: number = next.get(k)!;
      next.delete(k);
      k = n;
    }
    if (poly.length >= 3) polygons.push(poly);
  }
  return polygons;
}

/** Signed area (positive = clockwise in screen coordinates, i.e. an outer contour). */
export function signedArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Ramer–Douglas–Peucker simplification for a closed polygon. */
export function simplify(poly: Polygon, epsilon: number): Polygon {
  if (poly.length < 8) return poly;
  // Split the ring at the point farthest from the first vertex.
  let far = 0, best = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = (poly[i][0] - poly[0][0]) ** 2 + (poly[i][1] - poly[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(poly.slice(0, far + 1), epsilon);
  const b = rdp([...poly.slice(far), poly[0]], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: Point[], eps: number): Point[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Outer contours only, simplified — what a cutting machine needs. */
export function cutContours(mask: Mask, epsilon = 0.6): Polygon[] {
  return traceMask(mask)
    .filter((p) => signedArea(p) > 4)
    .map((p) => simplify(p, epsilon));
}

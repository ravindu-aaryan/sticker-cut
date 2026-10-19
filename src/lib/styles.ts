// Sticker style presets. Sizes are fractions of the sticker's long side so a
// style looks identical at preview size and at 300 DPI print size.
import type { Box, Mask } from './mask';
import type { ShapeKind } from './shapes';

export interface StickerStyle {
  id: string;
  name: string;
  description: string;
  /** contour = die-cut following the subject; shape = subject placed on a shaped sticker */
  kind: 'contour' | 'shape';
  shape?: ShapeKind;
  /** Silhouette used when shape === 'custom' (e.g. from a reference image). */
  customShape?: Mask;
  /** Fixed width / height (custom silhouettes, or a shape copied from a reference). */
  customAspect?: number;
  border: number;
  borderColor: string;
  /** Morphological closing radius for contour stickers (rounder, "bubble" outline). */
  smooth: number;
  innerBorder: number;
  innerBorderColor: string;
  /** Thin outline right on the cut edge. */
  outline: number;
  outlineColor: string;
  /** Background of shape stickers. */
  fill: string;
  /** Empty space around the artwork inside a shape (fraction of the available box). */
  padding: number;
  /** Corner rounding (fraction of the long side) applied to the cut path. */
  corner: number;
  /** cutout = background-removed subject, photo = whole photo filling the shape */
  content: 'cutout' | 'photo';
  /** Fixed artwork box inside the shape (fractions), e.g. a polaroid frame. */
  contentBox?: Box;
}

const base: Omit<StickerStyle, 'id' | 'name' | 'description' | 'kind'> = {
  border: 0.045,
  borderColor: '#ffffff',
  smooth: 0.012,
  innerBorder: 0,
  innerBorderColor: '#ff5c8a',
  outline: 0,
  outlineColor: '#1d1d2b',
  fill: '#ffffff',
  padding: 0.06,
  corner: 0,
  content: 'cutout',
};

export const PRESET_STYLES: StickerStyle[] = [
  { ...base, id: 'die-cut', name: 'Classic die-cut', description: 'White border hugging the subject', kind: 'contour' },
  { ...base, id: 'bubble', name: 'Bubble', description: 'Thick, soft rounded outline', kind: 'contour', border: 0.07, smooth: 0.07 },
  { ...base, id: 'kiss-cut', name: 'Tight kiss-cut', description: 'Minimal border, follows every detail', kind: 'contour', border: 0.018, smooth: 0.004 },
  { ...base, id: 'cartoon', name: 'Cartoon outline', description: 'White border with a dark ink edge', kind: 'contour', border: 0.045, smooth: 0.02, outline: 0.008 },
  { ...base, id: 'double', name: 'Double border', description: 'Coloured inner ring + white outer border', kind: 'contour', border: 0.035, innerBorder: 0.022, smooth: 0.02 },
  { ...base, id: 'circle', name: 'Circle badge', description: 'Round sticker, subject centred', kind: 'shape', shape: 'circle', border: 0.03, padding: 0.04, fill: '#fff6e9' },
  { ...base, id: 'photo-circle', name: 'Photo circle', description: 'Whole photo in a round frame', kind: 'shape', shape: 'circle', border: 0.035, content: 'photo' },
  { ...base, id: 'rounded', name: 'Rounded square', description: 'Soft-cornered tile', kind: 'shape', shape: 'rounded', corner: 0.16, border: 0.03, fill: '#eef4ff', padding: 0.05 },
  { ...base, id: 'polaroid', name: 'Polaroid', description: 'Instant-photo frame', kind: 'shape', shape: 'rounded', corner: 0.02, border: 0, content: 'photo', contentBox: { x: 0.07, y: 0.06, width: 0.86, height: 0.7 } },
  { ...base, id: 'heart', name: 'Heart', description: 'Heart-shaped sticker', kind: 'shape', shape: 'heart', border: 0.035, fill: '#ffe4ec', padding: 0.02 },
  { ...base, id: 'star', name: 'Star', description: 'Five-point star, rounded tips', kind: 'shape', shape: 'star', border: 0.03, fill: '#fff3b3', corner: 0.03, padding: 0 },
  { ...base, id: 'hexagon', name: 'Hexagon', description: 'Honeycomb tile', kind: 'shape', shape: 'hexagon', border: 0.03, fill: '#e4f6f0', corner: 0.02 },
  { ...base, id: 'scallop', name: 'Scalloped badge', description: 'Wavy-edged seal', kind: 'shape', shape: 'scallop', border: 0.03, fill: '#efe7ff', padding: 0.03 },
  { ...base, id: 'oval', name: 'Oval', description: 'Elliptical label', kind: 'shape', shape: 'oval', border: 0.03, fill: '#ffffff', padding: 0.04 },
];

export interface StyleTweaks {
  /** Multiplies every border width. */
  borderScale: number;
  /** Overrides the outer border colour when set. */
  borderColor: string | null;
  /** Overrides the shape fill colour when set. */
  fill: string | null;
}

export const defaultTweaks: StyleTweaks = { borderScale: 1, borderColor: null, fill: null };

export function applyTweaks(style: StickerStyle, t: StyleTweaks): StickerStyle {
  return {
    ...style,
    border: style.border * t.borderScale,
    innerBorder: style.innerBorder * t.borderScale,
    borderColor: t.borderColor ?? style.borderColor,
    fill: t.fill ?? style.fill,
  };
}

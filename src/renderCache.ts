// Memoises rendered stickers: previews and print-size renders are reused
// across re-renders as long as photo, style and tweaks are unchanged.
import { applyTweaks, type StickerStyle, type StyleTweaks } from './lib/styles';
import { renderSticker, type RenderedSticker } from './lib/sticker';
import type { Photo } from './state';

const tokens = new WeakMap<object, number>();
let nextToken = 1;
function token(o: object): number {
  let t = tokens.get(o);
  if (!t) { t = nextToken++; tokens.set(o, t); }
  return t;
}

const cache = new Map<string, RenderedSticker>();
const LIMIT = 120;

export function cacheKey(photo: Photo, style: StickerStyle, tweaks: StyleTweaks, size: number, shadow: boolean): string {
  return [photo.id, photo.version, style.id, token(style), JSON.stringify(tweaks), Math.round(size), shadow ? 1 : 0].join('|');
}

export function getCached(key: string): RenderedSticker | undefined {
  return cache.get(key);
}

export function getSticker(photo: Photo, style: StickerStyle, tweaks: StyleTweaks, size: number, shadow: boolean): RenderedSticker {
  if (!photo.art) throw new Error('Photo is not processed yet');
  const key = cacheKey(photo, style, tweaks, size, shadow);
  let r = cache.get(key);
  if (!r) {
    r = renderSticker(photo.art, applyTweaks(style, tweaks), { size, shadow });
    cache.set(key, r);
    if (cache.size > LIMIT) cache.delete(cache.keys().next().value!);
  }
  return r;
}

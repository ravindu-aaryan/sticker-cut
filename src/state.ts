import type { Canvas } from './lib/canvas';
import type { StickerArtwork } from './lib/sticker';

export interface Photo {
  id: string;
  name: string;
  original: Canvas;
  thumb: string;
  cutThumb?: string;
  status: 'queued' | 'processing' | 'ready' | 'error';
  message?: string;
  progress?: number;
  warning?: string;
  art?: StickerArtwork;
  /** Bumps whenever `art` changes so caches invalidate. */
  version: number;
}

export const itemKey = (photoId: string, styleId: string) => `${photoId}::${styleId}`;

export function splitKey(key: string): [string, string] {
  const i = key.indexOf('::');
  return [key.slice(0, i), key.slice(i + 2)];
}

let counter = 0;
export const uid = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

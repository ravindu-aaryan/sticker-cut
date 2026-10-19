import { useEffect, useState } from 'react';
import { nextFrame } from '../lib/canvas';
import type { StickerStyle, StyleTweaks } from '../lib/styles';
import { cacheKey, getCached, getSticker } from '../renderCache';
import { itemKey, type Photo } from '../state';

const PREVIEW = 300;

interface Props {
  photo: Photo;
  styles: StickerStyle[];
  tweaks: StyleTweaks;
  selection: Record<string, number>;
  onToggle: (key: string) => void;
}

export function StyleGallery({ photo, styles, tweaks, selection, onToggle }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    // Show anything already cached instantly, then render the rest progressively.
    const initial: Record<string, string> = {};
    for (const s of styles) {
      const hit = getCached(cacheKey(photo, s, tweaks, PREVIEW, true));
      if (hit) initial[s.id] = hit.canvas.toDataURL();
    }
    setUrls(initial);
    (async () => {
      for (const s of styles) {
        if (cancelled) return;
        if (initial[s.id]) continue;
        await nextFrame();
        if (cancelled) return;
        try {
          const r = getSticker(photo, s, tweaks, PREVIEW, true);
          const url = r.canvas.toDataURL();
          if (!cancelled) setUrls((u) => ({ ...u, [s.id]: url }));
        } catch (err) {
          console.error(`Style ${s.id} failed`, err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [photo, styles, tweaks]);

  return (
    <div className="gallery">
      {styles.map((s) => {
        const key = itemKey(photo.id, s.id);
        const on = !!selection[key];
        return (
          <button key={s.id} className={`style-card${on ? ' on' : ''}${s.id.startsWith('ref-') ? ' ref' : ''}`} onClick={() => onToggle(key)} aria-pressed={on}>
            <span className="style-preview">
              {urls[s.id] ? <img src={urls[s.id]} alt={`${s.name} preview`} /> : <span className="spinner small" />}
            </span>
            <span className="style-name">{s.name}</span>
            <span className="style-desc">{s.description}</span>
            <span className="tick" aria-hidden>{on ? '✓ On sheet' : '+ Add to sheet'}</span>
          </button>
        );
      })}
    </div>
  );
}

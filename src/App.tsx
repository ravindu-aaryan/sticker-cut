import { useCallback, useMemo, useRef, useState } from 'react';
import { Dropzone } from './components/Dropzone';
import { StyleGallery } from './components/StyleGallery';
import { SheetPanel } from './components/SheetPanel';
import { AI_MODELS, removeBackground, type BackgroundMode } from './lib/background';
import { loadImageFile, resizeCanvas, toHex, parseColor, type Canvas } from './lib/canvas';
import { defaultEnhance, enhanceImage, type EnhanceOptions } from './lib/enhance';
import { analyzeReference, type ReferenceAnalysis } from './lib/reference';
import { defaultTweaks, PRESET_STYLES, type StickerStyle, type StyleTweaks } from './lib/styles';
import { defaultSheet, type SheetOptions } from './lib/sheet';
import { itemKey, uid, type Photo } from './state';

interface Reference {
  name: string;
  thumb: string;
  analysis: ReferenceAnalysis;
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bgMode, setBgMode] = useState<BackgroundMode>('ai');
  const [aiModel, setAiModel] = useState(AI_MODELS[0].id);
  const [enhance, setEnhance] = useState<EnhanceOptions>(defaultEnhance);
  const [reference, setReference] = useState<Reference | null>(null);
  const [tweaks, setTweaks] = useState<StyleTweaks>(defaultTweaks);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [sheet, setSheet] = useState<SheetOptions>(defaultSheet);
  const queue = useRef(Promise.resolve());

  const styles: StickerStyle[] = useMemo(
    () => (reference ? [reference.analysis.exactStyle, reference.analysis.matchStyle, ...PRESET_STYLES] : PRESET_STYLES),
    [reference],
  );

  const update = useCallback((id: string, patch: Partial<Photo>) => {
    setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const process = useCallback(
    (photo: Photo, settings: { bgMode: BackgroundMode; aiModel: string; enhance: EnhanceOptions }) => {
      // Photos are processed one at a time: AI models are memory hungry.
      queue.current = queue.current.then(async () => {
        const progress = (message: string, fraction?: number) => update(photo.id, { status: 'processing', message, progress: fraction });
        try {
          progress('Enhancing quality');
          const enhanced = await enhanceImage(photo.original, settings.enhance, progress);
          progress('Removing background');
          const { canvas: cutout, warning } = await removeBackground(enhanced, settings.bgMode, settings.aiModel, progress);
          setPhotos((ps) =>
            ps.map((p) =>
              p.id === photo.id
                ? {
                    ...p, status: 'ready', message: undefined, progress: undefined, warning,
                    art: { cutout, photo: enhanced }, cutThumb: thumbnail(cutout), version: p.version + 1,
                  }
                : p,
            ),
          );
        } catch (err) {
          console.error(err);
          update(photo.id, { status: 'error', message: (err as Error).message ?? String(err) });
        }
      });
    },
    [update],
  );

  const addPhotos = async (files: File[]) => {
    for (const file of files) {
      try {
        const original = await loadImageFile(file);
        const photo: Photo = {
          id: uid(),
          name: file.name,
          original,
          thumb: thumbnail(original),
          status: 'queued',
          message: 'Waiting…',
          version: 0,
        };
        setPhotos((ps) => [...ps, photo]);
        setActiveId((cur) => cur ?? photo.id);
        // Pre-select the classic die-cut for every new photo so the sheet is never empty.
        setSelection((s) => ({ ...s, [itemKey(photo.id, 'die-cut')]: 1 }));
        process(photo, { bgMode, aiModel, enhance });
      } catch (err) {
        alert(`Could not open ${file.name}: ${(err as Error).message}`);
      }
    }
  };

  const reprocessAll = () => {
    for (const p of photos) {
      update(p.id, { status: 'queued', message: 'Waiting…' });
      process(p, { bgMode, aiModel, enhance });
    }
  };

  const removePhoto = (id: string) => {
    setPhotos((ps) => ps.filter((p) => p.id !== id));
    setSelection((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(id + '::'))));
    if (activeId === id) setActiveId(photos.find((p) => p.id !== id)?.id ?? null);
  };

  const addReference = async (files: File[]) => {
    const file = files[0];
    const canvas = await loadImageFile(file, 2048);
    const analysis = analyzeReference(canvas);
    setReference({ name: file.name, thumb: thumbnail(canvas), analysis });
    // Select the exact-shape reference style for all photos.
    setSelection((s) => {
      const next = { ...s };
      for (const p of photos) next[itemKey(p.id, 'ref-exact')] = next[itemKey(p.id, 'ref-exact')] ?? 1;
      return next;
    });
  };

  const active = photos.find((p) => p.id === activeId) ?? photos[0] ?? null;
  const busy = photos.some((p) => p.status === 'processing' || p.status === 'queued');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>✂</span>
          <div>
            <h1>StickerCut</h1>
            <p>Photos → multi-style stickers → print-ready A4 sheet</p>
          </div>
        </div>
        <span className="privacy">Runs 100% in your browser — photos never leave your device</span>
      </header>

      <main className="layout">
        <aside className="sidebar">
          <section className="card">
            <h2><span className="step">1</span> Upload photos</h2>
            <Dropzone onFiles={addPhotos}>
              <strong>Drop photos here</strong>
              <span>or click to choose · JPG, PNG, WebP, HEIC*</span>
            </Dropzone>
            {photos.length > 0 && (
              <ul className="photo-list">
                {photos.map((p) => (
                  <li key={p.id} className={p.id === active?.id ? 'active' : ''}>
                    <button className="photo-pick" onClick={() => setActiveId(p.id)} title={p.name}>
                      <img src={p.cutThumb ?? p.thumb} alt="" className="checker" />
                      <span className="photo-meta">
                        <span className="photo-name">{p.name}</span>
                        <span className={`status ${p.status}`}>
                          {p.status === 'ready' ? (p.warning ? '⚠ ready (fallback)' : '✓ ready') : p.message}
                          {p.progress !== undefined && ` ${Math.round(p.progress * 100)}%`}
                        </span>
                      </span>
                    </button>
                    <button className="icon-btn" aria-label={`Remove ${p.name}`} onClick={() => removePhoto(p.id)}>×</button>
                  </li>
                ))}
              </ul>
            )}
            {active?.warning && <p className="warn">{active.warning}</p>}
          </section>

          <section className="card">
            <h2><span className="step">2</span> Quality &amp; cut-out</h2>
            <label className="field">
              <span>Background removal</span>
              <select value={bgMode} onChange={(e) => setBgMode(e.target.value as BackgroundMode)}>
                <option value="ai">AI (any subject)</option>
                <option value="color">Plain backdrop (colour key)</option>
                <option value="none">Keep background</option>
              </select>
            </label>
            {bgMode === 'ai' && (
              <label className="field">
                <span>AI model</span>
                <select value={aiModel} onChange={(e) => setAiModel(e.target.value)}>
                  {AI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <small>{AI_MODELS.find((m) => m.id === aiModel)?.note}. Downloaded once, then cached.</small>
              </label>
            )}
            <label className="field">
              <span>Upscaling</span>
              <select value={enhance.upscale} onChange={(e) => setEnhance({ ...enhance, upscale: e.target.value as EnhanceOptions['upscale'] })}>
                <option value="ai">AI super-resolution (ESRGAN)</option>
                <option value="classic">Classic high-quality resize</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="field">
              <span>Target resolution <b>{enhance.targetLongSide}px</b></span>
              <input type="range" min={1000} max={3000} step={100} value={enhance.targetLongSide}
                onChange={(e) => setEnhance({ ...enhance, targetLongSide: +e.target.value })} />
            </label>
            <label className="field">
              <span>Sharpen <b>{Math.round(enhance.sharpen * 100)}%</b></span>
              <input type="range" min={0} max={1} step={0.05} value={enhance.sharpen}
                onChange={(e) => setEnhance({ ...enhance, sharpen: +e.target.value })} />
            </label>
            <label className="field">
              <span>Vibrance <b>{Math.round(enhance.vibrance * 100)}%</b></span>
              <input type="range" min={-0.5} max={0.8} step={0.05} value={enhance.vibrance}
                onChange={(e) => setEnhance({ ...enhance, vibrance: +e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={enhance.autoLevels} onChange={(e) => setEnhance({ ...enhance, autoLevels: e.target.checked })} />
              Auto contrast
            </label>
            <button className="btn secondary" disabled={!photos.length || busy} onClick={reprocessAll}>
              Apply to all photos
            </button>
          </section>

          <section className="card">
            <h2><span className="step">3</span> Reference template <em>(optional)</em></h2>
            <p className="hint">Upload a sticker you like. StickerCut copies its cut shape, border colour and thickness.</p>
            <Dropzone onFiles={addReference} multiple={false} compact>
              {reference ? (
                <span className="ref-row">
                  <img src={reference.thumb} alt="" className="checker" />
                  <span>{reference.name}<br /><small>Click to replace</small></span>
                </span>
              ) : (
                <>
                  <strong>Drop a reference sticker</strong>
                  <span>PNG with transparency works best</span>
                </>
              )}
            </Dropzone>
            {reference && <ReferenceSummary analysis={reference.analysis} onClear={() => setReference(null)} />}
          </section>

          <section className="card">
            <h2>Style tweaks</h2>
            <label className="field">
              <span>Border thickness <b>×{tweaks.borderScale.toFixed(2)}</b></span>
              <input type="range" min={0} max={2.5} step={0.05} value={tweaks.borderScale}
                onChange={(e) => setTweaks({ ...tweaks, borderScale: +e.target.value })} />
            </label>
            <ColorOverride label="Border colour" value={tweaks.borderColor} fallback="#ffffff"
              onChange={(borderColor) => setTweaks({ ...tweaks, borderColor })} />
            <ColorOverride label="Shape background" value={tweaks.fill} fallback="#ffffff"
              onChange={(fill) => setTweaks({ ...tweaks, fill })} />
          </section>
        </aside>

        <div className="content">
          <section className="card">
            <div className="card-head">
              <h2><span className="step">4</span> Pick sticker styles</h2>
              {photos.length > 1 && (
                <div className="tabs" role="tablist">
                  {photos.map((p) => (
                    <button key={p.id} role="tab" aria-selected={p.id === active?.id} className={p.id === active?.id ? 'on' : ''} onClick={() => setActiveId(p.id)}>
                      {p.name.length > 16 ? p.name.slice(0, 14) + '…' : p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!active ? (
              <EmptyState />
            ) : !active.art ? (
              <div className="processing">
                <div className="spinner" />
                <p>{active.message ?? 'Processing…'}{active.progress !== undefined && ` ${Math.round(active.progress * 100)}%`}</p>
                <small>First run downloads the AI models (~50–100 MB), later runs are much faster.</small>
              </div>
            ) : (
              <StyleGallery
                photo={active}
                styles={styles}
                tweaks={tweaks}
                selection={selection}
                onToggle={(key) =>
                  setSelection((s) => {
                    const next = { ...s };
                    if (next[key]) delete next[key]; else next[key] = 1;
                    return next;
                  })
                }
              />
            )}
          </section>

          <SheetPanel
            photos={photos}
            styles={styles}
            tweaks={tweaks}
            selection={selection}
            setSelection={setSelection}
            options={sheet}
            setOptions={setSheet}
          />
        </div>
      </main>
      <footer className="foot">
        *HEIC opens only in browsers that support it (Safari). Print the PNG/PDF at 100% scale (“actual size”).
      </footer>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden>
        <span>🐱</span><span>⭐</span><span>💖</span>
      </div>
      <p>Upload a photo to see it as die-cut, bubble, circle, heart, star, polaroid and more.</p>
    </div>
  );
}

function ReferenceSummary({ analysis: a, onClear }: { analysis: ReferenceAnalysis; onClear: () => void }) {
  return (
    <div className="ref-summary">
      <dl>
        <dt>Cut shape</dt>
        <dd>{a.shape === 'contour' ? 'Die-cut contour' : a.shape} <small>({Math.round(a.shapeConfidence * 100)}% fit)</small></dd>
        <dt>Border</dt>
        <dd>
          <i className="swatch" style={{ background: a.borderColor }} />
          {a.borderRatio > 0 ? `${(a.borderRatio * 100).toFixed(1)}% thick` : 'none'}
        </dd>
        {a.outlineColor && (
          <>
            <dt>Ink outline</dt>
            <dd><i className="swatch" style={{ background: a.outlineColor }} />{(a.outlineRatio * 100).toFixed(1)}%</dd>
          </>
        )}
        <dt>Inside</dt>
        <dd>
          {a.photoContent ? 'Full photo' : (<><i className="swatch" style={{ background: a.fillColor }} />solid fill</>)}
        </dd>
      </dl>
      <button className="link" onClick={onClear}>Remove reference</button>
    </div>
  );
}

function ColorOverride({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  return (
    <div className="field color-field">
      <span>{label}</span>
      <div className="color-row">
        <label className="check">
          <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : fallback)} />
          Style default
        </label>
        <input type="color" aria-label={label} value={value ?? fallback} disabled={value === null}
          onChange={(e) => onChange(toHex(parseColor(e.target.value)))} />
      </div>
    </div>
  );
}

function thumbnail(c: Canvas): string {
  const s = Math.min(1, 160 / Math.max(c.width, c.height));
  return resizeCanvas(c, c.width * s, c.height * s).toDataURL('image/png');
}

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { nextFrame } from '../lib/canvas';
import { canvasToPngWithDpi, cutLinesSvg, downloadBlob, sheetPdf } from '../lib/export';
import {
  layoutSheet, pageCutPaths, pageSize, prepareSheetSticker, renderPage, stickerSizeMm,
  type Placement, type SheetOptions, type SheetSticker,
} from '../lib/sheet';
import type { StickerStyle, StyleTweaks } from '../lib/styles';
import { getSticker } from '../renderCache';
import { splitKey, type Photo } from '../state';

interface Props {
  photos: Photo[];
  styles: StickerStyle[];
  tweaks: StyleTweaks;
  selection: Record<string, number>;
  setSelection: Dispatch<SetStateAction<Record<string, number>>>;
  options: SheetOptions;
  setOptions: (o: SheetOptions) => void;
}

interface Item {
  key: string;
  photo: Photo;
  style: StickerStyle;
  copies: number;
}

interface Built {
  items: Item[];
  stickers: SheetSticker[];
  pages: Placement[][];
}

const PREVIEW_PX_PER_MM = 3;

export function SheetPanel({ photos, styles, tweaks, selection, setSelection, options, setOptions }: Props) {
  const [built, setBuilt] = useState<Built | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [working, setWorking] = useState<string | null>(null);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const [key, copies] of Object.entries(selection)) {
      const [pid, sid] = splitKey(key);
      const photo = photos.find((p) => p.id === pid);
      const style = styles.find((s) => s.id === sid);
      if (photo?.art && style) out.push({ key, photo, style, copies });
    }
    return out;
  }, [selection, photos, styles]);

  const printPx = (options.stickerMm / 25.4) * options.dpi;

  // Rebuild layout + preview (debounced) whenever inputs change.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!items.length) { setBuilt(null); setPreviews([]); return; }
      setWorking('Laying out sheet…');
      await nextFrame();
      const stickers: SheetSticker[] = [];
      for (const it of items) {
        if (cancelled) return;
        stickers.push(prepareSheetSticker(getSticker(it.photo, it.style, tweaks, printPx, false)));
        await nextFrame();
      }
      const sizes = stickers.map((s) => stickerSizeMm(s.sticker, options.stickerMm));
      const pages = layoutSheet(sizes, items.map((i) => i.copies), options);
      if (cancelled) return;
      const urls = pages.map((p) => renderPage(p, stickers, options, PREVIEW_PX_PER_MM, true).toDataURL('image/jpeg', 0.85));
      if (cancelled) return;
      setBuilt({ items, stickers, pages });
      setPreviews(urls);
      setPageIdx((i) => Math.min(i, Math.max(0, pages.length - 1)));
      setWorking(null);
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [items, tweaks, options, printPx]);

  const page = pageSize(options);
  const count = built?.pages.reduce((n, p) => n + p.length, 0) ?? 0;
  const tooBig = built ? built.stickers.length > 0 && count === 0 : false;

  const fullPages = async (opts: SheetOptions = options) => {
    if (!built) return [];
    const out = [];
    for (const p of built.pages) {
      out.push(renderPage(p, built.stickers, opts));
      await nextFrame();
    }
    return out;
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    await nextFrame();
    try { await fn(); } catch (err) { alert(`Export failed: ${(err as Error).message}`); console.error(err); }
    setWorking(null);
  };

  const downloadPng = () => run('Rendering 300 DPI PNG…', async () => {
    const canvases = await fullPages();
    for (let i = 0; i < canvases.length; i++) {
      downloadBlob(await canvasToPngWithDpi(canvases[i], options.dpi), `sticker-sheet-A4${canvases.length > 1 ? `-p${i + 1}` : ''}.png`);
    }
  });

  const downloadPdf = () => run('Building PDF…', async () => {
    if (!built) return;
    // Cut lines (when enabled) are added to the PDF as crisp vectors, not pixels.
    const raster = await fullPages({ ...options, printCutLines: false });
    const cuts = built.pages.map((p) => pageCutPaths(p, built.stickers));
    downloadBlob(await sheetPdf(raster, cuts, page, options.printCutLines), 'sticker-sheet-A4.pdf');
  });

  const downloadSvg = () => run('Tracing cut lines…', async () => {
    if (!built) return;
    const svgs = cutLinesSvg(built.pages.map((p) => pageCutPaths(p, built.stickers)), page);
    svgs.forEach((svg, i) => downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `sticker-cut-lines-A4${svgs.length > 1 ? `-p${i + 1}` : ''}.svg`));
  });

  const downloadZip = () => run('Packing stickers…', async () => {
    if (!built) return;
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (let i = 0; i < built.items.length; i++) {
      const it = built.items[i];
      const name = `${it.photo.name.replace(/\.[^.]+$/, '')}-${it.style.id}.png`.replace(/[^\w.-]+/g, '_');
      zip.file(name, await canvasToPngWithDpi(built.stickers[i].sticker.canvas, options.dpi));
    }
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'stickers.zip');
  });

  const set = <K extends keyof SheetOptions>(k: K, v: SheetOptions[K]) => setOptions({ ...options, [k]: v });

  return (
    <section className="card sheet">
      <div className="card-head">
        <h2><span className="step">5</span> A4 sticker sheet</h2>
        <span className="muted">{count ? `${count} sticker${count > 1 ? 's' : ''} · ${built?.pages.length} page${(built?.pages.length ?? 0) > 1 ? 's' : ''} · ${options.dpi} DPI` : ''}</span>
      </div>

      <div className="sheet-grid">
        <div className="sheet-controls">
          <div className="seg" role="radiogroup" aria-label="Orientation">
            {(['portrait', 'landscape'] as const).map((o) => (
              <button key={o} role="radio" aria-checked={options.orientation === o} className={options.orientation === o ? 'on' : ''} onClick={() => set('orientation', o)}>
                {o === 'portrait' ? '▯ Portrait' : '▭ Landscape'}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Sticker size (long side) <b>{options.stickerMm} mm</b></span>
            <input type="range" min={20} max={190} step={1} value={options.stickerMm} onChange={(e) => set('stickerMm', +e.target.value)} />
          </label>
          <div className="two">
            <label className="field">
              <span>Margin (mm)</span>
              <input type="number" min={0} max={40} value={options.marginMm} onChange={(e) => set('marginMm', clampNum(e.target.value, 0, 40))} />
            </label>
            <label className="field">
              <span>Gap (mm)</span>
              <input type="number" min={0} max={30} value={options.gapMm} onChange={(e) => set('gapMm', clampNum(e.target.value, 0, 30))} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={options.fillPage} onChange={(e) => set('fillPage', e.target.checked)} />
            Fill the page (repeat selected stickers)
          </label>
          <label className="check">
            <input type="checkbox" checked={options.printCutLines} onChange={(e) => set('printCutLines', e.target.checked)} />
            Show cut lines on the print
          </label>
          <label className="check">
            <input type="checkbox" checked={options.transparent} onChange={(e) => set('transparent', e.target.checked)} />
            Transparent sheet background (PNG)
          </label>

          <h3>On this sheet</h3>
          {!items.length && <p className="hint">Select styles above to add them to the sheet.</p>}
          <ul className="sheet-items">
            {items.map((it) => (
              <li key={it.key}>
                <img src={it.photo.cutThumb ?? it.photo.thumb} alt="" className="checker" />
                <span className="grow">
                  <b>{it.style.name}</b>
                  <small>{it.photo.name}</small>
                </span>
                {!options.fillPage && (
                  <input type="number" min={1} max={99} value={it.copies} aria-label="Copies"
                    onChange={(e) => setSelection((s) => ({ ...s, [it.key]: clampNum(e.target.value, 1, 99) }))} />
                )}
                <button className="icon-btn" aria-label="Remove from sheet" onClick={() => setSelection((s) => { const n = { ...s }; delete n[it.key]; return n; })}>×</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="sheet-preview">
          <div className={`paper ${options.orientation}`}>
            {previews[pageIdx] ? <img src={previews[pageIdx]} alt="A4 sheet preview" /> : <span className="paper-empty">{working ?? 'Your A4 sheet appears here'}</span>}
            {working && previews[pageIdx] && <span className="paper-busy">{working}</span>}
          </div>
          {previews.length > 1 && (
            <div className="pager">
              <button disabled={pageIdx === 0} onClick={() => setPageIdx(pageIdx - 1)}>‹</button>
              <span>Page {pageIdx + 1} / {previews.length}</span>
              <button disabled={pageIdx >= previews.length - 1} onClick={() => setPageIdx(pageIdx + 1)}>›</button>
            </div>
          )}
          {tooBig && <p className="warn">Stickers are larger than the printable area — reduce the size or margin.</p>}
          <div className="downloads">
            <button className="btn" disabled={!count || !!working} onClick={downloadPdf}>Download PDF</button>
            <button className="btn" disabled={!count || !!working} onClick={downloadPng}>PNG (300 DPI)</button>
            <button className="btn secondary" disabled={!count || !!working} onClick={downloadSvg} title="For Cricut Design Space, Silhouette Studio, Brother ScanNCut…">Cut lines (SVG)</button>
            <button className="btn secondary" disabled={!count || !!working} onClick={downloadZip} title="Each sticker as a transparent PNG — great for Cricut Print Then Cut">Stickers (ZIP)</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function clampNum(v: string, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

'use client';

import { useState, useEffect, useMemo } from 'react';
import { C, FONT, SHADOW } from '@/lib/theme';
import BearFace from './BearFace';
import Icon from './Icon';
import ScreenHeader from './ScreenHeader';
import ShelfScanner from './ShelfScanner';
import type { DetectedProduct } from '@/lib/gemini';
import { getShelf } from '@/lib/shelves';
import StoreMapModal from './StoreMapModal';
import { UsageTotals, EMPTY_USAGE, addUsage } from '@/lib/cost';
import { useTranslation } from '@/lib/i18n';

type Screen = 'home' | 'snap' | 'progress' | 'find';

export interface SnapPayload {
  aisle: string;
  products: DetectedProduct[];
  /** Sum of usage across every vision call that contributed products. */
  visionUsage: UsageTotals;
}

interface SnapScreenProps {
  go: (screen: Screen) => void;
  onSubmit: (payload: SnapPayload) => void;
}

type PhotoStatus = 'pending' | 'detecting' | 'done' | 'error';

interface PhotoState {
  id: string;
  file: File;
  previewUrl: string;
  status: PhotoStatus;
  products: DetectedProduct[];
  error?: string;
  /** Per-photo Gemini + storage usage returned by /api/vision. */
  usage?: UsageTotals;
}

/** Cap on simultaneous /api/vision calls per client. Each call fans into
 *  parallel Gemini sub-batches server-side, and the demo project's Vertex
 *  quota is small — 5 photos in flight caused sustained 429 backoff storms
 *  that made every photo slower. 2 keeps the pipe full without the penalty
 *  (the server also rate-gates Gemini calls globally now). */
const CLIENT_CONCURRENCY = 2;

function Label({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      margin: '20px 0 10px', fontFamily: FONT,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{children}</div>
      {action}
    </div>
  );
}

async function cropThumbnails(file: File, products: DetectedProduct[]): Promise<DetectedProduct[]> {
  // Server returns a representative thumbnail per SKU. Only fall back to
  // client-side canvas cropping if some products are missing thumbnails.
  const needsCrop = products.some(p => !p.thumbnail && Array.isArray(p.box_2d) && p.box_2d.length === 4);
  if (!needsCrop) return products;

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
    return products.map(p => {
      if (p.thumbnail) return p;
      if (!p.box_2d || p.box_2d.length !== 4) return p;
      const [y0, x0, y1, x1] = p.box_2d;
      const sx = (Math.min(x0, x1) / 1000) * img.width;
      const sy = (Math.min(y0, y1) / 1000) * img.height;
      const sw = (Math.abs(x1 - x0) / 1000) * img.width;
      const sh = (Math.abs(y1 - y0) / 1000) * img.height;
      if (sw < 8 || sh < 8) return p;
      const TARGET = 160;
      const ratio = sh / sw;
      const canvas = document.createElement('canvas');
      canvas.width = TARGET;
      canvas.height = Math.max(40, Math.min(TARGET * 2, Math.round(TARGET * ratio)));
      const ctx = canvas.getContext('2d');
      if (!ctx) return p;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return { ...p, thumbnail: canvas.toDataURL('image/jpeg', 0.78) };
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function SnapScreen({ go, onSubmit }: SnapScreenProps) {
  const { t } = useTranslation();
  // Empty until the worker picks a shelf — this gates the whole capture area,
  // so the shelf picker is the first (and only) thing they see on arrival.
  const [location, setLocation] = useState('');
  const [showMap, setShowMap] = useState(false);
  const [photos, setPhotos] = useState<PhotoState[]>([]);
  const [removedNames, setRemovedNames] = useState<Set<string>>(new Set());
  // Built-in demo shelf photo for visitors (judges) with no real shelf at
  // hand. The button only appears if /sample-shelf.jpg actually exists in
  // public/, so shipping without the asset simply hides the feature.
  // The sample was REALLY shot on shelf B10, so using it force-selects and
  // locks B10 — demo saves land on the shelf the photo came from instead of
  // polluting whichever shelf a visitor happened to tap.
  const SAMPLE_SHELF = 'B10';
  const [sampleAvailable, setSampleAvailable] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleUsed, setSampleUsed] = useState(false);
  /** When non-null, the Detected items list filters to only the SKUs from
   *  this one photo. Tap the same chip again (or "Show all") to clear. */
  const [filterPhotoId, setFilterPhotoId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/sample-shelf.jpg', { method: 'HEAD' })
      .then(r => setSampleAvailable(r.ok))
      .catch(() => {});
  }, []);

  // Revoke preview object URLs on unmount.
  useEffect(() => {
    return () => {
      photos.forEach(p => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Worker loop — keep up to CLIENT_CONCURRENCY photos in 'detecting' at any
  // time. The effect re-runs whenever a photo changes status (since photos is
  // the dependency), so as soon as one finishes, the next pending one starts.
  useEffect(() => {
    const inFlight = photos.filter(p => p.status === 'detecting').length;
    if (inFlight >= CLIENT_CONCURRENCY) return;
    const pending = photos.filter(p => p.status === 'pending');
    if (pending.length === 0) return;

    const slots = CLIENT_CONCURRENCY - inFlight;
    const toStart = pending.slice(0, slots);

    setPhotos(prev =>
      prev.map(x =>
        toStart.find(t => t.id === x.id) ? { ...x, status: 'detecting' } : x
      )
    );

    toStart.forEach(p => {
      const fd = new FormData();
      fd.append('image', p.file);
      fd.append('aisle', location);
      fetch('/api/vision', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(async data => {
          if (!data.ok) {
            setPhotos(prev =>
              prev.map(x => x.id === p.id ? { ...x, status: 'error', error: data.error || 'Detection failed' } : x)
            );
            return;
          }
          const raw = (data.products || []) as DetectedProduct[];
          const withThumbs = await cropThumbnails(p.file, raw).catch(() => raw);
          const photoUsage = (data.usage as UsageTotals | undefined) ?? { ...EMPTY_USAGE };
          setPhotos(prev =>
            prev.map(x => x.id === p.id ? { ...x, status: 'done', products: withThumbs, usage: photoUsage } : x)
          );
        })
        .catch(err => {
          setPhotos(prev =>
            prev.map(x => x.id === p.id ? { ...x, status: 'error', error: err instanceof Error ? err.message : String(err) } : x)
          );
        });
    });
  }, [photos, location]);

  // Merged + deduped detection across ALL completed photos — this is what
  // we submit to the server. If two photos saw the same SKU, prefer the
  // entry with a thumbnail and higher confidence.
  const mergedDetected = useMemo(() => {
    const rank = (c: string | undefined) =>
      c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
    const byName = new Map<string, DetectedProduct>();
    for (const p of photos) {
      if (p.status !== 'done') continue;
      for (const prod of p.products) {
        if (removedNames.has(prod.name)) continue;
        const prior = byName.get(prod.name);
        if (!prior) {
          byName.set(prod.name, prod);
          continue;
        }
        const better =
          (!prior.thumbnail && prod.thumbnail) ||
          rank(prod.confidence) > rank(prior.confidence);
        if (better) byName.set(prod.name, prod);
      }
    }
    return Array.from(byName.values());
  }, [photos, removedNames]);

  // Filtered VIEW for the Detected items list. If a photo is selected, only
  // show its SKUs (deduped within itself); otherwise show the merged set
  // across all photos. Submit always uses mergedDetected regardless.
  const viewDetected = useMemo(() => {
    if (!filterPhotoId) return mergedDetected;
    const photo = photos.find(p => p.id === filterPhotoId);
    if (!photo) return mergedDetected;
    const seen = new Set<string>();
    const out: DetectedProduct[] = [];
    for (const prod of photo.products) {
      if (removedNames.has(prod.name)) continue;
      if (seen.has(prod.name)) continue;
      seen.add(prod.name);
      out.push(prod);
    }
    return out;
  }, [filterPhotoId, photos, mergedDetected, removedNames]);

  const handleAddFiles = (files: File[]) => {
    if (files.length === 0) return;
    const newStates: PhotoState[] = files.map((f, i) => ({
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      previewUrl: URL.createObjectURL(f),
      status: 'pending',
      products: [],
    }));
    setPhotos(prev => [...prev, ...newStates]);
  };

  const handleScannerCapture = (f: File) => handleAddFiles([f]);
  const handleScannerUpload = (files: File[]) => handleAddFiles(files);

  const removePhoto = (id: string) => {
    setPhotos(prev => {
      const p = prev.find(x => x.id === id);
      if (p) URL.revokeObjectURL(p.previewUrl);
      const next = prev.filter(x => x.id !== id);
      if (next.length === 0) setSampleUsed(false); // unlock the shelf picker
      return next;
    });
    if (filterPhotoId === id) setFilterPhotoId(null);
  };

  const togglePhotoFilter = (id: string) => {
    setFilterPhotoId(prev => (prev === id ? null : id));
  };

  const retryPhoto = (id: string) => {
    setPhotos(prev => prev.map(x => x.id === id ? { ...x, status: 'pending', error: undefined } : x));
  };

  const removeDetected = (name: string) => {
    setRemovedNames(s => {
      const next = new Set(s);
      next.add(name);
      return next;
    });
  };

  const handleSubmit = () => {
    if (mergedDetected.length === 0) return;
    // Sum vision usage across every photo that contributed. ProgressScreen
    // adds in alias + storage costs from the SSE stream to produce a CAD
    // total for the whole run.
    const visionUsage = photos.reduce<UsageTotals>(
      (acc, p) => (p.usage ? addUsage(acc, p.usage) : acc),
      { ...EMPTY_USAGE }
    );
    // Always submit the merged unique set regardless of the current view filter.
    onSubmit({ aisle: location, products: mergedDetected, visionUsage });
    go('progress');
  };

  const totalPhotos = photos.length;
  const donePhotos = photos.filter(p => p.status === 'done').length;
  const detectingCount = photos.filter(p => p.status === 'detecting' || p.status === 'pending').length;
  const errorCount = photos.filter(p => p.status === 'error').length;
  const anyDetecting = detectingCount > 0;
  const canSubmit = mergedDetected.length > 0 && !anyDetecting;

  const currentShelf = getShelf(location);
  const filterIndex = filterPhotoId ? photos.findIndex(p => p.id === filterPhotoId) : -1;
  // The big preview at the top mirrors whichever chip the worker is reviewing.
  // Falls back to the most recent photo when no chip is selected.
  const activePreview =
    filterIndex >= 0
      ? photos[filterIndex].previewUrl
      : photos.length > 0
        ? photos[photos.length - 1].previewUrl
        : null;

  const submitLabel = (() => {
    if (totalPhotos === 0) return t('snap_save_first');
    if (anyDetecting) return t('snap_save_busy', donePhotos, totalPhotos);
    if (mergedDetected.length === 0) return errorCount > 0 ? t('snap_save_retry') : t('snap_save_nothing');
    return t('snap_save_n', mergedDetected.length, location);
  })();

  return (
    <div style={{ padding: '62px 20px 130px', fontFamily: FONT, color: C.text }}>
      <ScreenHeader title={t('snap')} onBack={() => go('home')} />

      {/* Shelf picker — locked while the sample photo is in use (the sample
          is hard-bound to its real shelf, see SAMPLE_SHELF). */}
      <Label>{t('snap_location')}</Label>
      <button onClick={() => { if (!sampleUsed) setShowMap(true); }} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: location ? C.white : C.primarySofter,
        border: location ? `1px solid ${C.border}` : `1.5px dashed ${C.primary}`,
        borderRadius: 14,
        padding: '12px 14px', fontFamily: FONT, fontSize: 15, color: C.text, fontWeight: 500,
        cursor: 'pointer',
      }}>
        {location ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 38, height: 28, padding: '0 8px',
              background: C.primary, color: C.text, border: `2px solid ${C.border}`, borderRadius: 8,
              fontWeight: 800, fontSize: 14,
              fontFamily: 'ui-monospace, monospace',
            }}>{location}</span>
            <span style={{
              fontSize: 13, color: C.textMuted, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {currentShelf?.description}
            </span>
          </span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            color: C.primaryDark, fontWeight: 700, fontSize: 14.5,
          }}>
            <Icon name="pin" size={18} style={{ color: C.primary }} />
            {t('snap_choose_shelf')}
          </span>
        )}
        <Icon name="map" size={20} style={{ color: location ? C.textMuted : C.primary, flexShrink: 0 }} />
      </button>

      {showMap && (
        <StoreMapModal
          current={location}
          onConfirm={code => { setLocation(code); setShowMap(false); }}
          onClose={() => setShowMap(false)}
        />
      )}

      {sampleUsed && (
        <div style={{
          marginTop: 8, fontSize: 12.5, color: C.primaryDark, fontWeight: 600,
          lineHeight: 1.45, padding: '8px 12px',
          background: C.primarySofter, borderRadius: 10,
        }}>
          🔒 {t('snap_sample_b10')}
        </div>
      )}

      {location ? (
        <div style={{ marginTop: 16 }}>
          <ShelfScanner
            capturedPreview={activePreview}
            onCapture={handleScannerCapture}
            onUpload={handleScannerUpload}
          />
        </div>
      ) : (
        <div style={{
          marginTop: 16, padding: '26px 18px',
          background: C.bgMuted, border: `1px dashed ${C.border}`, borderRadius: 16,
          textAlign: 'center', color: C.textMuted, fontSize: 14.5, fontWeight: 600,
          lineHeight: 1.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        }}>
          <Icon name="pin" size={28} style={{ color: C.primary }} />
          {t('snap_choose_first')}
        </div>
      )}

      {/* One-tap demo path: works with NO shelf knowledge — picks the sample
          photo's real shelf (B10) and locks the picker so demo saves can't
          land on the wrong shelf. */}
      {sampleAvailable && totalPhotos === 0 && (
        <>
          <button
            onClick={async () => {
              if (sampleLoading) return;
              setSampleLoading(true);
              try {
                const res = await fetch('/sample-shelf.jpg');
                const blob = await res.blob();
                setLocation(SAMPLE_SHELF);
                setSampleUsed(true);
                handleAddFiles([new File([blob], 'sample-shelf.jpg', { type: blob.type || 'image/jpeg' })]);
              } finally {
                setSampleLoading(false);
              }
            }}
            disabled={sampleLoading}
            style={{
              width: '100%', marginTop: 12, padding: '12px 0',
              background: 'transparent', color: C.primaryDark,
              border: `1.5px dashed ${C.primary}`, borderRadius: 14,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: sampleLoading ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}
          >
            <Icon name={sampleLoading ? 'dots' : 'image'} size={16} />
            {sampleLoading ? t('snap_sample_loading') : t('snap_sample')}
          </button>
          <div style={{
            marginTop: 6, fontSize: 12, color: C.textMuted, fontWeight: 500,
            textAlign: 'center', lineHeight: 1.4,
          }}>
            {t('snap_sample_b10')}
          </div>
        </>
      )}

      {/* Photo strip — horizontal scroll showing each queued photo + state.
          Upload button above is multi-select; tap a chip to filter Detected
          items to that photo only. */}
      {totalPhotos > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
              {t('snap_photos')} · {donePhotos}/{totalPhotos}
              {errorCount > 0 && (
                <span style={{ color: '#c33', marginLeft: 6, fontWeight: 600 }}>
                  · {errorCount} {t('snap_failed')}
                </span>
              )}
            </div>
            {anyDetecting && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 12, color: C.textMuted, fontWeight: 600,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: C.primary, animation: 'pulse 1.4s ease-in-out infinite',
                }} />
                {detectingCount} {t('snap_reading')}
              </span>
            )}
          </div>

          {/* Batch progress bar — real progress (done+failed)/total, with a
              live sweep while any photo is still detecting so it never looks stuck. */}
          <div style={{
            position: 'relative', height: 6, borderRadius: 3,
            background: C.bgMuted, overflow: 'hidden', marginBottom: 10,
          }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${Math.round(((donePhotos + errorCount) / totalPhotos) * 100)}%`,
              background: C.primary, borderRadius: 3,
              transition: 'width 0.45s ease',
            }} />
            {anyDetecting && (
              <div style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, width: '40%',
                background: `linear-gradient(90deg, transparent, ${C.primarySoft}, transparent)`,
                animation: 'indeterminate 1.2s ease-in-out infinite',
              }} />
            )}
          </div>

          <div style={{
            display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6,
            scrollbarWidth: 'none',
          }}>
            {photos.map(p => (
              <PhotoChip
                key={p.id}
                photo={p}
                selected={p.id === filterPhotoId}
                onSelect={togglePhotoFilter}
                onRemove={removePhoto}
                onRetry={retryPhoto}
              />
            ))}
          </div>
        </div>
      )}

      <Label action={viewDetected.length > 0 ? (
        <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>
          {viewDetected.length} {t('snap_unique')}
        </span>
      ) : null}>{t('snap_detected')}</Label>

      {filterPhotoId && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: C.primarySofter, color: C.primaryDark,
          padding: '8px 12px', borderRadius: 10, marginBottom: 10,
          fontSize: 13, fontWeight: 600,
        }}>
          <span>
            {t('snap_showing_photo', filterIndex + 1, totalPhotos, mergedDetected.length)}
          </span>
          <button onClick={() => setFilterPhotoId(null)} style={{
            border: 'none', background: 'transparent', color: C.primary,
            fontFamily: FONT, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            padding: 0,
          }}>
            {t('snap_show_all')}
          </button>
        </div>
      )}

      {totalPhotos === 0 && (
        <div style={{
          padding: '20px 16px', background: C.bgMuted, borderRadius: 14,
          color: C.textMuted, fontSize: 14, textAlign: 'center', fontWeight: 500,
        }}>
          {t('snap_empty')}
        </div>
      )}

      {totalPhotos > 0 && anyDetecting && viewDetected.length === 0 && (
        <>
          <div style={{
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 14,
            overflow: 'hidden',
          }}>
            {[1, 2, 3, 4].map((i, idx) => (
              <div key={i} style={{
                padding: '12px 14px',
                borderTop: idx ? `1px solid ${C.border}` : 'none',
              }}>
                <div style={{
                  height: 14,
                  width: `${50 + (i * 13) % 40}%`,
                  background: `linear-gradient(90deg, ${C.primarySofter} 0%, ${C.bgMuted} 50%, ${C.primarySofter} 100%)`,
                  backgroundSize: '200% 100%',
                  borderRadius: 4,
                  animation: 'shimmer 1.4s ease-in-out infinite',
                }} />
              </div>
            ))}
          </div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontSize: 13, color: C.textMuted, fontWeight: 600, marginTop: 10,
          }}>
            <BearFace size={26} />
            {t('snap_reading_n', detectingCount)}
          </div>
        </>
      )}

      {totalPhotos > 0 && !anyDetecting && viewDetected.length === 0 && (
        <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>
          {filterPhotoId ? t('snap_empty_photo') : t('snap_nothing', totalPhotos)}
        </div>
      )}

      {viewDetected.length > 0 && (
        <div style={{
          background: C.white, border: `1px solid ${C.border}`, borderRadius: 14,
          overflow: 'hidden',
        }}>
          {viewDetected.map((d, i) => (
            <div key={d.name} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px',
              borderTop: i ? `1px solid ${C.border}` : 'none',
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: 10, overflow: 'hidden',
                background: C.bgMuted, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${C.border}`,
              }}>
                {d.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.thumbnail} alt={d.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Icon name="image" size={22} style={{ color: C.textSoft }} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14.5, fontWeight: 600, color: C.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{d.name}</div>
                {(d.category || d.confidence) && (
                  <div style={{ fontSize: 12, color: C.textSoft, marginTop: 1 }}>
                    {[d.category, d.confidence].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
              <button onClick={() => removeDetected(d.name)} style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: C.textMuted, padding: 4, display: 'flex',
                alignItems: 'center', flexShrink: 0,
              }} aria-label={`Remove ${d.name}`}>
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={handleSubmit} disabled={!canSubmit} style={{
        width: '100%', marginTop: 22, padding: '17px 0',
        background: canSubmit ? C.primary : C.bgMuted, color: canSubmit ? C.text : C.textSoft, border: `2px solid ${C.border}`, borderRadius: 16,
        fontFamily: FONT, fontSize: 17, fontWeight: 800,
        cursor: canSubmit ? 'pointer' : 'not-allowed',
        boxShadow: canSubmit ? SHADOW : 'none',
        transition: 'background .2s',
      }}>
        {submitLabel}
      </button>

      <div style={{
        marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, color: C.textMuted, fontSize: 13.5,
      }}>
        <BearFace size={30} />
        {t('snap_tip')}
      </div>
    </div>
  );
}

function PhotoChip({
  photo, selected, onSelect, onRemove, onRetry,
}: {
  photo: PhotoState;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  // Done but zero items — Gemini sometimes returns [] even on good shots.
  // Treat it like a recoverable failure so the worker can retry.
  const isZeroResult = photo.status === 'done' && photo.products.length === 0;

  const badge =
    photo.status === 'error' ? '!' :
    photo.status === 'detecting' ? '…' :
    photo.status === 'done' ? `${photo.products.length}` :
    '⏳';

  const badgeColor =
    photo.status === 'error' || isZeroResult ? '#c33' :
    photo.status === 'detecting' ? C.accent :
    photo.status === 'done' ? C.primary :
    C.textMuted;

  // The chip itself is the tap target for filtering. The small × button
  // sits on top and stops propagation so removing doesn't also try to filter.
  const handleChipTap = () => {
    if (photo.status === 'done') onSelect(photo.id);
  };

  return (
    <button
      type="button"
      onClick={handleChipTap}
      style={{
        position: 'relative', flexShrink: 0,
        width: 76, height: 76,
        background: 'transparent', padding: 0,
        border: selected ? `2.5px solid ${C.primary}` : '2.5px solid transparent',
        borderRadius: 13,
        cursor: photo.status === 'done' ? 'pointer' : 'default',
        boxShadow: selected ? `0 4px 12px ${C.primary}44` : 'none',
        transition: 'border-color .15s, box-shadow .15s',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.previewUrl}
        alt=""
        style={{
          width: '100%', height: '100%', objectFit: 'cover',
          borderRadius: 9, border: `1px solid ${C.border}`,
          opacity: photo.status === 'error' ? 0.5 : 1,
          display: 'block',
        }}
      />
      {photo.status === 'detecting' && (
        <div style={{
          position: 'absolute', left: 5, right: 5, bottom: 5,
          height: 4, borderRadius: 2,
          background: 'rgba(255,255,255,0.65)', overflow: 'hidden',
          pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', top: 0, bottom: 0, left: 0, width: '45%',
            background: C.accent, borderRadius: 2,
            animation: 'indeterminate 1.1s ease-in-out infinite',
          }} />
        </div>
      )}
      <div style={{
        position: 'absolute', top: 4, left: 4,
        minWidth: 22, height: 22, padding: '0 5px',
        background: badgeColor, color: C.text,
        borderRadius: 999,
        fontSize: 11, fontWeight: 800,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        {badge}
      </div>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          if (photo.status === 'error' || isZeroResult) onRetry(photo.id);
          else onRemove(photo.id);
        }}
        style={{
          position: 'absolute', top: 2, right: 2,
          width: 22, height: 22,
          background: 'rgba(255,255,255,0.92)', border: `1px solid ${C.border}`,
          borderRadius: '50%', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: 0,
        }}
        aria-label={(photo.status === 'error' || isZeroResult) ? 'Retry' : 'Remove photo'}
      >
        <Icon name={(photo.status === 'error' || isZeroResult) ? 'search' : 'x'} size={11} style={{ color: C.text }} />
      </span>
    </button>
  );
}

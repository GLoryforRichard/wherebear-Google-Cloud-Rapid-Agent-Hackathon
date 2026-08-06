'use client';

/**
 * Detection-box debug page, mirroring whataisle's /admin/vision-test so the
 * two pipelines can be compared side by side on the same photo (Gemini here
 * vs Qwen there). Calls the EXISTING /api/vision intake endpoint unchanged.
 *
 * Caveat shown on-page: /api/vision returns post-dedupe products (one box
 * per unique product name), so the stage-1 raw box count is not visible
 * here — box GEOMETRY (merge quality, coverage, flavor splits) is what to
 * compare.
 */

import { useEffect, useState } from 'react';

interface DetectedProduct {
  name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** [y_min, x_min, y_max, x_max] normalized 0–1000 (rotated image space). */
  box_2d?: [number, number, number, number];
  thumbnail?: string;
}

interface VisionResponse {
  ok: boolean;
  count?: number;
  products?: DetectedProduct[];
  usage?: {
    geminiInputTokens?: number;
    geminiOutputTokens?: number;
    geminiImages?: number;
  };
  error?: string;
}

const CONF_COLORS: Record<string, { bg: string; fg: string }> = {
  high: { bg: '#d1fae5', fg: '#047857' },
  medium: { bg: '#fef3c7', fg: '#b45309' },
  low: { bg: '#fee2e2', fg: '#b91c1c' },
};

function confChip(confidence?: string) {
  const c = CONF_COLORS[confidence ?? ''] ?? { bg: '#f4f4f5', fg: '#52525b' };
  return {
    background: c.bg,
    color: c.fg,
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 600 as const,
  };
}

function boxStyle(box: [number, number, number, number]): React.CSSProperties {
  const [y0, x0, y1, x1] = box;
  return {
    position: 'absolute',
    top: `${y0 / 10}%`,
    left: `${x0 / 10}%`,
    width: `${(x1 - x0) / 10}%`,
    height: `${(y1 - y0) / 10}%`,
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ background: '#f4f4f5', borderRadius: 4, padding: '3px 8px', fontSize: 12 }}>
      <span style={{ color: '#71717a' }}>{label} </span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </span>
  );
}

export default function VisionTestPage() {
  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [aisle, setAisle] = useState('');
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [totalMs, setTotalMs] = useState<number | null>(null);
  const [result, setResult] = useState<VisionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  // Object URL for the overlay base image. The browser applies EXIF
  // orientation to <img> by default, matching the server's sharp .rotate()
  // coordinate space — same assumption SnapScreen's canvas fallback makes.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(id);
  }, [running]);

  const run = async () => {
    if (!file) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setTotalMs(null);
    setHovered(null);
    const started = Date.now();
    try {
      const fd = new FormData();
      fd.append('image', file);
      if (aisle.trim()) fd.append('aisle', aisle.trim());
      const res = await fetch('/api/vision', { method: 'POST', body: fd });
      const data: VisionResponse = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setResult(data);
      setTotalMs(Date.now() - started);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const products = result?.products ?? [];
  const boxed = products
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: DetectedProduct & { box_2d: [number, number, number, number] }; i: number } =>
      Array.isArray(x.p.box_2d) && x.p.box_2d.length === 4
    );

  return (
    <div style={{ padding: '20px 16px 60px', background: '#fff', color: '#111', minHeight: '100vh', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <a href="/" style={{ color: '#06f', textDecoration: 'underline', fontSize: 14 }}>← home</a>
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Vision Test (Gemini)</h1>
      <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
        Runs the real /api/vision two-stage pipeline (Gemini stage-1 detect → sharp crop → stage-2
        identify → dedupe). Boxes below are POST-dedupe: one per unique product name — compare box
        geometry (merge quality / coverage / flavor splits), not raw stage-1 counts.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          type="file"
          accept="image/*"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: 13 }}
        />
        <input
          type="text"
          placeholder="Aisle hint (optional)"
          value={aisle}
          onChange={e => setAisle(e.target.value)}
          style={{ border: '1px solid #ccc', borderRadius: 4, padding: '5px 8px', fontSize: 13 }}
        />
        <button
          onClick={run}
          disabled={running || !file}
          style={{
            border: '1px solid #111', background: running || !file ? '#e5e5e5' : '#111',
            color: running || !file ? '#888' : '#fff', padding: '6px 14px', fontSize: 13,
            fontWeight: 600, cursor: running || !file ? 'default' : 'pointer', borderRadius: 4,
          }}
        >
          {running ? `${(elapsedMs / 1000).toFixed(1)}s…` : 'Run pipeline'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 6, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>
          Run failed: {error}
        </div>
      )}

      {result && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          <Stat label="products (post-dedupe)" value={String(result.count ?? products.length)} />
          <Stat label="with box" value={String(boxed.length)} />
          <Stat label="total" value={totalMs !== null ? `${(totalMs / 1000).toFixed(1)}s` : '—'} />
          <Stat
            label="tokens in/out"
            value={`${result.usage?.geminiInputTokens ?? '—'}/${result.usage?.geminiOutputTokens ?? '—'}`}
          />
          <Stat label="images" value={String(result.usage?.geminiImages ?? '—')} />
        </div>
      )}

      {imgUrl && result && (
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 8px' }}>Detection overlay</h2>
          <div style={{ position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgUrl} alt="uploaded shelf" style={{ width: '100%', display: 'block' }} />
            {boxed.map(({ p, i }) => (
              <div
                key={i}
                style={{
                  ...boxStyle(p.box_2d),
                  border: '2px solid #10b981',
                  background: hovered === i ? 'rgba(16,185,129,0.2)' : 'transparent',
                  zIndex: hovered === i ? 10 : 1,
                }}
              >
                <span style={{
                  position: 'absolute', top: 0, left: 0, background: '#10b981', color: '#fff',
                  fontSize: 10, fontFamily: 'ui-monospace, Menlo, monospace', padding: '0 3px', lineHeight: '14px',
                }}>
                  {i}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#71717a', marginTop: 6 }}>
            ▢ green = deduped product box (numbered, matches cards below)
          </div>
        </div>
      )}

      {products.length > 0 && (
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 8px' }}>Products ({products.length})</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
            {products.map((p, i) => (
              <div
                key={i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  border: hovered === i ? '2px solid #10b981' : '1px solid #e4e4e7',
                  borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 5,
                }}
              >
                <span style={{ fontSize: 11, color: '#71717a', fontFamily: 'ui-monospace, Menlo, monospace' }}>#{i}</span>
                {p.thumbnail ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={p.thumbnail} alt={p.name} style={{ width: '100%', borderRadius: 4, background: '#f4f4f5', objectFit: 'contain' }} />
                ) : (
                  <div style={{ width: '100%', height: 60, borderRadius: 4, background: '#f4f4f5' }} />
                )}
                <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25 }}>{p.name}</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  {p.category && (
                    <span style={{ background: '#f4f4f5', color: '#52525b', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>
                      {p.category}
                    </span>
                  )}
                  <span style={confChip(p.confidence)}>{p.confidence ?? '—'}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

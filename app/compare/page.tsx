'use client';

/**
 * /compare — run THREE scanning paradigms over the same shelf photo and lay
 * the results side by side: detection overlays, product lists, cost & wall
 * time. Each paradigm is one POST to /api/compare (parallel), so columns
 * fill in independently and one failure never blanks the page.
 *
 *  A wherebear            — two-stage pipeline · Vertex AI · gemini-3.6-flash
 *  B whataisle-openrouter — whataisle final pipeline · OpenRouter · gemini-3.6-flash
 *  C whataisle-vertex     — whataisle pipeline · Vertex AI (free trial) · gemini-3.6-flash
 */

import { useEffect, useRef, useState } from 'react';

type Paradigm = 'wherebear' | 'whataisle-openrouter' | 'whataisle-vertex';

interface CompareProduct {
  name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  box_2d?: [number, number, number, number];
  boxes_2d?: [number, number, number, number][];
  count?: number;
  thumbnail?: string;
}

function productBoxes(p: CompareProduct): [number, number, number, number][] {
  if (Array.isArray(p.boxes_2d) && p.boxes_2d.length > 0) return p.boxes_2d;
  return Array.isArray(p.box_2d) && p.box_2d.length === 4 ? [p.box_2d] : [];
}

interface CompareRunResult {
  ok: boolean;
  paradigm: Paradigm;
  model: string;
  provider: string;
  products: CompareProduct[];
  count: number;
  elapsedMs: number;
  usage: { inputTokens: number; outputTokens: number; calls: number; images: number };
  costUSD: number | null;
  costBasis: 'openrouter-actual' | 'list-price-estimate';
  /** Server-rendered JPEG preview (HEIC-safe, upright) for the overlay. */
  previewImage?: string;
  error?: string;
}

const PARADIGMS: {
  key: Paradigm;
  label: string;
  sub: string;
  color: string;
  colorSoft: string;
}[] = [
  {
    key: 'wherebear',
    label: 'A · WhereBear pipeline',
    sub: 'two-stage detect→crop→identify · Vertex AI',
    color: '#10b981',
    colorSoft: 'rgba(16,185,129,0.12)',
  },
  {
    key: 'whataisle-openrouter',
    label: 'B · WhatAisle via OpenRouter',
    sub: 'whataisle final pipeline · OpenRouter',
    color: '#8b5cf6',
    colorSoft: 'rgba(139,92,246,0.12)',
  },
  {
    key: 'whataisle-vertex',
    label: 'C · WhatAisle via Google Cloud',
    sub: 'whataisle pipeline · Vertex AI free trial',
    color: '#3b82f6',
    colorSoft: 'rgba(59,130,246,0.12)',
  },
];

const CONF_COLORS: Record<string, { bg: string; fg: string }> = {
  high: { bg: '#d1fae5', fg: '#047857' },
  medium: { bg: '#fef3c7', fg: '#b45309' },
  low: { bg: '#fee2e2', fg: '#b91c1c' },
};

type Slot =
  | { state: 'idle' }
  | { state: 'running'; startedAt: number }
  | { state: 'done'; result: CompareRunResult; clientMs: number }
  | { state: 'error'; message: string; clientMs: number };

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number | null): string {
  if (usd === null) return '—';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
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

function StatChip({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span
      style={{
        background: strong ? '#111' : '#f4f4f5',
        color: strong ? '#fff' : undefined,
        borderRadius: 4,
        padding: '3px 8px',
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: strong ? '#d4d4d8' : '#71717a' }}>{label} </span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </span>
  );
}

function RunningTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(now - startedAt)}</span>;
}

export default function ComparePage() {
  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [slots, setSlots] = useState<Record<Paradigm, Slot>>({
    wherebear: { state: 'idle' },
    'whataisle-openrouter': { state: 'idle' },
    'whataisle-vertex': { state: 'idle' },
  });
  const [hovered, setHovered] = useState<{ paradigm: Paradigm; index: number } | null>(null);
  const runIdRef = useRef(0);

  // Browser applies EXIF orientation to <img>, matching the server's upright
  // (sharp .rotate()) coordinate space — same assumption as /vision-test.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const anyRunning = Object.values(slots).some(s => s.state === 'running');

  const run = async () => {
    if (!file || anyRunning) return;
    const runId = ++runIdRef.current;
    const startedAt = Date.now();
    setHovered(null);
    setSlots({
      wherebear: { state: 'running', startedAt },
      'whataisle-openrouter': { state: 'running', startedAt },
      'whataisle-vertex': { state: 'running', startedAt },
    });

    PARADIGMS.forEach(({ key }) => {
      (async () => {
        const t0 = Date.now();
        try {
          const fd = new FormData();
          fd.append('image', file);
          fd.append('paradigm', key);
          const res = await fetch('/api/compare', { method: 'POST', body: fd });
          const data: CompareRunResult = await res.json();
          if (runIdRef.current !== runId) return; // stale run
          if (!res.ok || !data.ok) {
            setSlots(s => ({
              ...s,
              [key]: { state: 'error', message: data.error || `HTTP ${res.status}`, clientMs: Date.now() - t0 },
            }));
            return;
          }
          setSlots(s => ({ ...s, [key]: { state: 'done', result: data, clientMs: Date.now() - t0 } }));
        } catch (e) {
          if (runIdRef.current !== runId) return;
          setSlots(s => ({
            ...s,
            [key]: {
              state: 'error',
              message: e instanceof Error ? e.message : String(e),
              clientMs: Date.now() - t0,
            },
          }));
        }
      })();
    });
  };

  const doneResults = PARADIGMS.map(p => {
    const s = slots[p.key];
    return s.state === 'done' ? { meta: p, result: s.result } : null;
  }).filter((x): x is { meta: (typeof PARADIGMS)[number]; result: CompareRunResult } => !!x);

  const bestTime = doneResults.length
    ? Math.min(...doneResults.map(r => r.result.elapsedMs))
    : null;
  const costs = doneResults.filter(r => r.result.costUSD !== null);
  const bestCost = costs.length ? Math.min(...costs.map(r => r.result.costUSD as number)) : null;

  return (
    <div style={{ padding: '20px 16px 60px', background: '#fff', color: '#111', minHeight: '100vh', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <a href="/" style={{ color: '#06f', textDecoration: 'underline', fontSize: 14 }}>← home</a>
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Scan Paradigm Comparison</h1>
      <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px', maxWidth: 900 }}>
        Upload one shelf photo — it runs through three scanning paradigms in parallel, all on{' '}
        <b>gemini-3.6-flash</b>: <b style={{ color: '#10b981' }}>A</b>{' '}WhereBear&apos;s two-stage
        pipeline (Vertex AI), <b style={{ color: '#8b5cf6' }}>B</b>{' '}WhatAisle&apos;s final pipeline
        via OpenRouter, and <b style={{ color: '#3b82f6' }}>C</b>{' '}the same WhatAisle pipeline on
        Google Cloud (free-trial credits). Compare cost, wall time, detected products, and box
        overlays side by side.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          type="file"
          accept="image/*"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: 13 }}
        />
        <button
          onClick={run}
          disabled={anyRunning || !file}
          style={{
            border: '1px solid #111',
            background: anyRunning || !file ? '#e5e5e5' : '#111',
            color: anyRunning || !file ? '#888' : '#fff',
            padding: '6px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: anyRunning || !file ? 'default' : 'pointer',
            borderRadius: 4,
          }}
        >
          {anyRunning ? 'Running…' : 'Run all 3 paradigms'}
        </button>
      </div>

      {/* Summary table once at least one result is in */}
      {doneResults.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 680 }}>
            <thead>
              <tr>
                {['Paradigm', 'Provider', 'Products', 'Wall time', 'Cost (USD)', 'Tokens in / out', 'API calls', 'Images sent'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 12px', borderBottom: '2px solid #e4e4e7', color: '#71717a', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PARADIGMS.map(p => {
                const s = slots[p.key];
                if (s.state !== 'done') {
                  return (
                    <tr key={p.key}>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', fontWeight: 600, color: p.color }}>{p.label}</td>
                      <td colSpan={7} style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', color: '#a1a1aa' }}>
                        {s.state === 'running' ? 'running…' : s.state === 'error' ? `failed: ${s.message}` : '—'}
                      </td>
                    </tr>
                  );
                }
                const r = s.result;
                return (
                  <tr key={p.key}>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', fontWeight: 600, color: p.color }}>{p.label}</td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5' }}>{r.provider}</td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', fontWeight: 700 }}>{r.count}</td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', fontWeight: r.elapsedMs === bestTime ? 700 : 400, background: r.elapsedMs === bestTime ? '#f0fdf4' : undefined }}>
                      {fmtMs(r.elapsedMs)}
                    </td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', fontWeight: r.costUSD !== null && r.costUSD === bestCost ? 700 : 400, background: r.costUSD !== null && r.costUSD === bestCost ? '#f0fdf4' : undefined }}>
                      {fmtCost(r.costUSD)}
                      <span style={{ color: '#a1a1aa', fontSize: 11 }}>
                        {' '}{r.costBasis === 'openrouter-actual' ? '(actual)' : '(est.)'}
                      </span>
                    </td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5', fontVariantNumeric: 'tabular-nums' }}>
                      {r.usage.inputTokens.toLocaleString()} / {r.usage.outputTokens.toLocaleString()}
                    </td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5' }}>{r.usage.calls}</td>
                    <td style={{ padding: '7px 12px', borderBottom: '1px solid #f4f4f5' }}>{r.usage.images}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Three columns */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {PARADIGMS.map(p => {
          const s = slots[p.key];
          return (
            <div key={p.key} style={{ border: `1px solid #e4e4e7`, borderTop: `3px solid ${p.color}`, borderRadius: 10, padding: 12, minWidth: 0 }}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: p.color }}>{p.label}</div>
                <div style={{ fontSize: 11, color: '#71717a' }}>{p.sub} · gemini-3.6-flash</div>
              </div>

              {s.state === 'idle' && (
                <div style={{ background: '#fafafa', borderRadius: 8, padding: '28px 12px', textAlign: 'center', color: '#a1a1aa', fontSize: 13 }}>
                  Waiting for a photo
                </div>
              )}

              {s.state === 'running' && (
                <div style={{ background: p.colorSoft, borderRadius: 8, padding: '28px 12px', textAlign: 'center', color: p.color, fontSize: 14, fontWeight: 600 }}>
                  Scanning… <RunningTimer startedAt={s.startedAt} />
                </div>
              )}

              {s.state === 'error' && (
                <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 8, padding: '12px', fontSize: 13 }}>
                  <b>Failed after {fmtMs(s.clientMs)}:</b> {s.message}
                </div>
              )}

              {s.state === 'done' && (
                <>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
                    <StatChip label="products" value={String(s.result.count)} strong />
                    <StatChip label="time" value={fmtMs(s.result.elapsedMs)} />
                    <StatChip
                      label="cost"
                      value={`${fmtCost(s.result.costUSD)}${s.result.costBasis === 'openrouter-actual' ? '' : ' est.'}`}
                    />
                    <StatChip
                      label="tok in/out"
                      value={`${s.result.usage.inputTokens.toLocaleString()}/${s.result.usage.outputTokens.toLocaleString()}`}
                    />
                  </div>

                  {(s.result.previewImage || imgUrl) && (
                    <div style={{ position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden', marginBottom: 10 }}>
                      {/* Server preview first: iPhone HEIC uploads can't be
                          rendered by the browser's own object URL. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.result.previewImage ?? imgUrl ?? undefined} alt="uploaded shelf" style={{ width: '100%', display: 'block' }} />
                      {s.result.products.flatMap((prod, i) =>
                        productBoxes(prod).map((box, j) => (
                          <div
                            key={`${i}-${j}`}
                            style={{
                              ...boxStyle(box),
                              border: `2px solid ${p.color}`,
                              background:
                                hovered?.paradigm === p.key && hovered.index === i
                                  ? p.colorSoft.replace('0.12', '0.35')
                                  : 'transparent',
                              zIndex: hovered?.paradigm === p.key && hovered.index === i ? 10 : 1,
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: 0, left: 0, background: p.color, color: '#fff',
                              fontSize: 10, fontFamily: 'ui-monospace, Menlo, monospace', padding: '0 3px', lineHeight: '14px',
                            }}>
                              {i}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                    {s.result.products.map((prod, i) => {
                      const conf = CONF_COLORS[prod.confidence ?? ''] ?? { bg: '#f4f4f5', fg: '#52525b' };
                      const isHovered = hovered?.paradigm === p.key && hovered.index === i;
                      return (
                        <div
                          key={i}
                          onMouseEnter={() => setHovered({ paradigm: p.key, index: i })}
                          onMouseLeave={() => setHovered(null)}
                          style={{
                            display: 'flex', gap: 8, alignItems: 'center', padding: 6,
                            border: isHovered ? `2px solid ${p.color}` : '1px solid #f0f0f1',
                            borderRadius: 8,
                          }}
                        >
                          <span style={{ fontSize: 10, color: '#a1a1aa', fontFamily: 'ui-monospace, Menlo, monospace', minWidth: 16 }}>#{i}</span>
                          {prod.thumbnail && (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={prod.thumbnail} alt={prod.name} style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 4, background: '#f4f4f5', flexShrink: 0 }} />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.25 }}>{prod.name}</div>
                            <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
                              {prod.category && (
                                <span style={{ background: '#f4f4f5', color: '#52525b', borderRadius: 4, padding: '0 5px', fontSize: 10 }}>{prod.category}</span>
                              )}
                              {prod.confidence && (
                                <span style={{ background: conf.bg, color: conf.fg, borderRadius: 4, padding: '0 5px', fontSize: 10, fontWeight: 600 }}>
                                  {prod.confidence}
                                </span>
                              )}
                              {typeof prod.count === 'number' && prod.count > 1 && (
                                <span style={{ background: p.colorSoft, color: p.color, borderRadius: 4, padding: '0 5px', fontSize: 10, fontWeight: 700 }}>
                                  ×{prod.count} spots
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {s.result.products.length === 0 && (
                      <div style={{ color: '#a1a1aa', fontSize: 13, padding: 8 }}>No products detected.</div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

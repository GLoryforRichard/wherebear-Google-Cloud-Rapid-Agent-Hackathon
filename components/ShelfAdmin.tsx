'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { SHELVES } from '@/lib/shelves';
import { C, FONT, SHADOW } from '@/lib/theme';
import Icon from './Icon';

interface AdminProduct {
  _id: string;
  canonical_name: string;
  aliases: string[];
  category?: string;
  latest_aisle: string;
  evidence_count: number;
  updated_at?: string;
  // Allow arbitrary extra fields (search_text, created_at, etc.) so the
  // raw-JSON drilldown can show everything the API actually returns.
  [key: string]: unknown;
}

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
};

export default function ShelfAdmin({ onBack }: { onBack: () => void }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [items, setItems] = useState<AdminProduct[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminProduct | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadCounts = useCallback(() => {
    fetch('/api/admin/products')
      .then(r => r.json())
      .then(d => { if (d.ok) setCounts(d.counts); });
  }, []);

  const loadShelf = useCallback((code: string) => {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/products?aisle=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) setError(d.error || 'load failed');
        else setItems(d.products);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => {
    if (active) loadShelf(active);
    else setItems(null);
  }, [active, loadShelf]);

  // ── Demo isolation ─────────────────────────────────────────────────────
  // This deployment is public (hackathon judging) while the database serves a
  // REAL store, so write actions below mutate ONLY this screen's local state.
  // The server-side write endpoints are independently locked too (403) — see
  // lib/admin-guard.ts. After a few interactions we tell the visitor what's
  // going on so the sandbox doesn't read as a bug.
  const demoOps = useRef(0);
  const [showDemoNote, setShowDemoNote] = useState(false);
  const bumpDemo = () => {
    demoOps.current += 1;
    if (demoOps.current === 3) setShowDemoNote(true);
  };

  const onDelete = (p: AdminProduct) => {
    if (!confirm(`Delete "${p.canonical_name}"?`)) return;
    setItems(prev => (prev ? prev.filter(x => x._id !== p._id) : prev));
    if (active) {
      setCounts(prev => prev ? { ...prev, [active]: Math.max(0, (prev[active] ?? 1) - 1) } : prev);
    }
    bumpDemo();
  };

  const onClearShelf = (code: string, currentCount: number) => {
    if (currentCount === 0) return;
    const ok = confirm(
      `Delete all ${currentCount} product${currentCount === 1 ? '' : 's'} on shelf ${code}?`
    );
    if (!ok) return;
    if (active === code) {
      setItems([]);
      setExpandedId(null);
    }
    setCounts(prev => prev ? { ...prev, [code]: 0 } : prev);
    bumpDemo();
  };

  const onSave = (patch: Partial<AdminProduct>) => {
    if (!editing) return;
    const isNew = !editing._id;
    if (isNew) {
      const aisle = (patch.latest_aisle || active || '').trim();
      const fresh: AdminProduct = {
        _id: `demo-${demoOps.current}-${(patch.canonical_name || 'x').length}`,
        canonical_name: patch.canonical_name || 'Untitled product',
        aliases: patch.aliases ?? [],
        category: patch.category,
        latest_aisle: aisle,
        evidence_count: 1,
      };
      if (active === aisle) setItems(prev => (prev ? [fresh, ...prev] : [fresh]));
      setCounts(prev => prev ? { ...prev, [aisle]: (prev[aisle] ?? 0) + 1 } : prev);
    } else {
      setItems(prev => prev
        ? prev.map(x => (x._id === editing._id ? { ...x, ...patch } : x))
        : prev);
    }
    setEditing(null);
    bumpDemo();
  };

  return (
    <div style={{ minHeight: '100dvh', background: C.bg, color: C.text, fontFamily: FONT, padding: '62px 20px 80px' }}>
      <button onClick={onBack} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: C.textMuted, fontFamily: FONT, fontSize: 15, fontWeight: 600,
        padding: '4px 10px 4px 0', marginBottom: 4, marginLeft: -2,
      }}>
        <Icon name="back" size={20} /> Workspace
      </button>
      <div style={{ paddingTop: 4, marginBottom: 18 }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: -0.8 }}>Shelf admin</h1>
        <p style={{ color: C.textMuted, fontSize: 15, margin: '6px 0 0', fontWeight: 500 }}>
          Tap a shelf to view or edit its products.
        </p>
      </div>

      {/* Shelf grid — hidden once you drill into a shelf */}
      {!active && (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 10,
        marginBottom: 20,
      }}>
        {SHELVES.map(s => {
          const c = counts?.[s.code] ?? 0;
          return (
            <div
              key={s.code}
              onClick={() => setActive(s.code)}
              style={{
                position: 'relative',
                padding: '10px 12px',
                background: c > 0 ? C.primarySofter : C.white,
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 12,
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: 1.3,
                boxShadow: SHADOW,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ ...mono, fontWeight: 800, fontSize: 13.5 }}>{s.code}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    ...mono, fontSize: 11, fontWeight: 700,
                    background: c > 0 ? C.primary : C.bgMuted,
                    color: c > 0 ? '#fff' : C.textMuted,
                    padding: '1px 7px', borderRadius: 999,
                  }}>{c}</span>
                  {c > 0 && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        onClearShelf(s.code, c);
                      }}
                      title={`Delete all ${c} products on ${s.code}`}
                      aria-label={`Delete all ${c} products on ${s.code}`}
                      style={{
                        background: 'transparent',
                        border: '1px solid #e5484d',
                        color: '#e5484d',
                        borderRadius: 6,
                        padding: '1px 7px',
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: 'pointer',
                        lineHeight: 1.2,
                        fontFamily: FONT,
                      }}
                    >
                      clear
                    </button>
                  )}
                </div>
              </div>
              <div style={{
                fontSize: 11, color: C.textMuted, marginTop: 3,
                overflow: 'hidden', textOverflow: 'ellipsis',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              }}>{s.description}</div>
            </div>
          );
        })}
      </div>
      )}

      {active && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', flexWrap: 'wrap' }}>
            <button
              onClick={() => setActive(null)}
              style={{
                background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
                padding: '6px 13px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                fontFamily: FONT, color: C.text,
              }}
            >← shelves</button>
            <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, flex: 1 }}>
              <span style={mono}>{active}</span> · {items?.length ?? 0} products
            </h2>
            <button
              onClick={() => setEditing({ _id: '', canonical_name: '', aliases: [], category: '', latest_aisle: active, evidence_count: 1 } as AdminProduct)}
              style={{
                background: C.primary, color: C.text, border: `2px solid ${C.border}`, borderRadius: 10,
                padding: '6px 13px', fontSize: 13, fontWeight: 800, cursor: 'pointer',
                fontFamily: FONT, boxShadow: SHADOW,
              }}
            >+ add</button>
            <button
              onClick={() => loadShelf(active)}
              style={{
                background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 10,
                padding: '6px 11px', fontSize: 12, cursor: 'pointer',
                fontFamily: FONT, color: C.textMuted, fontWeight: 600,
              }}
            >refresh</button>
          </div>
          {loading && <div style={{ color: C.textMuted, fontSize: 14 }}>Loading…</div>}
          {error && <pre style={{ ...mono, color: '#e5484d' }}>{error}</pre>}
          {items && items.length === 0 && !loading && (
            <div style={{ color: C.textMuted, padding: 24, textAlign: 'center', background: C.bgMuted, borderRadius: 14, fontSize: 14 }}>
              No products on this shelf yet.
            </div>
          )}
          {items && items.length > 0 && (
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', boxShadow: SHADOW }}>
              {items.map((p, i) => {
                const isOpen = expandedId === p._id;
                return (
                  <div key={p._id} style={{ borderTop: i ? `1px solid ${C.border}` : 'none' }}>
                    <div
                      onClick={() => setExpandedId(isOpen ? null : p._id)}
                      style={{
                        display: 'flex', gap: 10, alignItems: 'flex-start',
                        padding: '11px 13px', cursor: 'pointer',
                        background: isOpen ? C.primarySofter : 'transparent',
                      }}
                    >
                      <span style={{
                        color: C.textSoft, fontSize: 11, marginTop: 4, flexShrink: 0, width: 12,
                      }}>{isOpen ? '▾' : '▸'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text }}>{p.canonical_name}</div>
                        <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
                          {[p.category, `seen ${p.evidence_count}×`].filter(Boolean).join(' · ')}
                        </div>
                        {p.aliases && p.aliases.length > 1 && (
                          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {p.aliases
                              .filter(a => a !== p.canonical_name)
                              .slice(0, 8)
                              .map(a => (
                                <span key={a} style={{
                                  fontSize: 10, padding: '1px 7px', borderRadius: 999,
                                  background: C.bgMuted, color: C.textMuted, ...mono,
                                }}>{a}</span>
                              ))}
                          </div>
                        )}
                      </div>
                      <div
                        onClick={e => e.stopPropagation()}
                        style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}
                      >
                        <button onClick={() => setEditing(p)} style={{
                          background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
                          padding: '3px 10px', fontSize: 11.5, cursor: 'pointer',
                          fontFamily: FONT, fontWeight: 600, color: C.text,
                        }}>edit</button>
                        <button onClick={() => onDelete(p)} style={{
                          background: C.white, border: '1px solid #e5484d', borderRadius: 8,
                          color: '#e5484d', padding: '3px 10px', fontSize: 11.5, cursor: 'pointer',
                          fontFamily: FONT, fontWeight: 600,
                        }}>delete</button>
                      </div>
                    </div>
                    {isOpen && <ProductDetail product={p} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {editing && (
        <EditModal
          product={editing}
          onCancel={() => setEditing(null)}
          onSave={onSave}
        />
      )}

      {/* Sandbox notice — shown after the 3rd write interaction. */}
      {showDemoNote && (
        <div
          onClick={() => setShowDemoNote(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(20,12,6,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 22, zIndex: 200, animation: 'fade .2s ease',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: C.bg, border: `2px solid ${C.border}`, borderRadius: 18,
              boxShadow: '6px 6px 0 #111111', padding: '20px 20px 16px',
              maxWidth: 380, fontFamily: FONT,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>
              🔒 Demo sandbox
            </div>
            <p style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.55, margin: '10px 0 0', fontWeight: 500 }}>
              This deployment serves a <b style={{ color: C.primaryDark }}>real store</b>, so the
              edit / delete / add buttons here are isolated from the live database — your changes
              only affect what you see on this screen and reset on reload. Everything else
              (search, shelf snap, browsing) is fully live.
            </p>
            <button
              onClick={() => setShowDemoNote(false)}
              style={{
                width: '100%', marginTop: 16, padding: '11px 0',
                background: C.primary, color: C.text, border: `2px solid ${C.border}`,
                borderRadius: 12, fontFamily: FONT, fontSize: 14.5, fontWeight: 800,
                cursor: 'pointer', boxShadow: '3px 3px 0 #111111',
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EditModal({
  product,
  onCancel,
  onSave,
}: {
  product: AdminProduct;
  onCancel: () => void;
  onSave: (patch: Partial<AdminProduct>) => void;
}) {
  const [name, setName] = useState(product.canonical_name);
  const [aliasesText, setAliasesText] = useState(
    product.aliases.filter(a => a !== product.canonical_name).join('\n')
  );
  const [category, setCategory] = useState(product.category ?? '');
  const [aisle, setAisle] = useState(product.latest_aisle);

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 14, zIndex: 100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.bg, borderRadius: 18, padding: 18,
          width: '100%', maxWidth: 480, boxShadow: '0 16px 40px rgba(0,0,0,0.25)',
          fontFamily: FONT, border: `2px solid ${C.border}`,
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>
          {product._id ? 'Edit product' : 'Add product'}
        </h3>
        <Field label="canonical_name">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={fieldStyle}
          />
        </Field>
        <Field label="aliases (one per line)">
          <textarea
            value={aliasesText}
            onChange={e => setAliasesText(e.target.value)}
            rows={5}
            style={{ ...fieldStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>
        <Field label="category">
          <input
            value={category}
            onChange={e => setCategory(e.target.value)}
            style={fieldStyle}
            placeholder="e.g. noodle, sauce, snack"
          />
        </Field>
        <Field label="latest_aisle">
          <select
            value={aisle}
            onChange={e => setAisle(e.target.value)}
            style={fieldStyle}
          >
            {SHELVES.map(s => (
              <option key={s.code} value={s.code}>
                {s.code} — {s.description}
              </option>
            ))}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onCancel} style={btnSecondary}>Cancel</button>
          <button
            onClick={() => onSave({
              canonical_name: name,
              aliases: aliasesText.split('\n').map(s => s.trim()).filter(Boolean),
              category: category.trim() || undefined,
              latest_aisle: aisle,
            })}
            style={btnPrimary}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

function ProductDetail({ product }: { product: AdminProduct }) {
  // Show every field the DB document actually has, in a labeled list.
  // Special-case timestamps (human-friendly) and arrays (one per line).
  const SKIP = new Set<string>(['_id']); // shown separately
  const order = [
    'canonical_name', 'latest_aisle', 'category', 'evidence_count',
    'aliases', 'search_text', 'created_at', 'updated_at',
  ];
  const known = order.filter(k => k in product);
  const extra = Object.keys(product).filter(k => !SKIP.has(k) && !order.includes(k));
  const keys = [...known, ...extra];

  return (
    <div style={{
      background: '#0f1115', color: '#dce0e8',
      padding: '12px 14px 14px',
      ...mono, fontSize: 12, lineHeight: 1.55,
    }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 6, opacity: 0.8 }}>
        <span style={{ color: '#7d92b3', minWidth: 110 }}>_id</span>
        <span style={{ flex: 1, wordBreak: 'break-all' }}>{product._id}</span>
      </div>
      {keys.map(k => (
        <div key={k} style={{ display: 'flex', gap: 10, marginBottom: 4 }}>
          <span style={{ color: '#7d92b3', minWidth: 110, flexShrink: 0 }}>{k}</span>
          <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
            {renderValue(k, product[k])}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderValue(key: string, v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span style={{ opacity: 0.5 }}>—</span>;
  if (key === 'created_at' || key === 'updated_at') {
    const d = parseDate(v);
    if (d) return `${d.toLocaleString()} (${relativeTime(d)})`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return <span style={{ opacity: 0.5 }}>[]</span>;
    return v.map((x, i) => (
      <span key={i} style={{
        display: 'inline-block',
        background: '#1d2330', color: '#cfd8e8',
        padding: '1px 7px', borderRadius: 4,
        margin: '0 4px 4px 0', fontSize: 11,
      }}>{typeof x === 'string' ? x : JSON.stringify(x)}</span>
    ));
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseDate(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'string') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'object' && raw && '$date' in raw) {
    const d = new Date(String((raw as { $date: string }).$date));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 700, ...mono }}>{label}</div>
      {children}
    </label>
  );
}

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', border: `1px solid ${C.border}`,
  borderRadius: 10, fontSize: 13.5, boxSizing: 'border-box',
  background: C.white, color: C.text, fontFamily: FONT,
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: C.text, border: `2px solid ${C.border}`,
  padding: '9px 18px', borderRadius: 12, fontSize: 13.5, fontWeight: 800, cursor: 'pointer',
  fontFamily: FONT, boxShadow: SHADOW,
};

const btnSecondary: React.CSSProperties = {
  background: C.white, color: C.textMuted, border: `1px solid ${C.border}`,
  padding: '9px 18px', borderRadius: 12, fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
  fontFamily: FONT,
};

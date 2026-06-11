'use client';

import { useEffect, useMemo, useState } from 'react';

interface DebugData {
  ok: boolean;
  db?: string;
  counts?: Record<string, number>;
  shelf_evidence?: Record<string, unknown>[];
  products?: Record<string, unknown>[];
  search_logs?: Record<string, unknown>[];
  error?: string;
}

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.45,
};

export default function DebugPage() {
  const [data, setData] = useState<DebugData | null>(null);
  const [loading, setLoading] = useState(false);
  const [ts, setTs] = useState<string>('');

  const load = () => {
    setLoading(true);
    fetch('/api/debug')
      .then(r => r.json())
      .then(d => {
        setData(d);
        setTs(new Date().toLocaleTimeString());
      })
      .catch(e => setData({ ok: false, error: String(e) }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div style={{ padding: '20px 16px 60px', background: '#fff', color: '#111', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <a href="/" style={{ color: '#06f', textDecoration: 'underline', fontSize: 14 }}>← home</a>
        <button onClick={load} disabled={loading} style={{
          marginLeft: 'auto', border: '1px solid #ccc', background: '#f5f5f5',
          padding: '4px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4,
        }}>{loading ? 'loading…' : 'refresh'}</button>
      </div>

      <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
        DB: {data?.db || '—'}
      </h1>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 14 }}>
        loaded at {ts || '—'} · tap any row to see full JSON
      </div>

      {!data && <div style={mono}>loading…</div>}
      {data && !data.ok && (
        <pre style={{ ...mono, color: '#c33', whiteSpace: 'pre-wrap' }}>
          ERROR: {data.error}
        </pre>
      )}

      {data?.ok && data.counts && (
        <>
          <Section
            name="shelf_evidence"
            count={data.counts.shelf_evidence}
            items={data.shelf_evidence ?? []}
            summarize={summarizeShelfEvidence}
            searchFields={['aisle']}
          />
          <Section
            name="products"
            count={data.counts.products}
            items={data.products ?? []}
            summarize={summarizeProduct}
            searchFields={['canonical_name', 'aliases', 'latest_aisle', 'category']}
          />
          <Section
            name="search_logs"
            count={data.counts.search_logs}
            items={data.search_logs ?? []}
            summarize={summarizeSearchLog}
            searchFields={['query', 'resolved_intent']}
          />
        </>
      )}
    </div>
  );
}

interface Summary {
  primary: string;
  secondary?: string;
  meta?: string;
}

type Summarizer = (item: Record<string, unknown>) => Summary;

function Section({
  name, count, items, summarize, searchFields,
}: {
  name: string;
  count: number;
  items: Record<string, unknown>[];
  summarize: Summarizer;
  searchFields: string[];
}) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it => {
      for (const f of searchFields) {
        const v = it[f];
        if (Array.isArray(v)) {
          if (v.some(x => typeof x === 'string' && x.toLowerCase().includes(q))) return true;
        } else if (typeof v === 'string' && v.toLowerCase().includes(q)) {
          return true;
        }
      }
      return false;
    });
  }, [items, filter, searchFields]);

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        borderBottom: '1px solid #ddd', paddingBottom: 4, marginBottom: 8,
        flexWrap: 'wrap',
      }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{name}</h2>
        <span style={{ fontSize: 12, color: '#666' }}>
          {count} total
          {count !== items.length && items.length > 0 ? ` · showing latest ${items.length}` : ''}
          {filter ? ` · ${filtered.length} match` : ''}
        </span>
      </div>

      {items.length > 6 && (
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder={`Filter ${name} (${searchFields.join(' / ')})`}
          style={{
            width: '100%', boxSizing: 'border-box',
            border: '1px solid #ccc', borderRadius: 6,
            padding: '7px 10px', fontSize: 13, marginBottom: 8,
            fontFamily: 'inherit',
          }}
        />
      )}

      {items.length === 0 ? (
        <div style={{ ...mono, color: '#999' }}>(empty)</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...mono, color: '#999' }}>(no matches)</div>
      ) : (
        <div style={{ border: '1px solid #eee', borderRadius: 6, overflow: 'hidden' }}>
          {filtered.map((it, i) => (
            <Row
              key={typeof it._id === 'string' ? it._id : i}
              item={it}
              summary={summarize(it)}
              divider={i > 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  item, summary, divider,
}: {
  item: Record<string, unknown>;
  summary: Summary;
  divider: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: divider ? '1px solid #eee' : 'none' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left',
          background: open ? '#f3f7ff' : '#fff',
          border: 'none', padding: '10px 12px',
          display: 'flex', alignItems: 'baseline', gap: 8,
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ color: '#999', fontSize: 11, width: 14, flexShrink: 0 }}>
          {open ? '▾' : '▸'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13.5, fontWeight: 600, color: '#111',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {summary.primary}
          </div>
          {summary.secondary && (
            <div style={{
              fontSize: 12, color: '#666', marginTop: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {summary.secondary}
            </div>
          )}
        </div>
        {summary.meta && (
          <span style={{ ...mono, color: '#888', fontSize: 11, flexShrink: 0 }}>
            {summary.meta}
          </span>
        )}
      </button>
      {open && (
        <pre style={{
          ...mono,
          background: '#0f1115', color: '#dce0e8',
          margin: 0, padding: 12,
          overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {JSON.stringify(item, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Summarizers — one per collection
// ─────────────────────────────────────────────────────────────

function summarizeShelfEvidence(it: Record<string, unknown>): Summary {
  const aisle = (it.aisle as string) || '—';
  const products = Array.isArray(it.products_detected) ? it.products_detected : [];
  const ts = formatTime(it.timestamp);
  return {
    primary: `${aisle} · ${products.length} products`,
    secondary: products.length ? products.slice(0, 5).join(', ') + (products.length > 5 ? '…' : '') : undefined,
    meta: ts,
  };
}

function summarizeProduct(it: Record<string, unknown>): Summary {
  const name = (it.canonical_name as string) || '—';
  const aisle = (it.latest_aisle as string) || '—';
  const evidence = typeof it.evidence_count === 'number' ? it.evidence_count : 0;
  const aliases = Array.isArray(it.aliases) ? it.aliases.filter((a): a is string => typeof a === 'string') : [];
  const zh = aliases.filter(a => /[一-鿿]/.test(a));
  return {
    primary: name,
    secondary: `${aisle} · ev=${evidence}${zh.length ? ` · ${zh.slice(0, 3).join(' / ')}` : ''}`,
    meta: formatTime(it.updated_at),
  };
}

function summarizeSearchLog(it: Record<string, unknown>): Summary {
  const query = (it.query as string) || '—';
  const found = typeof it.results_found === 'number' ? it.results_found : 0;
  const intent = (it.resolved_intent as string) || '';
  return {
    primary: query,
    secondary: `${found} results${intent ? ` · ${intent}` : ''}`,
    meta: formatTime(it.timestamp),
  };
}

function formatTime(raw: unknown): string {
  if (!raw) return '';
  let d: Date | null = null;
  if (typeof raw === 'string') d = new Date(raw);
  else if (raw && typeof raw === 'object' && '$date' in (raw as Record<string, unknown>)) {
    d = new Date(String((raw as { $date: string }).$date));
  } else if (raw instanceof Date) d = raw;
  if (!d || isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import { C, FONT } from '@/lib/theme';

type OpType = 'snap' | 'voice' | 'identify' | 'search' | 'save';

interface DailyOpStat {
  date: string;
  type: OpType;
  count: number;
}

const TYPE_META: Record<OpType, { label: string; emoji: string; color: string }> = {
  snap:     { label: 'Shelf scans',    emoji: '📷', color: '#3f7d3a' },
  save:     { label: 'Memory saves',   emoji: '💾', color: '#6b7280' },
  search:   { label: 'Text searches',  emoji: '⌨️', color: '#2563eb' },
  voice:    { label: 'Voice searches', emoji: '🎤', color: '#c0392b' },
  identify: { label: 'Photo lookups',  emoji: '🔎', color: '#b8860b' },
};
const ORDER: OpType[] = ['snap', 'save', 'search', 'voice', 'identify'];

export default function DashboardPage() {
  const [stats, setStats] = useState<DailyOpStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetch('/api/stats?days=30')
      .then(r => r.json())
      .then(d => { if (d.ok) setStats(d.stats as DailyOpStat[]); else setError(d.error || 'load failed'); })
      .catch(e => setError(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Group rows by day (API already returns them newest-first).
  const byDate = new Map<string, DailyOpStat[]>();
  (stats || []).forEach(s => {
    const arr = byDate.get(s.date) || [];
    arr.push(s);
    byDate.set(s.date, arr);
  });
  const dates = Array.from(byDate.keys());

  const totalCount = (stats || []).reduce((a, s) => a + s.count, 0);

  return (
    <div style={{ minHeight: '100dvh', background: C.bg, color: C.text, fontFamily: FONT, padding: '60px 18px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <a href="/admin" style={{ color: C.primary, textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>← Workspace</a>
        <button onClick={load} style={{
          background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '4px 12px', fontSize: 12.5, fontWeight: 600, color: C.textMuted,
          cursor: 'pointer', fontFamily: FONT,
        }}>Refresh</button>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 800, margin: '4px 0 2px', letterSpacing: -0.6 }}>Activity dashboard</h1>
      <p style={{ color: C.textMuted, fontSize: 14, margin: '0 0 18px' }}>Last 30 days · daily counts per operation</p>

      {/* Summary */}
      <div style={{
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 18,
        padding: '16px 18px', marginBottom: 18,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11.5, color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Total operations</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.primaryDark, lineHeight: 1.1 }}>
            {totalCount}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 14px', background: '#fee', border: '1px solid #fcc', borderRadius: 12, color: '#933', fontSize: 13.5 }}>
          {error}
        </div>
      )}
      {!stats && !error && (
        <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 30 }}>Loading…</div>
      )}
      {stats && dates.length === 0 && (
        <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 30, background: C.bgMuted, borderRadius: 14 }}>
          No operations yet. Snap a shelf or run a few searches first.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {dates.map(date => {
          const rows = byDate.get(date)!;
          const dayCount = rows.reduce((a, r) => a + r.count, 0);
          const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
          return (
            <div key={date} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: '12px 16px', background: C.bgMuted, borderBottom: `1px solid ${C.border}`,
              }}>
                <span style={{ fontWeight: 800, fontSize: 15, fontFamily: 'ui-monospace, monospace' }}>{date}</span>
                <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>{dayCount} ops</span>
              </div>
              {sorted.map((r, i) => {
                const m = TYPE_META[r.type];
                return (
                  <div key={r.type} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 16px', borderTop: i ? `1px solid ${C.border}` : 'none',
                  }}>
                    <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{m?.emoji ?? '•'}</span>
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5, color: m?.color ?? C.text }}>{m?.label ?? r.type}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.text, minWidth: 44, textAlign: 'right' }}>{r.count}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

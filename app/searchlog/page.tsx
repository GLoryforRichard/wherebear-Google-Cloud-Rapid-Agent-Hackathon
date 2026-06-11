'use client';

import { useEffect, useState, useCallback, CSSProperties } from 'react';
import { C, FONT } from '@/lib/theme';

interface SearchLogCandidate {
  canonical_name: string;
  aisles: string[];
  score: number | null;
  evidence_count: number | null;
}
type SearchFeedback =
  | { verdict: 'correct'; product: string }
  | { verdict: 'wrong' }
  | null;
interface SearchLogEntry {
  id: string;
  query: string;
  found: boolean;
  product: string | null;
  aisles: string[];
  candidates: SearchLogCandidate[];
  answer_en: string | null;
  answer_zh: string | null;
  feedback: SearchFeedback;
  ts: string;
}

function timeLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const chip = (bg: string, color: string): CSSProperties => ({
  fontSize: 12, fontWeight: 700, color, background: bg,
  padding: '2px 8px', borderRadius: 999, fontFamily: 'ui-monospace, monospace',
});

export default function SearchLogPage() {
  const [logs, setLogs] = useState<SearchLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetch('/api/search-logs')
      .then(r => r.json())
      .then(d => { if (d.ok) setLogs(d.logs as SearchLogEntry[]); else setError(d.error || 'load failed'); })
      .catch(e => setError(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const foundCount = (logs || []).filter(l => l.found).length;

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
      <h1 style={{ fontSize: 28, fontWeight: 800, margin: '4px 0 2px', letterSpacing: -0.6 }}>Search history</h1>
      <p style={{ color: C.textMuted, fontSize: 14, margin: '0 0 18px' }}>
        Last 100 · tap a row for details{logs ? ` · found ${foundCount}/${logs.length}` : ''}
      </p>

      {error && (
        <div style={{ padding: '12px 14px', background: '#fee', border: '1px solid #fcc', borderRadius: 12, color: '#933', fontSize: 13.5 }}>{error}</div>
      )}
      {!logs && !error && <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 30 }}>Loading…</div>}
      {logs && logs.length === 0 && (
        <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 30, background: C.bgMuted, borderRadius: 14 }}>
          No searches yet. Run a few from “Find item” first.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(logs || []).map((l) => {
          const open = openId === l.id;
          const fb = l.feedback;
          return (
            <div
              key={l.id}
              onClick={() => setOpenId(open ? null : l.id)}
              style={{ background: C.white, border: `1px solid ${open ? C.primary : C.border}`, borderRadius: 14, padding: '12px 14px', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  “{l.query}”
                </div>
                <span style={{ fontSize: 11.5, color: C.textSoft, fontWeight: 500, flexShrink: 0 }}>{timeLabel(l.ts)}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {l.found ? (
                  <>
                    <span style={chip(C.primary, '#fff')}>Found{l.candidates.length > 1 ? ` ${l.candidates.length}` : ''}</span>
                    {l.product && <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{l.product}</span>}
                    {l.aisles.map((a, j) => (
                      <span key={j} style={chip(C.primarySofter, C.primaryDark)}>{a}</span>
                    ))}
                  </>
                ) : (
                  <span style={chip('#fee', '#933')}>No match</span>
                )}

                {/* Worker feedback badge */}
                {fb?.verdict === 'correct' && (
                  <span style={{ ...chip('#e7f6ec', '#1c7d3f'), fontFamily: FONT }}>✓ Confirmed</span>
                )}
                {fb?.verdict === 'wrong' && (
                  <span style={{ ...chip('#fdeaea', '#c0322b'), fontFamily: FONT }}>✕ None right</span>
                )}
              </div>

              {(l.answer_en || l.answer_zh) && (
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8, lineHeight: 1.4 }}>
                  {l.answer_en || l.answer_zh}
                </div>
              )}

              {/* Detail — candidate list, shown when the row is expanded */}
              {open && (
                <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${C.border}` }}>
                  {l.candidates.length > 0 ? (
                    <>
                      <div style={{ fontSize: 11.5, color: C.textSoft, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                        {l.candidates.length} candidate{l.candidates.length === 1 ? '' : 's'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {l.candidates.map((c, i) => {
                          const isCorrect = fb?.verdict === 'correct' && fb.product === c.canonical_name;
                          return (
                            <div key={i}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                                padding: '7px 10px', borderRadius: 10,
                                background: isCorrect ? '#e7f6ec' : C.bgMuted,
                                border: isCorrect ? '1px solid #1c7d3f55' : `1px solid transparent`,
                              }}>
                              {isCorrect && <span style={{ color: '#1c7d3f', fontWeight: 800 }}>✓</span>}
                              <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{c.canonical_name}</span>
                              {c.aisles.map((a, j) => (
                                <span key={j} style={chip(C.white, C.primaryDark)}>{a}</span>
                              ))}
                              {typeof c.score === 'number' && (
                                <span style={{ fontSize: 11.5, color: C.textSoft, fontWeight: 600, marginLeft: 'auto' }}>
                                  {Math.round(c.score * 100)}%
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12.5, color: C.textSoft }}>(no candidate details for this entry)</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

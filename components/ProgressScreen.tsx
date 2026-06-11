'use client';

import { useState, useEffect, useRef } from 'react';
import { C, FONT, SHADOW } from '@/lib/theme';
import BearFace from './BearFace';
import Icon from './Icon';
import ScreenHeader from './ScreenHeader';
import { SnapPayload } from './SnapScreen';
import { AgentEvent } from '@/lib/agents/types';
import { useTranslation } from '@/lib/i18n';

type Screen = 'home' | 'snap' | 'progress' | 'find';

interface ProgressScreenProps {
  go: (screen: Screen) => void;
  payload: SnapPayload | null;
}

type TFunc = ReturnType<typeof useTranslation>['t'];

// Step labels resolve through i18n at render time so they follow the UI
// language. Maps the writer agent's internal tool names to friendly copy.
function stepLabel(tool: string, t: TFunc): string {
  switch (tool) {
    case 'find_existing_products':
    case 'find_existing_product': return t('step_snap_check');
    case 'expand_aliases':
    case 'expand_aliases_batch': return t('step_snap_alias');
    case 'save_products':
    case 'save_product': return t('step_snap_save');
    case 'record_shelf_evidence': return t('step_snap_evidence');
    case 'finish': return t('step_snap_finish');
    default: return tool;
  }
}

interface StepRow {
  id: string;
  tool: string;
  label: string;
  args?: Record<string, unknown>;
  result?: unknown;
  state: 'live' | 'done';
  startTs: number;
  endTs?: number;
}

function summarizeArgs(tool: string, args?: Record<string, unknown>) {
  if (!args) return '';
  if (tool === 'find_existing_product' || tool === 'save_product' || tool === 'expand_aliases') {
    return (args.canonical_name as string) || '';
  }
  if (tool === 'find_existing_products' || tool === 'expand_aliases_batch') {
    const arr = args.canonical_names as string[] | undefined;
    return arr ? `${arr.length} products` : '';
  }
  if (tool === 'save_products') {
    const arr = args.products as unknown[] | undefined;
    return arr ? `${arr.length} products` : '';
  }
  if (tool === 'record_shelf_evidence') {
    const arr = args.products_detected as string[] | undefined;
    return arr ? `${arr.length} products` : '';
  }
  return '';
}

function summarizeResult(tool: string, result: unknown, t: TFunc) {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (tool === 'find_existing_product') {
    return r.found ? t('sum_check_known') : t('sum_check_new');
  }
  if (tool === 'find_existing_products') {
    const results = r.results as Record<string, { found: boolean }> | undefined;
    if (!results) return '';
    const found = Object.values(results).filter(v => v.found).length;
    const total = Object.keys(results).length;
    return t('sum_check', found, total - found);
  }
  if (tool === 'save_product') {
    return t('sum_save_one', (r.evidence_count as number) ?? 0);
  }
  if (tool === 'save_products') {
    const totals = r.totals as { inserted?: number; updated?: number } | undefined;
    if (!totals) return '';
    return t('sum_save', totals.inserted ?? 0, totals.updated ?? 0);
  }
  if (tool === 'expand_aliases') {
    const arr = r.aliases as string[] | undefined;
    return arr ? t('sum_alias', arr.length) : '';
  }
  if (tool === 'expand_aliases_batch') {
    const map = r.aliases_by_name as Record<string, unknown> | undefined;
    return map ? t('sum_alias_batch', Object.keys(map).length) : '';
  }
  if (tool === 'record_shelf_evidence') {
    return r.inserted ? t('sum_evidence') : '';
  }
  return '';
}

function viaTag(result: unknown): 'mcp' | 'sdk' | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.via === 'mcp' || r.via === 'sdk') return r.via;
  if (r.via_mcp === true) return 'mcp';
  return null;
}

// One bulkWrite handles the whole shelf now (no per-product LLM call in
// the critical path). Batch shelf scans (15 photos × ~50 SKUs) can yield
// 200-300 unique SKUs post-dedup — ship them all in one request.
const CHUNK_SIZE = 400;
/** Gap between batches — only used if we ever chunk again. */
const BATCH_THROTTLE_MS = 400;

/**
 * When the SSE stream throws (typical cause on iOS: user backgrounded the
 * tab and Safari killed the connection), the agent often kept running on
 * the server and the data really did land in MongoDB. Verify by querying
 * the aisle's product list for documents updated since the run started.
 */
async function verifyServerSideSave(
  aisle: string,
  runStartTime: number
): Promise<{ saved: number } | null> {
  try {
    const res = await fetch(`/api/admin/products?aisle=${encodeURIComponent(aisle)}`);
    if (!res.ok) return null;
    const data = await res.json() as {
      ok: boolean;
      products?: Array<{ updated_at?: string }>;
    };
    if (!data.ok || !Array.isArray(data.products)) return null;
    // Allow a 5s buffer before runStart in case clocks differ slightly.
    const sinceMs = runStartTime - 5000;
    const recent = data.products.filter(p => {
      if (!p.updated_at) return false;
      return new Date(p.updated_at).getTime() >= sinceMs;
    });
    return recent.length > 0 ? { saved: recent.length } : null;
  } catch {
    return null;
  }
}

// Turn any raw backend/SDK error into one friendly, non-technical line — never
// leak raw JSON / provider names to the shop floor.
function friendlyError(raw: string, t: TFunc): string {
  const s = (raw || '').toLowerCase();
  if (/429|resource_exhausted|quota|overload|rate.?limit|unavailable|503/.test(s)) {
    return t('err_busy');
  }
  return t('err_generic');
}

export default function ProgressScreen({ go, payload }: ProgressScreenProps) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState<Record<string, boolean>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [agentNotes, setAgentNotes] = useState<string[]>([]);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchTotal, setBatchTotal] = useState(1);
  const startedRef = useRef(false);
  const goRef = useRef(go);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { goRef.current = go; }, [go]);

  // Keep the latest step in view
  useEffect(() => {
    if (panelRef.current && panelOpen) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [steps.length, panelOpen]);

  useEffect(() => {
    if (!payload || startedRef.current) return;
    startedRef.current = true;


    // Split into chunks of CHUNK_SIZE so each SSE stream finishes well under
    // iOS Safari's idle-stream cutoff. The user sees one continuous flow.
    const chunks: typeof payload.products[] = [];
    for (let i = 0; i < payload.products.length; i += CHUNK_SIZE) {
      chunks.push(payload.products.slice(i, i + CHUNK_SIZE));
    }
    setBatchTotal(chunks.length);

    const ac = new AbortController();
    const runStartTime = Date.now();
    let totalUpserted = 0;
    let totalUpdated = 0;

    const runChunk = async (chunk: typeof payload.products, index: number) => {
      setBatchIndex(index);
      const res = await fetch('/api/shelf-evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aisle: payload.aisle, products: chunk }),
        signal: ac.signal,
      });
      if (!res.body) throw new Error('No response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const piece = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!piece.startsWith('data:')) continue;
          const json = piece.slice(5).trim();
          if (!json) continue;
          try {
            const event = JSON.parse(json) as AgentEvent;
            handleEvent(event, index, chunks.length);
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    };

    (async () => {
      try {
        for (let i = 0; i < chunks.length; i++) {
          await runChunk(chunks[i], i);
          // Brief pause between batches to avoid bursting through the Gemini
          // per-minute quota (each batch fires ~15 generateContent calls).
          if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, BATCH_THROTTLE_MS));
          }
        }
        setSummary(
          chunks.length > 1
            ? t('progress_saved_detail', totalUpserted, totalUpdated)
            : t('progress_saved_detail', totalUpserted, totalUpdated)
        );
        if (totalUpserted > 0) setAgentNotes([t('panel_bg_alias')]);
        // Do NOT auto-navigate. The worker wants to read the totals, scroll
        // through what Atlas Search auto-embed indexed, and decide for
        // themselves whether to head home, snap the next shelf, or jump
        // straight to Find. Buttons render below.
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // SSE most likely dropped because iOS Safari backgrounded the tab.
        // Check whether the server-side agent actually saved data anyway.
        const verified = await verifyServerSideSave(payload.aisle, runStartTime);
        if (verified && verified.saved > 0) {
          setSummary(
            `Connection dropped (likely backgrounded) — ` +
            `${verified.saved} products were saved on the server anyway.`
          );
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    function handleEvent(event: AgentEvent, chunkIdx: number, chunkCount: number) {
      if (event.type === 'tool_call') {
        const id = `${event.tool}-${event.ts}-${chunkIdx}`;
        const tool = event.tool || 'unknown';
        const label = tool;
        setSteps(prev => {
          const updated = prev.map(s => s.state === 'live'
            ? { ...s, state: 'done' as const, endTs: s.endTs ?? event.ts }
            : s
          );
          return [...updated, {
            id,
            tool,
            label,
            args: event.args as Record<string, unknown>,
            state: 'live',
            startTs: event.ts,
          }];
        });
      } else if (event.type === 'tool_result') {
        if (event.tool === 'save_product') {
          const r = event.result as { action?: string } | undefined;
          if (r?.action === 'inserted') totalUpserted += 1;
          else if (r?.action === 'updated') totalUpdated += 1;
        } else if (event.tool === 'save_products') {
          const r = event.result as { totals?: { inserted?: number; updated?: number } } | undefined;
          totalUpserted += r?.totals?.inserted ?? 0;
          totalUpdated += r?.totals?.updated ?? 0;
        }
        setSteps(prev => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].tool === event.tool && updated[i].state === 'live') {
              updated[i] = {
                ...updated[i],
                result: event.result,
                state: 'done',
                endTs: event.ts,
              };
              break;
            }
          }
          return updated;
        });
      } else if (event.type === 'done') {
        // Per-chunk done — finalize live steps but don't navigate home yet.
        setSteps(prev => prev.map(s => ({ ...s, state: 'done' as const })));
        if (chunkIdx === chunkCount - 1) {
          // last chunk done — summary will be set by the outer async block
        }
      } else if (event.type === 'agent_message') {
        if (event.message) setAgentNotes(n => [...n, event.message!]);
      } else if (event.type === 'error') {
        setError(event.error || 'Unknown error');
      }
    }

    return () => ac.abort();
  }, [payload]);

  const done = !!summary;

  return (
    <div style={{ padding: '62px 20px 60px', fontFamily: FONT, color: C.text, background: C.bgMuted, minHeight: '100vh' }}>
      <ScreenHeader title={t('progress_title')} onBack={() => go('home')} />

      <div style={{ marginBottom: 22 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 17, lineHeight: 1.35, fontWeight: 500, color: C.text }}>
            {error
              ? t('progress_error')
              : done
                ? t('progress_done')
                : t('progress_running', payload?.products.length ?? 0)}
          </div>
          {batchTotal > 1 && !done && !error && (
            <span style={{
              fontSize: 11, fontWeight: 700, color: C.primaryDark,
              background: C.primarySofter, padding: '4px 10px', borderRadius: 999,
              fontFamily: 'ui-monospace, monospace', letterSpacing: 0.4,
            }}>
              {t('panel_batch', batchIndex + 1, batchTotal)}
            </span>
          )}
        </div>
        {done && summary && (
          <div style={{ fontSize: 13.5, color: C.textMuted, marginTop: 6, lineHeight: 1.4 }}>
            {summary}
          </div>
        )}
      </div>


      <button
        onClick={() => setPanelOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 10, background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', fontFamily: FONT,
        }}
      >
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.8,
        }}>
          <Icon name="sparkle" size={14} style={{ color: C.accent }} />
          {t('panel_snap_title', steps.length)}
        </span>
        <Icon name="chevron-down" size={18} style={{
          color: C.textMuted,
          transform: panelOpen ? 'rotate(180deg)' : 'none',
          transition: 'transform .2s',
        }} />
      </button>

      {agentNotes.length > 0 && panelOpen && (
        <div style={{
          marginBottom: 8, background: C.accentTint, border: `1px solid ${C.accentChip}`,
          borderRadius: 12, padding: '8px 12px', fontSize: 13, color: C.accentDark,
          fontWeight: 500, lineHeight: 1.4,
        }}>
          {agentNotes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}

      <div ref={panelRef} style={{
        background: C.white, borderRadius: 18, border: `1px solid ${C.border}`,
        overflow: 'hidden',
        maxHeight: panelOpen ? '55vh' : 0,
        opacity: panelOpen ? 1 : 0,
        transition: 'max-height .25s ease, opacity .2s ease',
        overflowY: 'auto',
      }}>
        {steps.length === 0 && !error && (
          <div style={{ padding: '20px 16px', color: C.textMuted, fontSize: 13.5, textAlign: 'center' }}>
            {t('panel_snap_waiting')}
          </div>
        )}
        {steps.map((s, i) => {
          const argSummary = summarizeArgs(s.tool, s.args);
          const resultSummary = summarizeResult(s.tool, s.result, t);
          const showing = showDetails[s.id];
          const dur = s.endTs && s.startTs ? s.endTs - s.startTs : null;
          const aliasResult = (s.tool === 'expand_aliases'
            && s.result
            && typeof s.result === 'object'
            && Array.isArray((s.result as Record<string, unknown>).aliases))
            ? ((s.result as { aliases: string[] }).aliases)
            : null;
          return (
            <div key={s.id} style={{
              padding: '12px 14px',
              borderTop: i ? `1px solid ${C.border}` : 'none',
              display: 'flex', gap: 12, alignItems: 'flex-start',
            }}>
              <div style={{
                width: 26, height: 26, borderRadius: 13,
                background: s.state === 'live' ? C.white : C.primary,
                border: s.state === 'live' ? `2px solid ${C.primary}` : 'none',
                color: s.state === 'live' ? C.primary : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                animation: s.state === 'live' ? 'pulse 1.4s ease-in-out infinite' : 'none',
              }}>
                {s.state === 'live'
                  ? <Icon name="dots" size={14} />
                  : <Icon name="check" size={14} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13.5, fontWeight: 700, color: C.text, lineHeight: 1.25,
                  display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap',
                }}>
                  <span>{stepLabel(s.tool, t)}</span>
                  {argSummary && <span style={{ color: C.textMuted, fontWeight: 500 }}>· {argSummary}</span>}
                  {dur !== null && (
                    <span style={{
                      color: C.textSoft, fontWeight: 500, fontSize: 11,
                      fontFamily: 'ui-monospace, monospace',
                      marginLeft: 'auto',
                    }}>{dur}ms</span>
                  )}
                </div>
                {(() => {
                  const via = viaTag(s.result);
                  if (!resultSummary && !via) return null;
                  return (
                    <div style={{
                      fontSize: 12, color: C.primaryDark, marginTop: 2, fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                    }}>
                      {resultSummary && <span>→ {resultSummary}</span>}
                      {via === 'mcp' && (
                        <span style={{
                          background: '#dbeafe', color: '#1e40af',
                          padding: '1px 7px', borderRadius: 999,
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                          fontFamily: 'ui-monospace, monospace',
                        }}>MCP</span>
                      )}
                      {via === 'sdk' && (
                        <span style={{
                          background: '#fef3c7', color: '#92400e',
                          padding: '1px 7px', borderRadius: 999,
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                          fontFamily: 'ui-monospace, monospace',
                        }}>SDK</span>
                      )}
                    </div>
                  );
                })()}
                {aliasResult && aliasResult.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {aliasResult.slice(0, 8).map(a => (
                      <span key={a} style={{
                        background: C.accentTint, color: C.accentDark,
                        padding: '2px 8px', borderRadius: 999,
                        fontSize: 11, fontWeight: 600,
                      }}>{a}</span>
                    ))}
                    {aliasResult.length > 8 && (
                      <span style={{ fontSize: 11, color: C.textSoft, padding: '2px 4px' }}>
                        +{aliasResult.length - 8} more
                      </span>
                    )}
                  </div>
                )}
                {showing && (
                  <pre style={{
                    fontSize: 11, color: C.textMuted, marginTop: 6,
                    fontFamily: 'ui-monospace, monospace',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background: C.bgMuted, padding: 8, borderRadius: 6,
                  }}>{JSON.stringify({ args: s.args, result: s.result }, null, 2)}</pre>
                )}
              </div>
              <button onClick={() => setShowDetails(d => ({ ...d, [s.id]: !d[s.id] }))} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: C.textSoft, padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0,
              }} aria-label="toggle details">
                <Icon name="chevron-down" size={16} style={{
                  transform: showing ? 'rotate(180deg)' : 'none',
                  transition: 'transform .2s',
                }} />
              </button>
            </div>
          );
        })}
        {error && (
          <div style={{
            padding: '14px 16px', borderTop: steps.length ? `1px solid ${C.border}` : 'none',
            color: '#c33', fontSize: 13, fontWeight: 500,
          }}>
            {friendlyError(error, t)}
          </div>
        )}
      </div>

      <div style={{
        marginTop: 24, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 14,
      }}>
        <BearFace size={108} />
        <div style={{
          background: C.accentTint, padding: '10px 16px', borderRadius: '18px 18px 18px 4px',
          fontSize: 14, fontWeight: 600, color: C.accentDark, marginBottom: 14,
          border: `1px solid ${C.accentChip}`,
          maxWidth: 240,
        }}>
          {error ? error.slice(0, 100) : done ? t('progress_saved_chat') : t('progress_running_chat')}
        </div>
      </div>

      {/* Manual actions — only after the run finishes (success OR error).
          We used to auto-navigate home after 2.4s, but workers want to read
          the totals, scan the agent trace, and decide for themselves. */}
      {(done || error) && (
        <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
          {done && !error && (
            <button
              onClick={() => go('snap')}
              style={{
                width: '100%', padding: '15px 0',
                background: C.primary, color: C.text, border: `2px solid ${C.border}`, borderRadius: 14,
                fontFamily: FONT, fontSize: 16, fontWeight: 800, cursor: 'pointer',
                boxShadow: SHADOW,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <Icon name="image" size={18} /> {t('progress_btn_snap')}
            </button>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button
              onClick={() => go('find')}
              style={{
                padding: '13px 0',
                background: C.white, color: C.primary,
                border: `1.5px solid ${C.primary}`, borderRadius: 999,
                fontFamily: FONT, fontSize: 15, fontWeight: 700, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              }}
            >
              <Icon name="search" size={16} /> {t('progress_btn_find')}
            </button>
            <button
              onClick={() => go('home')}
              style={{
                padding: '13px 0',
                background: C.white, color: C.text,
                border: `1px solid ${C.border}`, borderRadius: 999,
                fontFamily: FONT, fontSize: 15, fontWeight: 700, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              }}
            >
              <Icon name="home" size={16} /> {t('progress_btn_home')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


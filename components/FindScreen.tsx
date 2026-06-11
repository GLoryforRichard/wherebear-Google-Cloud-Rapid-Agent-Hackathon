'use client';

import { useState, useEffect, useRef } from 'react';
import { C, FONT, SHADOW } from '@/lib/theme';
import BearFace from './BearFace';
import AnimatedBear from './AnimatedBear';
import Icon from './Icon';
import LanguageToggle from './LanguageToggle';
import { AgentEvent } from '@/lib/agents/types';
import { useTranslation } from '@/lib/i18n';
import { useVoiceRecorder, getVoiceSupported } from '@/lib/voice';
import StoreMap from './StoreMap';

type Screen = 'home' | 'snap' | 'progress' | 'find';
type Phase = 'input' | 'searching' | 'result';

interface FindScreenProps {
  go: (screen: Screen) => void;
}

type TFunc = ReturnType<typeof useTranslation>['t'];

// Step labels resolve through i18n at render time so they follow the UI
// language. Maps the agent's internal tool names to friendly, jargon-free copy.
function stepLabel(tool: string, t: TFunc): string {
  switch (tool) {
    case 'understand_intent': return t('step_find_intent');
    case 'vector_search': return t('step_find_search');
    case 'suggest_by_category': return t('step_find_category');
    case 'log_search': return t('step_find_log');
    case 'finish': return t('step_find_finish');
    default: return tool;
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

interface FinishProduct {
  canonical_name: string;
  latest_aisle: string;
  /** All shelves this SKU has been seen on. Falls back to [latest_aisle] for
   *  legacy docs. */
  aisles?: string[];
  score: number;
  evidence_count: number;
  aliases?: string[];
  /** 240px JPEG data URL of the product, looked up server-side by
   *  canonical_name after Agent B finishes. */
  thumbnail?: string;
}

interface FinishData {
  /** Candidate list — every match above the relevance bar, best first. */
  candidates?: FinishProduct[];
  /** Same-brand / same-category location hints, only when nothing matched. */
  guesses?: FinishProduct[];
  /** Back-compat: the top candidate (== candidates[0]). */
  product?: FinishProduct | null;
  /** Bilingual answer fields — preferred. */
  answer_en?: string;
  answer_zh?: string;
  /** Legacy single-language answer — fallback when bilingual fields absent. */
  answer?: string;
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
  if (tool === 'understand_intent') return (args.query as string) || '';
  if (tool === 'vector_search') return (args.query_text as string) || '';
  if (tool === 'log_search') return `"${args.original_query}"`;
  return '';
}

function summarizeResult(tool: string, result: unknown, t: TFunc) {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (tool === 'understand_intent') {
    const lang = r.language as string | undefined;
    const rew = (r.rewritten as string | undefined) || (r.query as string | undefined);
    const langName = lang === 'zh' ? t('lang_zh')
      : lang === 'en' ? t('lang_en')
      : lang === 'ja' ? t('lang_ja')
      : lang === 'ko' ? t('lang_ko')
      : (lang || '');
    if (!langName && !rew) return '';
    return rew ? t('sum_intent', langName, rew) : langName;
  }
  if (tool === 'vector_search') {
    const hits = r.hits as Array<{ canonical_name?: string }> | undefined;
    if (!hits || hits.length === 0) return t('sum_search_none');
    const name = typeof hits[0]?.canonical_name === 'string' ? hits[0].canonical_name : '';
    return name ? t('sum_search_hit', name) : t('sum_search_none');
  }
  if (tool === 'suggest_by_category') {
    const matches = r.matches as Array<unknown> | undefined;
    if (!matches || matches.length === 0) return '';
    return t('sum_category', matches.length);
  }
  if (tool === 'finish') {
    const en = typeof r.answer_en === 'string' ? r.answer_en : '';
    const zh = typeof r.answer_zh === 'string' ? r.answer_zh : '';
    const legacy = typeof r.answer === 'string' ? r.answer : '';
    const pick = en || legacy || zh;
    return pick ? `"${pick.slice(0, 60)}"` : '';
  }
  return '';
}

function viaTag(result: unknown): 'mcp' | 'sdk' | 'driver' | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.via === 'mcp' || r.via === 'sdk') return r.via;
  if (r.via === 'mongodb-driver') return 'driver';
  if (r.via_mcp === true) return 'mcp';
  return null;
}

// "Try asking" suggestions + "Recent searches" were removed — the input
// screen is now just the search box and the voice/photo buttons.

/**
 * Shows the target shelf(es) on the store map, flagged red. One shelf → the
 * map is shown straight away. Several shelves → collapse to a tappable list so
 * the result card stays compact; expand one at a time to locate it.
 */
function ResultMap({ aisles }: { aisles: string[] }) {
  const { t } = useTranslation();
  const single = aisles.length === 1;
  const [open, setOpen] = useState<string | null>(single ? aisles[0] : null);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: C.textMuted,
        textTransform: 'uppercase', letterSpacing: 0.4,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Icon name="map" size={14} style={{ color: '#e5484d' }} /> {t('result_map_title')}
      </div>

      {single ? (
        <div style={{
          marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 12,
          background: C.white, padding: '8px 8px 4px',
        }}>
          <StoreMap highlight={aisles[0]} />
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: C.textSoft, margin: '6px 0 10px', fontWeight: 500 }}>
            {t('result_map_multi_hint')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {aisles.map(code => {
              const isOpen = open === code;
              return (
                <div key={code} style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                  <button
                    onClick={() => setOpen(isOpen ? null : code)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '12px 14px', background: isOpen ? C.primarySofter : C.white,
                      border: 'none', cursor: 'pointer', fontFamily: FONT,
                    }}
                  >
                    <Icon name="pin" size={16} style={{ color: '#e5484d', flexShrink: 0 }} />
                    <span style={{ flex: 1, textAlign: 'left', fontWeight: 800, fontSize: 15, color: C.text, fontFamily: 'ui-monospace, monospace' }}>{code}</span>
                    <Icon name="chevron-down" size={18} style={{ color: C.textMuted, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                  </button>
                  {isOpen && (
                    <div style={{ padding: '0 8px 8px' }}>
                      <StoreMap highlight={code} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ResultCard({
  candidates, guesses, answerEn, answerZh, onAgain, go,
}: {
  candidates: FinishProduct[];
  guesses: FinishProduct[];
  answerEn: string;
  answerZh: string;
  onAgain: () => void;
  go: (s: Screen) => void;
}) {
  const { t, lang } = useTranslation();
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const found = candidates.length > 0;
  const hasGuess = !found && guesses.length > 0;
  // In English mode the answer line is English-only; the Chinese line only
  // renders in 中文 mode (or as a fallback when there's no English answer).
  const showZh = !!answerZh && (lang === 'zh' || !answerEn);
  // Staggered reveal: each block rises in ~70 ms after the previous one
  // instead of the whole card flashing in at once. `both` keeps elements
  // invisible until their own delay starts.
  const reveal = (i: number): React.CSSProperties => ({
    animation: 'rise .32s ease-out both',
    animationDelay: `${i * 0.07}s`,
  });
  // Map highlights the matched shelves — or the guessed shelves when nothing matched.
  const allAisles = Array.from(new Set(
    (found ? candidates : guesses)
      .flatMap(c => (c.aisles && c.aisles.length ? c.aisles : [c.latest_aisle]))
      .filter(Boolean) as string[]
  ));

  return (
    <>
      {/* Bilingual summary line — sits above the candidate list */}
      {(answerEn || showZh) && (
        <div style={{
          marginTop: 18, padding: '14px 16px', background: C.primarySofter,
          borderRadius: 14, ...reveal(0),
        }}>
          {answerEn && (
            <div style={{ fontSize: 15, color: C.primaryDark, fontWeight: 600, lineHeight: 1.4 }}>
              {answerEn}
            </div>
          )}
          {showZh && (
            <div style={{
              fontSize: 14.5, color: C.primaryDark, fontWeight: 500, lineHeight: 1.45,
              marginTop: answerEn ? 6 : 0,
              paddingTop: answerEn ? 6 : 0,
              borderTop: answerEn ? `1px dashed ${C.primary}33` : 'none',
            }}>
              {answerZh}
            </div>
          )}
        </div>
      )}

      {found ? (
        <div style={{ marginTop: 12 }}>
          <div style={{
            fontSize: 12, color: C.textMuted, fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8,
          }}>
            {candidates.length > 1
              ? `${candidates.length} ${t('find_possible_matches')}`
              : t('find_you_might_mean')}
          </div>
          {candidates.map((c, idx) => {
            const aisles = c.aisles && c.aisles.length
              ? Array.from(new Set(c.aisles))
              : [c.latest_aisle];
            return (
              <div key={`${c.canonical_name}-${idx}`} style={{
                background: C.white, borderRadius: 18, border: `1px solid ${C.border}`,
                padding: 14, marginBottom: 10, ...reveal(1 + idx),
                boxShadow: SHADOW,
              }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {c.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnail} alt={c.canonical_name}
                      onClick={() => setZoomSrc(c.thumbnail!)}
                      title={t('find_tap_zoom')}
                      style={{
                        width: 64, height: 64, flexShrink: 0, objectFit: 'cover',
                        borderRadius: 10, border: `1px solid ${C.border}`, background: C.bgMuted,
                        cursor: 'zoom-in',
                      }} />
                  ) : null}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: C.text, lineHeight: 1.2, letterSpacing: -0.3 }}>
                      {c.canonical_name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
                      <Icon name="pin" size={14} style={{ color: C.accent, flexShrink: 0 }} />
                      {aisles.map((code, i) => (
                        <span key={`${code}-${i}`} style={{
                          display: 'inline-flex', alignItems: 'center',
                          background: i === 0 ? C.primary : C.primarySofter,
                          color: i === 0 ? '#fff' : C.primaryDark,
                          padding: '2px 9px', borderRadius: 999,
                          fontSize: 12.5, fontWeight: 700,
                          fontFamily: 'ui-monospace, monospace', letterSpacing: 0.3,
                        }}>{code}</span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: C.textSoft, fontWeight: 500 }}>
                        {t('find_seen')} {c.evidence_count}×
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div style={{
            marginTop: 18, background: C.white, borderRadius: 22, border: `1px solid ${C.border}`,
            padding: 20, ...reveal(answerEn || showZh ? 1 : 0),
          }}>
            {!answerEn && !showZh && (
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
                {t('find_no_record')}
              </div>
            )}
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: (answerEn || showZh) ? 0 : 8, lineHeight: 1.5 }}>
              {hasGuess ? t('find_guess_note') : t('find_try_other')}
            </div>
          </div>

          {/* Location guesses — same-brand / same-category, clearly NOT the item */}
          {hasGuess && (
            <div style={{ marginTop: 12 }}>
              <div style={{
                fontSize: 12, color: C.accentDark, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Icon name="pin" size={13} /> {t('find_guess_title')}
              </div>
              {guesses.map((g, idx) => {
                const ais = g.aisles && g.aisles.length ? Array.from(new Set(g.aisles)) : [g.latest_aisle];
                return (
                  <div key={`${g.canonical_name}-${idx}`} style={{
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    background: C.accentTint, border: `1px dashed ${C.accentChip}`,
                    borderRadius: 12, padding: '10px 12px', marginBottom: 8,
                    ...reveal(2 + idx),
                  }}>
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: C.text }}>{g.canonical_name}</span>
                    {ais.map((a, j) => (
                      <span key={`${a}-${j}`} style={{
                        display: 'inline-flex', alignItems: 'center',
                        background: C.accentChip, color: C.accentDark,
                        padding: '2px 9px', borderRadius: 999,
                        fontSize: 12.5, fontWeight: 700,
                        fontFamily: 'ui-monospace, monospace', letterSpacing: 0.3,
                      }}>{a}</span>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {allAisles.length > 0 && (
        <div style={reveal(2 + (found ? candidates.length : guesses.length))}>
          <ResultMap aisles={allAisles} />
        </div>
      )}

      <button onClick={onAgain} style={{
        width: '100%', marginTop: 14, padding: '15px 0',
        background: 'transparent', color: C.primary, border: `1.5px solid ${C.primary}`, borderRadius: 999,
        fontFamily: FONT, fontSize: 16, fontWeight: 700, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        ...reveal(3 + (found ? candidates.length : guesses.length)),
      }}>
        <Icon name="search" size={18} /> {t('find_search_again')}
      </button>

      <button onClick={() => go('home')} style={{
        width: '100%', marginTop: 8, padding: '13px 0',
        background: 'transparent', color: C.textMuted, border: 'none',
        fontFamily: FONT, fontSize: 14.5, fontWeight: 600, cursor: 'pointer',
        ...reveal(3 + (found ? candidates.length : guesses.length)),
      }}>{t('find_back')}</button>

      {/* Tap a thumbnail to zoom — full-screen lightbox, tap anywhere to close. */}
      {zoomSrc && (
        <div onClick={() => setZoomSrc(null)} style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(20,12,6,0.82)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 24,
          animation: 'fade .2s ease', cursor: 'zoom-out',
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomSrc} alt="Zoomed product photo" style={{
            maxWidth: '92vw', maxHeight: '86vh', objectFit: 'contain',
            borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          }} />
        </div>
      )}
    </>
  );
}

function ThinkingPanel({ steps, searching }: { steps: StepRow[]; searching: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  // Auto-collapse once the search finishes — the answer is what matters then.
  useEffect(() => { if (!searching) setOpen(false); }, [searching]);
  if (steps.length === 0) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8, background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', fontFamily: FONT,
        }}
      >
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.6,
        }}>
          <Icon name="sparkle" size={14} style={{ color: C.accent }} />
          {t('panel_find_title', steps.length)}
        </span>
        <Icon name="chevron-down" size={18} style={{
          color: C.textMuted,
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform .2s',
        }} />
      </button>
      <div style={{
        background: C.white, borderRadius: 18, border: `1px solid ${C.border}`,
        overflow: 'hidden',
        maxHeight: open ? 600 : 0,
        opacity: open ? 1 : 0,
        transition: 'max-height .25s ease, opacity .2s ease',
      }}>
        {steps.map((s, i) => {
          const argSummary = summarizeArgs(s.tool, s.args);
          const resultSummary = summarizeResult(s.tool, s.result, t);
          const dur = s.endTs && s.startTs ? s.endTs - s.startTs : null;
          return (
            <div key={s.id} style={{
              padding: '11px 14px',
              borderTop: i ? `1px solid ${C.border}` : 'none',
              display: 'flex', gap: 11, alignItems: 'flex-start',
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: 12,
                background: s.state === 'live' ? C.white : C.primary,
                border: s.state === 'live' ? `2px solid ${C.primary}` : 'none',
                color: s.state === 'live' ? C.primary : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                animation: s.state === 'live' ? 'pulse 1.4s ease-in-out infinite' : 'none',
              }}>
                {s.state === 'live'
                  ? <Icon name="dots" size={12} />
                  : <Icon name="check" size={12} />}
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
                      marginLeft: 'auto', color: C.textSoft, fontSize: 11, fontWeight: 500,
                      fontFamily: 'ui-monospace, monospace',
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
                        }}>⚡ MongoDB MCP</span>
                      )}
                      {(via === 'sdk' || via === 'driver') && (
                        <span style={{
                          background: '#dbeafe', color: '#1e40af',
                          padding: '1px 7px', borderRadius: 999,
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                          fontFamily: 'ui-monospace, monospace',
                        }}>⚡ MongoDB</span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function FindScreen({ go }: FindScreenProps) {
  const { t, lang } = useTranslation();
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [finish, setFinish] = useState<FinishData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [earlyName, setEarlyName] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [heardEn, setHeardEn] = useState<string | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Voice support is client-only — gate on an effect to keep SSR markup
  // identical (no hydration mismatch).
  useEffect(() => { setSupported(getVoiceSupported()); }, []);

  // `recording` (from the hook) covers mic capture; `transcribing` covers the
  // upload + Gemini round-trip until the transcript lands in `heard`.
  const [transcribing, setTranscribing] = useState(false);

  const { start, stop, recording } = useVoiceRecorder(
    async (wav) => {
      setTranscribing(true);
      try {
        const fd = new FormData();
        fd.append('audio', wav, 'voice.wav');
        fd.append('lang', lang);
        const res = await fetch('/api/voice', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.ok && data.text) {
          setQ(data.text);
          setHeard(data.text);           // show the transcript; wait for confirm
          setHeardEn(data.text_en ?? null);
        } else {
          setVoiceErr(data.error || t('voice_error'));
        }
      } catch {
        setVoiceErr(t('voice_error'));
      } finally {
        setTranscribing(false);
      }
    },
    (code) => {
      setVoiceErr(
        code === 'mic-denied' ? t('voice_mic_denied')
        : code === 'unsupported' ? t('voice_unsupported')
        : t('voice_error')
      );
      setTranscribing(false);
      setHeard(null);
    },
  );
  const startVoice = () => { setVoiceErr(null); setHeard(null); start(); };

  // Find-by-photo: snap/upload a product photo, Gemini names it, then the same
  // confirm-then-search flow as voice (transcript lands in `heard`).
  const [identifying, setIdentifying] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';                 // let the user re-pick the same file
    if (!file) return;
    setVoiceErr(null);
    setHeard(null);
    setIdentifying(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      fd.append('lang', lang);
      const res = await fetch('/api/identify', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.ok && data.text) {
        setQ(data.text);
        setHeard(data.text);
        setHeardEn(data.text_en ?? null);
      } else {
        setVoiceErr(data.error || t('photo_error'));
      }
    } catch {
      setVoiceErr(t('photo_error'));
    } finally {
      setIdentifying(false);
    }
  };

  const submit = (text?: string) => {
    const val = (text ?? q).trim();
    if (!val) return;
    setQ(val);
    setSteps([]);
    setFinish(null);
    setError(null);
    setEarlyName(null);
    setPhase('searching');

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: val }),
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
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!chunk.startsWith('data:')) continue;
            const json = chunk.slice(5).trim();
            if (!json) continue;
            try {
              const event = JSON.parse(json) as AgentEvent;
              handleEvent(event);
            } catch {
              /* ignore */
            }
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('result');
      }
    })();
  };

  const handleEvent = (event: AgentEvent) => {
    // `logged` is sent by the route (not the agent) after the search is written
    // to history — it carries the row id so feedback can attach to this search.
    // 'logged' is a route-level bookkeeping event — nothing to render for it.
    if ((event as { type?: string }).type === 'logged') return;
    if (event.type === 'tool_call') {
      const tool = event.tool || 'unknown';
      const label = tool;
      const id = `${tool}-${event.ts}`;
      setSteps(prev => {
        const updated = prev.map(s => s.state === 'live'
          ? { ...s, state: 'done' as const, endTs: s.endTs ?? event.ts }
          : s);
        return [...updated, {
          id, tool, label,
          args: event.args as Record<string, unknown>,
          state: 'live',
          startTs: event.ts,
        }];
      });
    } else if (event.type === 'tool_result') {
      // The moment intent is understood, capture the Chinese name. In zh mode
      // the UI shows it right away — the worker often knows the aisle from the
      // name alone, before the vector search even finishes.
      if (event.tool === 'understand_intent') {
        const nz = (event.result as { name_zh?: string })?.name_zh;
        if (nz && nz.trim()) setEarlyName(nz.trim());
      }
      setSteps(prev => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].tool === event.tool && updated[i].state === 'live') {
            updated[i] = { ...updated[i], result: event.result, state: 'done', endTs: event.ts };
            break;
          }
        }
        return updated;
      });
    } else if (event.type === 'done') {
      setSteps(prev => prev.map(s => ({ ...s, state: 'done' as const })));
      setFinish((event.data as FinishData) || { candidates: [], answer: event.summary || '' });
      setPhase('result');
    } else if (event.type === 'error') {
      setError(event.error || 'Unknown error');
      setPhase('result');
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setQ('');
    setSteps([]);
    setFinish(null);
    setError(null);
    setEarlyName(null);
    setPhase('input');
  };

  return (
    <div style={{ padding: '70px 20px 130px', fontFamily: FONT, color: C.text }}>
      <button onClick={() => go('home')} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: C.textMuted, fontFamily: FONT, fontSize: 15, fontWeight: 600,
        padding: '4px 10px 4px 0', marginBottom: 4, marginLeft: -2,
      }}>
        <Icon name="back" size={20} /> {t('find_back')}
      </button>
      <div style={{ paddingTop: 4, marginBottom: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          {/* Brand wordmark treatment (cousin of the home header). */}
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: -0.8, color: C.text }}>
            {lang === 'zh' ? '找' : 'Find '}
            <span style={{ color: C.primary, position: 'relative', display: 'inline-block' }}>
              {lang === 'zh' ? '商品' : 'item'}
              <svg viewBox="0 0 100 12" aria-hidden style={{
                position: 'absolute', left: 0, right: 0, bottom: -7, width: '100%', height: 8,
              }}>
                <path d="M4 8 C 28 3, 64 3, 96 6" stroke={C.accent} strokeWidth="6"
                  fill="none" strokeLinecap="round" />
              </svg>
            </span>
          </h1>
          <p style={{ color: C.textMuted, fontSize: 15.5, margin: '12px 0 0', fontWeight: 500 }}>
            {lang === 'zh' ? (
              <>顾客在<b style={{ color: C.primaryDark, fontWeight: 800 }}>找什么</b>？</>
            ) : (
              <>What are they <b style={{ color: C.primaryDark, fontWeight: 800 }}>looking for</b>?</>
            )}
          </p>
        </div>
        <LanguageToggle />
      </div>

      {/* The search bar is hidden on the result page — typing there and then
          tapping "Search again" silently discarded the input (the button
          resets the screen). One entry point per phase avoids the trap. */}
      {phase !== 'result' && (
      <div style={{ position: 'relative', marginTop: 34 }}>
        {/* Mascot lying on top of the search bar (background flood-filled to
            real transparency at build time of the asset). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/searchbar-bear.png" alt="" aria-hidden style={{
          position: 'absolute', right: 12, top: -37, width: 172,
          pointerEvents: 'none', zIndex: 1,
        }} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, background: C.white,
        border: `1px solid ${C.border}`, borderRadius: 16, padding: '12px 14px',
        boxShadow: SHADOW, position: 'relative',
      }}>
        <Icon name="search" size={20} style={{ color: C.textMuted }} />
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(q); }}
          placeholder="e.g. 年糕 or black paper for sushi"
          style={{
            flex: 1, border: 'none', outline: 'none', fontFamily: FONT,
            fontSize: 16, color: C.text, background: 'transparent',
          }}
        />
        {q && (
          <button onClick={() => setQ('')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
            <Icon name="x-circle" size={22} />
          </button>
        )}
      </div>
      </div>
      )}

      {/* Result page: show the searched query as a static caption instead. */}
      {phase === 'result' && q && (
        <div style={{
          marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 7,
          fontSize: 14.5, color: C.textMuted, fontWeight: 600,
        }}>
          <Icon name="search" size={15} style={{ color: C.textSoft }} />
          “{q}”
        </div>
      )}

      {phase === 'input' && (
        <>
          {/* Sample queries — one-tap demo of the multilingual search. Picked
              to show one CJK term, one brand misspelling-ish word, and one
              plain-English description; all verified to hit in the live index. */}
          {heard === null && (
            /* Single row, horizontal scroll — never wraps to a second line. */
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
              overflowX: 'auto', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch',
              margin: '12px -20px 0', padding: '0 20px 5px',
            }}>
              <span style={{ fontSize: 12.5, color: C.textSoft, fontWeight: 700, flexShrink: 0 }}>{t('find_suggestions')}</span>
              {['年糕', '可乐', 'samyang', 'spicy noodle'].map(s => (
                /* Flat sticker chips — bold border only; four offset shadows
                   in a row read as visual noise. */
                <button key={s} onClick={() => submit(s)} style={{
                  background: C.white, color: C.primaryDark, border: `2px solid ${C.border}`,
                  borderRadius: 999, padding: '6px 13px', cursor: 'pointer',
                  fontFamily: FONT, fontSize: 13.5, fontWeight: 700,
                  flexShrink: 0, whiteSpace: 'nowrap',
                }}>{s}</button>
              ))}
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            {heard !== null ? (
              /* Confirm step (shared by voice + photo): show what we recognized,
                 search only on confirm. */
              <div style={{
                background: C.accentTint, border: `1px solid ${C.accentChip}`,
                borderRadius: 16, padding: '14px 16px', animation: 'fade .2s ease',
              }}>
                <div style={{
                  fontSize: 12, fontWeight: 700, color: C.accentDark,
                  textTransform: 'uppercase', letterSpacing: 0.4,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <Icon name="sparkle" size={13} /> {t('voice_heard')}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginTop: 6, lineHeight: 1.3 }}>
                  {lang === 'en' && heardEn ? (
                    <>
                      &ldquo;{heardEn}&rdquo;
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: C.textMuted, marginTop: 2 }}>{heard}</span>
                    </>
                  ) : (
                    <>&ldquo;{heard}&rdquo;</>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button
                    onClick={() => { const v = q.trim() || heard || ''; setHeard(null); submit(v); }}
                    style={{
                      flex: 1, padding: '12px 0', background: C.primary, color: C.text, border: `2px solid ${C.border}`,
                      borderRadius: 14, fontFamily: FONT, fontSize: 15, fontWeight: 800, cursor: 'pointer', boxShadow: SHADOW,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                    }}
                  >
                    <Icon name="search" size={16} /> {t('voice_search_this')}
                  </button>
                  <button
                    onClick={() => { setHeard(null); setVoiceErr(null); }}
                    style={{
                      padding: '12px 18px', background: C.white, color: C.text,
                      border: `2px solid ${C.border}`, borderRadius: 14,
                      fontFamily: FONT, fontSize: 15, fontWeight: 800, cursor: 'pointer',
                    }}
                  >
                    {t('voice_retry')}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: C.accentDark, marginTop: 10, lineHeight: 1.4 }}>
                  {t('voice_confirm_hint')}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                {supported && (
                  /* Walkie-talkie: hold to talk, release → upload → confirm. */
                  <button
                    onPointerDown={(e) => { e.preventDefault(); if (!transcribing && !identifying) startVoice(); }}
                    onPointerUp={(e) => { e.preventDefault(); stop(); }}
                    onPointerLeave={() => { if (recording) stop(); }}
                    onContextMenu={(e) => e.preventDefault()}
                    disabled={transcribing || identifying}
                    style={{
                      flex: 1, minWidth: 0, padding: '13px 6px', borderRadius: 999,
                      background: recording ? '#c0392b' : transcribing ? C.bgMuted : C.primarySofter,
                      color: recording ? '#fff' : transcribing ? C.textMuted : C.primaryDark,
                      border: recording ? 'none' : `2px solid ${C.border}`,
                      fontFamily: FONT, fontSize: 14, fontWeight: 700,
                      cursor: transcribing ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
                      boxShadow: recording ? '0 0 0 5px rgba(192,57,43,0.18)' : 'none',
                      transition: 'background .15s, box-shadow .15s',
                    }}
                  >
                    <span style={{ display: 'inline-flex', flexShrink: 0, animation: (recording || transcribing) ? 'pulse 1.2s ease-in-out infinite' : 'none' }}>
                      <Icon name={transcribing ? 'dots' : 'mic'} size={recording ? 18 : 17} />
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {recording ? t('voice_recording') : transcribing ? t('voice_transcribing') : t('voice_hold')}
                    </span>
                  </button>
                )}
                {/* Find by photo: snap/choose a product photo → Gemini names it. */}
                <button
                  onClick={() => { if (!identifying && !recording && !transcribing) photoInputRef.current?.click(); }}
                  disabled={identifying || recording || transcribing}
                  style={{
                    flex: 1, minWidth: 0, padding: '13px 6px', borderRadius: 999,
                    background: identifying ? C.bgMuted : C.accentTint,
                    color: identifying ? C.textMuted : C.accentDark,
                    border: `2px solid ${C.border}`,
                    fontFamily: FONT, fontSize: 14, fontWeight: 700,
                    cursor: identifying ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                >
                  <span style={{ display: 'inline-flex', flexShrink: 0, animation: identifying ? 'pulse 1.2s ease-in-out infinite' : 'none' }}>
                    <Icon name={identifying ? 'dots' : 'camera'} size={17} />
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {identifying ? t('photo_identifying') : t('photo_btn')}
                  </span>
                </button>
              </div>
            )}
            {voiceErr && (
              <div style={{ fontSize: 13, color: '#c0392b', marginTop: 8, fontWeight: 500, textAlign: 'center' }}>
                {voiceErr}
              </div>
            )}
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhoto}
            style={{ display: 'none' }}
          />

          {heard === null && <button onClick={() => submit(q)} disabled={!q.trim()} style={{
            width: '100%', marginTop: 26, padding: '17px 0',
            background: q.trim() ? C.primary : C.bgMuted,
            color: q.trim() ? C.text : C.textSoft, border: `2px solid ${C.border}`, borderRadius: 16,
            fontFamily: FONT, fontSize: 17, fontWeight: 800,
            cursor: q.trim() ? 'pointer' : 'not-allowed',
            boxShadow: q.trim() ? SHADOW : 'none',
            transition: 'background .2s',
          }}>Ask the bear</button>}
        </>
      )}

      {phase === 'searching' && lang === 'zh' && earlyName && (
        <div style={{
          marginTop: 18, background: C.primarySofter, border: `1px solid ${C.primarySoft}`,
          borderRadius: 18, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
          animation: 'rise .35s ease-out',
        }}>
          <BearFace size={60} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.primaryDark, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {t('find_likely')}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginTop: 3, lineHeight: 1.2 }}>
              {earlyName}
            </div>
          </div>
          <span style={{ fontSize: 12, color: C.textMuted, display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.primary, animation: 'pulse 1.4s ease-in-out infinite' }} />
            {t('find_locating')}
          </span>
        </div>
      )}
      {/* Gap-filler while the agent warms up — the home-page bear, sniffing.
          Disappears the moment the first thinking-panel step streams in. */}
      {phase === 'searching' && steps.length === 0 && (
        <div style={{
          marginTop: 36, display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 12, animation: 'fade .3s ease',
        }}>
          <AnimatedBear size={108} />
          <div style={{ display: 'flex', gap: 7 }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 8, height: 8, borderRadius: '50%', background: C.primary,
                animation: 'pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.18}s`,
              }} />
            ))}
          </div>
          <div style={{ fontSize: 13.5, color: C.textMuted, fontWeight: 600 }}>
            {t('find_loading')}
          </div>
        </div>
      )}

      {(phase === 'searching' || phase === 'result') && (
        <ThinkingPanel steps={steps} searching={phase === 'searching'} />
      )}

      {phase === 'result' && error && (
        <div style={{
          marginTop: 18, padding: '14px 16px', background: '#fee', border: '1px solid #fcc',
          borderRadius: 14, color: '#933', fontSize: 13.5, fontWeight: 500,
        }}>
          {friendlyError(error, t)}
        </div>
      )}

      {phase === 'result' && !error && finish && (
        <ResultCard
          candidates={finish.candidates ?? (finish.product ? [finish.product] : [])}
          guesses={finish.guesses ?? []}
          answerEn={finish.answer_en || finish.answer || ''}
          answerZh={finish.answer_zh || ''}
          onAgain={reset}
          go={go}
        />
      )}

      {phase === 'input' && (
        <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
          <BearFace size={68} />
        </div>
      )}
    </div>
  );
}

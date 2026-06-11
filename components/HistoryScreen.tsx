'use client';

import { useEffect, useState } from 'react';
import { C, FONT } from '@/lib/theme';
import Icon from './Icon';
import BearFace from './BearFace';
import { relativeTime } from '@/lib/time';

interface Activity {
  type: 'snap' | 'find';
  title: string;
  subtitle?: string;
  timestamp: string;
}

export default function HistoryScreen() {
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setActivity(null);
    setError(null);
    fetch('/api/activity')
      .then(r => r.json())
      .then(d => {
        if (d.ok) setActivity(d.items as Activity[]);
        else setError(d.error || 'Failed to load');
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => { load(); }, []);

  return (
    <div style={{ padding: '70px 22px 130px', fontFamily: FONT, color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14 }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: -0.8 }}>History</h1>
        <button onClick={load} style={{
          background: C.bgMuted, border: `1px solid ${C.border}`, borderRadius: 999,
          padding: '6px 14px', fontFamily: FONT, fontSize: 13, fontWeight: 600,
          color: C.textMuted, cursor: 'pointer',
        }}>Refresh</button>
      </div>
      <p style={{ color: C.textMuted, fontSize: 15, margin: '6px 0 22px', fontWeight: 500 }}>
        Everything the bear has seen and answered.
      </p>

      {error && (
        <div style={{
          padding: '12px 16px', background: '#fee', border: '1px solid #fcc',
          borderRadius: 14, color: '#933', fontSize: 13.5,
        }}>{error}</div>
      )}

      {activity === null && !error && (
        <div style={{ padding: 30, textAlign: 'center', color: C.textMuted }}>
          Loading…
        </div>
      )}

      {activity && activity.length === 0 && (
        <div style={{
          background: C.accentTint, borderRadius: 22, padding: 28,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          border: `1px solid ${C.accentChip}`,
        }}>
          <BearFace size={110} />
          <div style={{ fontSize: 15, fontWeight: 600, color: C.accentDark, textAlign: 'center' }}>
            Nothing here yet.<br />Snap a shelf to teach the bear.
          </div>
        </div>
      )}

      {activity && activity.length > 0 && (
        <div style={{ background: C.white, borderRadius: 18, border: `1px solid ${C.border}` }}>
          {activity.map((a, i) => {
            const styles = {
              snap: { bg: C.primarySofter, fg: C.primaryDark, icon: 'camera' },
              find: { bg: C.accentChip, fg: C.accentDark, icon: 'search' },
            } as const;
            const s = styles[a.type];
            return (
              <div key={`${a.timestamp}-${i}`} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                borderTop: i ? `1px solid ${C.border}` : 'none',
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 12, background: s.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: s.fg, flexShrink: 0,
                }}>
                  <Icon name={s.icon} size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 600, color: C.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{a.title}</div>
                  <div style={{ fontSize: 12, color: C.textSoft, marginTop: 1 }}>
                    {a.subtitle ? `${a.subtitle} · ${relativeTime(a.timestamp)}` : relativeTime(a.timestamp)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

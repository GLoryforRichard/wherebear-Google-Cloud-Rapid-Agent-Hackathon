'use client';

import { useEffect, useState } from 'react';
import { C, FONT } from '@/lib/theme';
import BearFace from './BearFace';
import Icon from './Icon';
import LanguageToggle from './LanguageToggle';
import { relativeTime } from '@/lib/time';
import { useTranslation } from '@/lib/i18n';

type Screen = 'home' | 'snap' | 'progress' | 'find';

interface HomeScreenProps {
  go: (screen: Screen) => void;
}

interface Activity {
  type: 'snap' | 'find';
  title: string;
  subtitle?: string;
  timestamp: string;
}

function ActionCard({
  icon, title, subtitle, onClick, bg, iconBg, iconColor, chevBg, chevColor,
}: {
  icon: string; title: string; subtitle: string; onClick: () => void;
  bg: string; iconBg: string; iconColor: string; chevBg?: string; chevColor?: string;
}) {
  return (
    <button onClick={onClick} style={{
      width: '100%', background: bg, border: 'none', borderRadius: 22,
      padding: 14, display: 'flex', alignItems: 'center', gap: 14,
      fontFamily: FONT, cursor: 'pointer', textAlign: 'left',
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: 18, background: iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: iconColor, flexShrink: 0,
      }}>
        <Icon name={icon} size={34} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{title}</div>
        <div style={{ fontSize: 14, color: C.textMuted, marginTop: 2, lineHeight: 1.3, maxWidth: 200 }}>{subtitle}</div>
      </div>
      <div style={{
        width: 38, height: 38, borderRadius: 19, background: chevBg || iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: chevColor || iconColor, flexShrink: 0,
      }}>
        <Icon name="chevron-right" size={20} />
      </div>
    </button>
  );
}

function ActivityRow({
  tone, title, subtitle, time, border,
}: {
  tone: 'snap' | 'find';
  title: string;
  subtitle?: string;
  time: string;
  border?: boolean;
}) {
  const styles = {
    snap: { bg: C.primarySofter, fg: C.primaryDark, icon: 'camera' },
    find: { bg: C.accentChip, fg: C.accentDark, icon: 'search' },
  };
  const s = styles[tone];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
      borderTop: border ? `1px solid ${C.border}` : 'none',
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
        }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textSoft, marginTop: 1 }}>
          {subtitle ? `${subtitle} · ${time}` : time}
        </div>
      </div>
      <Icon name="chevron-right" size={16} style={{ color: C.textSoft, flexShrink: 0 }} />
    </div>
  );
}

export default function HomeScreen({ go }: HomeScreenProps) {
  const { t } = useTranslation();
  const [activity, setActivity] = useState<Activity[] | null>(null);
  useEffect(() => {
    fetch('/api/activity')
      .then(r => r.json())
      .then(d => { if (d.ok) setActivity(d.items as Activity[]); })
      .catch(() => setActivity([]));
  }, []);

  return (
    <div style={{ padding: '70px 22px 130px', fontFamily: FONT, color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 14 }}>
        <div>
          <h1 style={{ fontSize: 38, fontWeight: 800, lineHeight: 1, margin: 0, letterSpacing: -1.2, position: 'relative', display: 'inline-block' }}>
            {t('app_name')}
            <Icon name="sparkle" size={14} style={{ position: 'absolute', top: -6, right: -16, color: C.accent }} />
          </h1>
          <p style={{ color: C.textMuted, fontSize: 16, margin: '10px 0 0', fontWeight: 500 }}>{t('home_tagline')}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <LanguageToggle />
          <BearFace size={64} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 28 }}>
        <ActionCard
          icon="camera" title={t('snap')}
          subtitle={t('home_snap_desc')}
          bg={C.primarySofter} iconBg={C.primarySoft} iconColor={C.primaryDark}
          onClick={() => go('snap')}
        />
        <ActionCard
          icon="search" title={t('find')}
          subtitle={t('home_find_desc')}
          bg={C.accentTint} iconBg={C.accentChip} iconColor={C.accentDark}
          chevColor={C.accentDark} chevBg={C.accentChip}
          onClick={() => go('find')}
        />
      </div>

      <div style={{
        marginTop: 18, background: C.accentBg, borderRadius: 22,
        padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 22, background: '#fff8e0',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.accentDark,
          flexShrink: 0, border: `1px solid ${C.accentChip}`,
        }}>
          <Icon name="bars" size={22} />
        </div>
        <div style={{ flex: 1, fontSize: 14.5, lineHeight: 1.35, color: C.text, fontWeight: 500 }}>
          {t('home_smarter')}
        </div>
        <div style={{ flexShrink: 0, position: 'relative' }}>
          <Icon name="sparkle" size={14} style={{ position: 'absolute', top: -2, left: -10, color: C.accent }} />
          <Icon name="sparkle" size={10} style={{ position: 'absolute', top: 8, left: -2, color: C.accent2 }} />
          <BearFace size={56} />
        </div>
      </div>

      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <h3 style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, margin: 0, textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('home_recent')}</h3>
          <span style={{ fontSize: 13, color: C.primary, fontWeight: 600, cursor: 'pointer' }}>See all</span>
        </div>
        <div style={{ background: C.white, borderRadius: 18, border: `1px solid ${C.border}` }}>
          {activity === null && (
            <div style={{ padding: '14px 16px', color: C.textMuted, fontSize: 13.5 }}>
              Loading…
            </div>
          )}
          {activity && activity.length === 0 && (
            <div style={{ padding: '16px', color: C.textMuted, fontSize: 13.5, textAlign: 'center' }}>
              {t('home_no_activity')}
            </div>
          )}
          {activity && activity.slice(0, 4).map((a, i) => (
            <ActivityRow
              key={`${a.timestamp}-${i}`}
              tone={a.type}
              title={a.title}
              subtitle={a.subtitle}
              time={relativeTime(a.timestamp)}
              border={i > 0}
            />
          ))}
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
        marginTop: 18,
      }}>
        <a href="/admin" style={{
          padding: '10px 14px',
          background: C.bgMuted, border: `1px dashed ${C.border}`, borderRadius: 12,
          color: C.textMuted, fontSize: 12, fontWeight: 600,
          textAlign: 'center', textDecoration: 'none',
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          letterSpacing: 0.3,
        }}>
          ✎ SHELF ADMIN
        </a>
        <a href="/debug" style={{
          padding: '10px 14px',
          background: C.bgMuted, border: `1px dashed ${C.border}`, borderRadius: 12,
          color: C.textMuted, fontSize: 12, fontWeight: 600,
          textAlign: 'center', textDecoration: 'none',
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          letterSpacing: 0.3,
        }}>
          ⚙ DB DEBUG
        </a>
      </div>
    </div>
  );
}

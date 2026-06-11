'use client';

import { useState } from 'react';
import { C, FONT, SHADOW } from '@/lib/theme';
import SnapScreen, { SnapPayload } from '@/components/SnapScreen';
import ProgressScreen from '@/components/ProgressScreen';
import FindScreen from '@/components/FindScreen';
import ShelfAdmin from '@/components/ShelfAdmin';
import PasscodeGate from '@/components/PasscodeGate';
import BearFace from '@/components/BearFace';
import Icon from '@/components/Icon';
import LanguageToggle from '@/components/LanguageToggle';
import { useTranslation } from '@/lib/i18n';

// Workspace-level screens. The "menu" is the staff landing page; the rest are
// the add/manage/test flows that used to live on the public home screen.
type AdminScreen = 'menu' | 'snap' | 'progress' | 'find' | 'shelves';
// Vocabulary the shared child components (Snap/Progress/Find) speak.
type ChildScreen = 'home' | 'snap' | 'progress' | 'find';

// Small dashed "pill" used for secondary tools (Shelf admin, DB debug, exit).
const pillStyle: React.CSSProperties = {
  padding: '10px 14px', background: C.bgMuted, border: `1px dashed ${C.border}`,
  borderRadius: 12, color: C.textMuted, fontSize: 12, fontWeight: 600,
  textDecoration: 'none', cursor: 'pointer',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', letterSpacing: 0.3,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
};

function MenuCard({
  icon, title, subtitle, onClick, bg, iconBg, iconColor,
}: {
  icon: string; title: string; subtitle: string; onClick: () => void;
  bg: string; iconBg: string; iconColor: string;
}) {
  return (
    <button onClick={onClick} style={{
      width: '100%', background: bg, border: `2px solid ${C.border}`, borderRadius: 20,
      padding: 14, display: 'flex', alignItems: 'center', gap: 14,
      fontFamily: FONT, cursor: 'pointer', textAlign: 'left', boxShadow: SHADOW,
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16, background: iconBg, border: `2px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: iconColor, flexShrink: 0,
      }}>
        <Icon name={icon} size={30} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: C.textMuted, marginTop: 2, lineHeight: 1.3 }}>{subtitle}</div>
      </div>
      <div style={{
        width: 34, height: 34, borderRadius: 12, background: iconBg, border: `2px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: iconColor, flexShrink: 0,
      }}>
        <Icon name="chevron-right" size={18} />
      </div>
    </button>
  );
}

export default function AdminWorkspace() {
  const { t, lang } = useTranslation();
  const [screen, setScreen] = useState<AdminScreen>('menu');
  const [snapPayload, setSnapPayload] = useState<SnapPayload | null>(null);

  // Snap/Progress/Find call go('home') to back out. In the workspace that
  // returns to the staff menu; snap/progress/find map 1:1.
  const childGo = (s: ChildScreen) => {
    setScreen(s === 'home' ? 'menu' : s);
  };

  const content = (() => {
    if (screen === 'shelves') {
      return <ShelfAdmin onBack={() => setScreen('menu')} />;
    }

    if (screen === 'snap' || screen === 'progress' || screen === 'find') {
      const childBg = screen === 'progress' ? C.bgMuted : C.bg;
      const node =
        screen === 'snap' ? <SnapScreen go={childGo} onSubmit={setSnapPayload} />
        : screen === 'progress' ? <ProgressScreen go={childGo} payload={snapPayload} />
        : <FindScreen go={childGo} />;
      return (
        <div style={{ minHeight: '100dvh', background: childBg }}>
          <div key={screen} style={{ minHeight: '100dvh', background: childBg, animation: 'fade .25s ease' }}>
            {node}
          </div>
        </div>
      );
    }

    // menu
    return (
      <div style={{ minHeight: '100dvh', background: C.bg }}>
        <div style={{ padding: '64px 22px 80px', fontFamily: FONT, color: C.text, animation: 'fade .25s ease' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              {/* Brand wordmark treatment (cousin of the home header): second
                  word in brand orange with a yellow marker stroke under it. */}
              <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: -0.8, lineHeight: 1.05, position: 'relative', display: 'inline-block', color: C.text }}>
                {lang === 'zh' ? '员工' : 'Staff '}
                <span style={{ color: C.primary, position: 'relative', display: 'inline-block' }}>
                  {lang === 'zh' ? '工作台' : 'workspace'}
                  <svg viewBox="0 0 100 12" aria-hidden style={{
                    position: 'absolute', left: 0, right: 0, bottom: -7, width: '100%', height: 8,
                  }}>
                    <path d="M4 8 C 28 3, 64 3, 96 6" stroke={C.accent} strokeWidth="6"
                      fill="none" strokeLinecap="round" />
                  </svg>
                </span>
                <Icon name="sparkle" size={12} style={{ position: 'absolute', top: -5, right: -13, color: C.accent }} />
              </h1>
              <p style={{ color: C.textMuted, fontSize: 15, margin: '12px 0 0', fontWeight: 500, lineHeight: 1.35, maxWidth: 280 }}>
                {lang === 'zh' ? (
                  <>添加<b style={{ color: C.primaryDark, fontWeight: 800 }}>货架</b>、管理已存<b style={{ color: C.primaryDark, fontWeight: 800 }}>商品</b>、试搜一下。</>
                ) : (
                  <>Add <b style={{ color: C.primaryDark, fontWeight: 800 }}>shelves</b>, manage saved <b style={{ color: C.primaryDark, fontWeight: 800 }}>products</b>, try a <b style={{ color: C.primaryDark, fontWeight: 800 }}>search</b>.</>
                )}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
              <LanguageToggle />
              <BearFace size={76} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 26 }}>
            <MenuCard
              icon="camera" title={t('snap')} subtitle={t('home_snap_desc')}
              bg={C.primarySofter} iconBg={C.primarySoft} iconColor={C.primaryDark}
              onClick={() => setScreen('snap')}
            />
            <MenuCard
              icon="search" title={t('admin_test_title')} subtitle={t('admin_test_desc')}
              bg={C.accentTint} iconBg={C.accentChip} iconColor={C.accentDark}
              onClick={() => setScreen('find')}
            />
          </div>

          {/* Secondary tools — small dashed pills with line icons (matches the
              app's icon set instead of platform emoji). */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 18 }}>
            <button onClick={() => setScreen('shelves')} style={pillStyle}>
              <Icon name="map" size={14} /> {t('admin_manage_title')}
            </button>
            <a href="/dashboard" style={pillStyle}>
              <Icon name="bars" size={14} /> {t('admin_dashboard')}
            </a>
            <a href="/searchlog" style={pillStyle}>
              <Icon name="clock" size={14} /> {t('admin_searchlog')}
            </a>
            <a href="/" style={pillStyle}>
              <Icon name="home" size={14} /> {t('admin_customer_view')}
            </a>
          </div>
        </div>
      </div>
    );
  })();

  return (
    <PasscodeGate passcode="2627" storageKey="wherebear:staff-unlocked" cancelHref="/">
      {content}
    </PasscodeGate>
  );
}

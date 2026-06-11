'use client';

import { useState, useEffect } from 'react';
import { C, FONT, SHADOW } from '@/lib/theme';
import FindScreen from '@/components/FindScreen';
import AnimatedBear from '@/components/AnimatedBear';
import Icon from '@/components/Icon';
import LanguageToggle from '@/components/LanguageToggle';
import { useTranslation } from '@/lib/i18n';

// Public surface is intentionally tiny: a customer/floor-staff member lands
// here and the only thing to do is search. Everything that adds or mutates
// store memory (Snap, Progress, Shelf admin, DB debug) now lives under /admin.
type CustomerScreen = 'home' | 'find';
type ChildScreen = 'home' | 'snap' | 'progress' | 'find';

interface HomeSummary {
  products: number;
  todaySearches: number;
  hitRate: number | null;
  lastFound: string | null;
}

export default function Page() {
  const { t, lang } = useTranslation();
  const [screen, setScreen] = useState<CustomerScreen>('home');
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    fetch('/api/home-summary')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setSummary(d as HomeSummary); })
      .catch(() => {});
  }, []);

  // FindScreen only ever calls go('home') to back out. Anything that isn't
  // 'find' returns to the customer home.
  const childGo = (s: ChildScreen) => setScreen(s === 'find' ? 'find' : 'home');

  if (screen === 'find') {
    return (
      <div style={{ minHeight: '100dvh', background: C.bg }}>
        <div key="find" style={{ minHeight: '100dvh', background: C.bg, animation: 'fade .25s ease' }}>
          <FindScreen go={childGo} />
        </div>
      </div>
    );
  }

  const statCard = (value: string, label: string, small = false) => (
    <div style={{
      flex: 1, minWidth: 0, background: C.white, border: `2px solid ${C.border}`,
      borderRadius: 14, boxShadow: SHADOW, padding: '13px 8px', textAlign: 'center',
    }}>
      <div style={small ? {
        fontSize: 13.5, fontWeight: 800, color: C.primaryDark, lineHeight: 1.15,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      } : {
        fontSize: 21, fontWeight: 800, color: C.primaryDark, lineHeight: 1, letterSpacing: -0.6,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value}</div>
      <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 5, fontWeight: 600, lineHeight: 1.2 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ minHeight: '100dvh', background: C.pageBg }}>
      <div style={{
        padding: '60px 22px 44px', fontFamily: FONT, color: C.text,
        animation: 'fade .25s ease', display: 'flex', flexDirection: 'column', minHeight: '100dvh',
      }}>
        {/* Brand header — wordmark treatment: two-tone "Where|bear" with a
            marker underline under "bear", and the mascot mounted as a white
            sticker badge (border + hard shadow) so it shares the card language
            instead of floating on the cream. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 style={{
              fontSize: 40, fontWeight: 800, lineHeight: 1, margin: 0, letterSpacing: -1.2,
              position: 'relative', display: 'inline-block', color: C.text,
            }}>
              Where<span style={{ color: C.primary, position: 'relative', display: 'inline-block' }}>
                bear
                {/* hand-drawn marker stroke in the second brand color */}
                <svg viewBox="0 0 100 12" aria-hidden style={{
                  position: 'absolute', left: 0, right: 0, bottom: -9, width: '100%', height: 10,
                }}>
                  <path d="M4 8 C 28 3, 64 3, 96 6" stroke={C.accent} strokeWidth="6"
                    fill="none" strokeLinecap="round" />
                </svg>
              </span>
              <Icon name="sparkle" size={14} style={{ position: 'absolute', top: -6, right: -16, color: C.accent }} />
            </h1>
            <p style={{ color: C.textMuted, fontSize: 16, margin: '16px 0 0', fontWeight: 500 }}>
              {lang === 'zh' ? (
                t('home_tagline')
              ) : (
                <>Ask the <b style={{ color: C.primaryDark, fontWeight: 800 }}>bear</b>. Find the <b style={{ color: C.primaryDark, fontWeight: 800 }}>aisle</b>.</>
              )}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
            <LanguageToggle />
            <div style={{
              width: 112, height: 112, borderRadius: '50%', overflow: 'hidden',
              background: C.white, border: `2px solid ${C.border}`, boxShadow: SHADOW,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <AnimatedBear size={104} />
            </div>
          </div>
        </div>

        {/* Dashboard stat cards — fill the page + show scale/activity */}
        <div style={{ display: 'flex', gap: 10, marginTop: 26 }}>
          {statCard(summary ? summary.products.toLocaleString('en-US') : '—', t('home_stat_products'))}
          {statCard(summary ? String(summary.todaySearches) : '—', t('home_stat_today'))}
          {statCard(summary?.lastFound ?? '—', t('home_stat_last'), true)}
        </div>

        {/* The one and only entry: Find an item */}
        <button
          onClick={() => setScreen('find')}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            width: '100%', background: C.accentTint, border: `2px solid ${C.border}`, borderRadius: 20,
            padding: '24px 22px', display: 'flex', alignItems: 'center', gap: 18,
            fontFamily: FONT, cursor: 'pointer', textAlign: 'left', marginTop: 16,
            boxShadow: hover ? '7px 7px 0 #111' : SHADOW,
            transform: hover ? 'translate(-2px, -2px)' : 'none',
            transition: 'transform .14s ease, box-shadow .14s ease',
          }}
        >
          <div style={{
            width: 84, height: 84, borderRadius: 16, background: C.accent, border: `2px solid ${C.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text, flexShrink: 0,
          }}>
            <Icon name="search" size={42} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.text, letterSpacing: -0.4 }}>{t('find')}</div>
            <div style={{ fontSize: 14.5, color: C.textMuted, marginTop: 4, lineHeight: 1.35 }}>{t('cust_find_desc')}</div>
          </div>
          <div style={{
            width: 40, height: 40, borderRadius: 12, background: C.primary, border: `2px solid ${C.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text, flexShrink: 0,
          }}>
            <Icon name="chevron-right" size={22} />
          </div>
        </button>

        {/* One-line orientation for first-time visitors (hackathon judges):
            both self-serve demo paths work without a real shelf at hand. */}
        <div style={{
          marginTop: 14, padding: '10px 14px',
          background: C.bgMuted, border: `1px dashed ${C.border}`, borderRadius: 12,
          color: C.textMuted, fontSize: 13, fontWeight: 600, lineHeight: 1.45,
        }}>
          {t('home_judges_hint')}
        </div>

        <div style={{ flex: 1 }} />

        {/* Staff entry → /admin. Deliberately prominent, with the demo
            passcode printed right here so judges never hit a dead end. */}
        <div style={{ marginTop: 30 }}>
          <a href="/admin" style={{
            width: '100%', boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            padding: '15px 18px', background: C.white, border: `2px solid ${C.border}`,
            borderRadius: 16, color: C.text, fontSize: 16, fontWeight: 800,
            textDecoration: 'none', boxShadow: SHADOW, fontFamily: FONT,
          }}>
            <Icon name="settings" size={19} /> {t('staff_entry')}
            <Icon name="chevron-right" size={18} style={{ color: C.textMuted }} />
          </a>
          <div style={{
            marginTop: 8, textAlign: 'center',
            fontSize: 12.5, color: C.textMuted, fontWeight: 600, lineHeight: 1.4,
          }}>
            {t('staff_demo_code')}
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { C, FONT } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';

/**
 * Two-state pill toggle: EN | 中. Persists to localStorage and broadcasts a
 * `wherebear:langchange` event so every screen re-renders together.
 */
export default function LanguageToggle({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { lang, setLang } = useTranslation();
  const isZh = lang === 'zh';

  const padY = size === 'md' ? 6 : 4;
  const padX = size === 'md' ? 11 : 9;
  const font = size === 'md' ? 13 : 12;

  return (
    <div
      role="group"
      aria-label="Language"
      style={{
        display: 'inline-flex', background: C.white,
        border: `1px solid ${C.border}`, borderRadius: 999,
        padding: 2, fontFamily: FONT, boxShadow: '0 1px 3px rgba(20,40,20,0.04)',
      }}
    >
      {(['en', 'zh'] as const).map(code => {
        const active = code === lang;
        const label = code === 'en' ? 'EN' : '中';
        return (
          <button
            key={code}
            onClick={() => setLang(code)}
            aria-pressed={active}
            style={{
              padding: `${padY}px ${padX}px`,
              background: active ? C.primary : 'transparent',
              color: active ? '#fff' : C.textMuted,
              border: 'none', borderRadius: 999,
              fontSize: font, fontWeight: 800,
              cursor: 'pointer',
              fontFamily: code === 'zh'
                ? '"PingFang SC", "Hiragino Sans GB", system-ui, sans-serif'
                : 'inherit',
              transition: 'background .15s, color .15s',
              minWidth: 30,
            }}
          >
            {label}
          </button>
        );
      })}
      {/* Hide chrome warning about unused var; placeholder for future "auto" */}
      <span style={{ display: 'none' }}>{isZh ? '中' : 'EN'}</span>
    </div>
  );
}

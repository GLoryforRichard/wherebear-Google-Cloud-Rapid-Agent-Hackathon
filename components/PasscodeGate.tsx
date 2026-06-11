'use client';

import { useState, useEffect, useCallback } from 'react';
import { C, FONT } from '@/lib/theme';
import Icon from './Icon';
import { useTranslation } from '@/lib/i18n';

interface PasscodeGateProps {
  passcode: string;
  storageKey: string;
  cancelHref?: string;
  children: React.ReactNode;
}

/**
 * iPhone-style passcode gate. Renders `children` only once the correct
 * passcode has been entered (or was entered earlier this session). This is a
 * lightweight "don't wander in by accident" guard for staff-only screens —
 * NOT real security (the code ships in the client bundle).
 */
export default function PasscodeGate({
  passcode, storageKey, cancelHref = '/', children,
}: PasscodeGateProps) {
  const { t } = useTranslation();
  const [unlocked, setUnlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [entry, setEntry] = useState('');
  const [error, setError] = useState(false);

  // Read the session flag client-side only (keeps SSR/CSR markup identical
  // until the effect runs, avoiding a hydration mismatch).
  useEffect(() => {
    try {
      if (sessionStorage.getItem(storageKey) === '1') setUnlocked(true);
    } catch { /* sessionStorage may be unavailable */ }
    setReady(true);
  }, [storageKey]);

  const submit = useCallback((code: string) => {
    if (code === passcode) {
      try { sessionStorage.setItem(storageKey, '1'); } catch { /* ignore */ }
      setUnlocked(true);
    } else {
      setError(true);
      setTimeout(() => { setEntry(''); setError(false); }, 480);
    }
  }, [passcode, storageKey]);

  const press = useCallback((d: string) => {
    setError(false);
    setEntry(prev => {
      if (prev.length >= passcode.length) return prev;
      const next = prev + d;
      // Defer the check one tick so the last dot paints before we react.
      if (next.length === passcode.length) setTimeout(() => submit(next), 130);
      return next;
    });
  }, [passcode.length, submit]);

  const del = useCallback(() => {
    setError(false);
    setEntry(prev => prev.slice(0, -1));
  }, []);

  // Physical keyboard: digits type, Backspace deletes.
  useEffect(() => {
    if (unlocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') press(e.key);
      else if (e.key === 'Backspace') del();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [unlocked, press, del]);

  if (!ready) return null;            // avoid a flash of the locked UI
  if (unlocked) return <>{children}</>;

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <div style={{
      minHeight: '100dvh', background: C.bg, fontFamily: FONT,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '40px 24px',
    }}>
      <div style={{
        width: 58, height: 58, borderRadius: 29, background: C.primarySofter,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: C.primaryDark, marginBottom: 16,
      }}>
        <Icon name="settings" size={27} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>
        {t('passcode_title')}
      </div>
      <div style={{ fontSize: 14, color: C.textMuted, marginTop: 4 }}>
        {t('passcode_hint')}
      </div>
      {/* Demo deployment: surface the code right on the lock screen so
          judges/visitors are never blocked. Remove for a real store. */}
      <div style={{
        marginTop: 10, padding: '7px 14px', borderRadius: 999,
        background: C.primarySofter, color: C.primaryDark,
        fontSize: 12.5, fontWeight: 700, textAlign: 'center', lineHeight: 1.4,
      }}>
        {t('staff_demo_code')}
      </div>

      {/* Passcode dots */}
      <div style={{
        display: 'flex', gap: 18, margin: '28px 0 32px',
        animation: error ? 'shake 0.42s' : 'none',
      }}>
        {Array.from({ length: passcode.length }).map((_, i) => {
          const filled = i < entry.length;
          return (
            <div key={i} style={{
              width: 15, height: 15, borderRadius: 8,
              background: filled ? (error ? '#c33' : C.primary) : 'transparent',
              border: `2px solid ${error ? '#c33' : filled ? C.primary : C.border}`,
              transition: 'background .15s, border-color .15s',
            }} />
          );
        })}
      </div>

      {/* Keypad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 16, justifyContent: 'center' }}>
        {keys.map((k, i) => {
          if (k === '') return <div key={i} />;
          if (k === 'del') {
            return (
              <button key={i} onClick={del} aria-label="delete" style={keyBtnStyle(true)}>
                ⌫
              </button>
            );
          }
          return (
            <button key={i} onClick={() => press(k)} style={keyBtnStyle(false)}>
              {k}
            </button>
          );
        })}
      </div>

      <a href={cancelHref} style={{
        marginTop: 30, color: C.textSoft, fontSize: 13.5, fontWeight: 600, textDecoration: 'none',
      }}>
        {t('passcode_cancel')}
      </a>
    </div>
  );
}

function keyBtnStyle(isDel: boolean): React.CSSProperties {
  return {
    width: 72, height: 72, borderRadius: 36,
    background: isDel ? 'transparent' : C.white,
    border: `1px solid ${isDel ? 'transparent' : C.border}`,
    fontSize: isDel ? 24 : 28, fontWeight: 600, color: C.text,
    fontFamily: FONT, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: isDel ? 'none' : '0 1px 3px rgba(20,40,20,0.05)',
    WebkitUserSelect: 'none', userSelect: 'none',
  };
}

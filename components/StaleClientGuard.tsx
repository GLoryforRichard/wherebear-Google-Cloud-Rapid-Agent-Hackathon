'use client';

import { useEffect, useState } from 'react';

/**
 * Detects when the user's cached JS bundle holds Server Action IDs that no
 * longer exist on the server (typical after a fresh deploy).
 *
 * Previous version called `location.reload()` immediately — which killed
 * in-flight photo uploads mid-request (Caddy reported `context canceled` at
 * 170ms). The errors that triggered it are typically background prefetch
 * noise that doesn't actually break the user's flow, so a hard reload was
 * an over-reaction.
 *
 * New behavior: when a stale-action error fires, show a small banner
 * at the bottom of the screen asking the user to refresh when convenient.
 * The user controls the reload — no in-flight requests get clobbered.
 */
export default function StaleClientGuard() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    function isStaleActionError(message: string | undefined): boolean {
      if (!message) return false;
      return (
        message.includes('Failed to find Server Action') ||
        message.includes('older or newer deployment')
      );
    }

    function onError(e: ErrorEvent) {
      if (isStaleActionError(e.message) || isStaleActionError(e.error?.message)) {
        setStale(true);
      }
    }

    function onRejection(e: PromiseRejectionEvent) {
      const msg = typeof e.reason === 'string' ? e.reason : e.reason?.message;
      if (isStaleActionError(msg)) {
        setStale(true);
      }
    }

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  if (!stale) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: '#2a1d13',
        color: '#f4e8d3',
        padding: '10px 14px 10px 16px',
        borderRadius: 14,
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13.5,
        fontWeight: 500,
        fontFamily: 'var(--font-space), -apple-system, system-ui, sans-serif',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <span>App was updated — refresh when ready.</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: '#ff90e8',
          color: '#111',
          border: 'none',
          padding: '6px 12px',
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Refresh
      </button>
      <button
        onClick={() => setStale(false)}
        aria-label="dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#a89784',
          fontSize: 18,
          lineHeight: 1,
          cursor: 'pointer',
          padding: '0 4px',
        }}
      >
        ×
      </button>
    </div>
  );
}

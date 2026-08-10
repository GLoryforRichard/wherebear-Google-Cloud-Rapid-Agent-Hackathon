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
        background: '#111111',
        color: '#ffffff',
        padding: '10px 14px 10px 16px',
        borderRadius: 14,
        boxShadow: '4px 4px 0 #111111',
        border: '2px solid #111111',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13.5,
        fontWeight: 500,
        fontFamily: 'var(--font-jakarta), -apple-system, system-ui, sans-serif',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <span>App was updated — refresh when ready.</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: '#ff8a00',
          color: '#111',
          border: '2px solid #111',
          padding: '6px 12px',
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
          boxShadow: '2px 2px 0 #111',
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
          color: '#afafaf',
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

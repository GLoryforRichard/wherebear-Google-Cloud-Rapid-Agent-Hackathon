'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { C, FONT, SHADOW } from '@/lib/theme';
import { useScanQueue } from '@/lib/scan-queue/store';
import { useTranslation } from '@/lib/i18n';

/**
 * Floating queue pill, visible on EVERY page while the global scan queue has
 * work. The queue itself lives outside the React tree, so this is a pure
 * status view — navigating around the app never touches the uploads.
 * Uses next/link (client-side nav) — a full page load would drop in-flight
 * requests and force an outbox restore.
 *
 * Auto-save makes 'detected' a transient in-flight state, so it counts as
 * active; the pill hides on the queue page itself and when only saved items
 * remain (quiet success — the confidence view lives on the queue page).
 */
export default function GlobalScanIndicator() {
  const { t } = useTranslation();
  const { items } = useScanQueue();
  const pathname = usePathname();

  const active = items.filter(
    (i) =>
      i.status === 'queued' ||
      i.status === 'detecting' ||
      i.status === 'detected' ||
      i.status === 'saving'
  ).length;
  const failed = items.filter((i) => i.status === 'failed').length;

  if (active + failed === 0) return null;
  if (pathname === '/admin/queue') return null;

  const parts: string[] = [];
  if (active > 0) parts.push(t('queue_active', active));
  if (failed > 0) parts.push(t('queue_failed', failed));

  return (
    <Link
      href="/admin/queue"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 18,
        zIndex: 900,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 16px',
        background: failed > 0 ? '#fff1f1' : C.white,
        border: `2px solid ${failed > 0 ? '#e5484d' : C.border}`,
        borderRadius: 999,
        boxShadow: SHADOW,
        fontFamily: FONT,
        fontSize: 13.5,
        fontWeight: 700,
        color: C.text,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
      aria-label="Upload queue status"
    >
      {active > 0 && (
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: C.primary,
            animation: 'pulse 1.4s ease-in-out infinite',
            flexShrink: 0,
          }}
        />
      )}
      {parts.join(' · ')}
    </Link>
  );
}

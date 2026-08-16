'use client';

/**
 * Upload-queue management page — the one place an item can be STOPPED.
 * Shows every queue item (active / failed / recently saved) with per-item
 * retry and delete. A real route (not an /admin screen state) so the global
 * pill can deep-link here from any page via client-side navigation, which
 * keeps the module-singleton queue and its in-flight requests alive.
 */

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import PasscodeGate from '@/components/PasscodeGate';
import ScreenHeader from '@/components/ScreenHeader';
import BearFace from '@/components/BearFace';
import { C, FONT } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';
import { STAFF_PASSCODE, STAFF_UNLOCK_KEY } from '@/lib/staff-gate';
import { type QueueItem, clearSaved, useScanQueue } from '@/lib/scan-queue/store';
import { removeItem, retryItem } from '@/lib/scan-queue/pump';

const ERR_RED = '#e5484d';
const ERR_BG = '#fff1f1';
const OK_GREEN = '#1a7f37';
const MAX_ATTEMPTS_SHOWN = 3;

export default function QueuePage() {
  return (
    <PasscodeGate passcode={STAFF_PASSCODE} storageKey={STAFF_UNLOCK_KEY} cancelHref="/admin">
      <QueueScreen />
    </PasscodeGate>
  );
}

function QueueScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { items } = useScanQueue();

  const active = items.filter(
    (i) => i.status === 'queued' || i.status === 'detecting' || i.status === 'detected' || i.status === 'saving'
  );
  const failed = items.filter((i) => i.status === 'failed');
  const saved = items.filter((i) => i.status === 'saved');

  return (
    <div style={{ minHeight: '100vh', background: C.pageBg, fontFamily: FONT }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '10px 20px 130px' }}>
        <ScreenHeader title={t('queue_title')} onBack={() => router.push('/admin')} />

        {/* Summary strip */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <SummaryChip label={t('queue_active', active.length)} tone="normal" />
          <SummaryChip label={t('queue_failed', failed.length)} tone={failed.length > 0 ? 'error' : 'muted'} />
          <SummaryChip label={t('queue_saved', saved.length)} tone={saved.length > 0 ? 'ok' : 'muted'} />
        </div>

        {items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 16px' }}>
            <BearFace size={64} />
            <div style={{ fontSize: 14.5, color: C.textMuted, margin: '16px 0 20px', lineHeight: 1.5 }}>
              {t('queue_empty')}
            </div>
            <Link
              href="/admin"
              style={{
                display: 'inline-block', padding: '10px 22px', background: C.primary,
                border: `1px solid ${C.border}`, borderRadius: 12, color: '#fff',
                fontWeight: 800, fontSize: 14.5, textDecoration: 'none',
              }}
            >
              {t('queue_go_snap')}
            </Link>
          </div>
        )}

        {active.length > 0 && (
          <Section title={t('queue_section_active')}>
            {active.map((item, idx) => (
              <QueueRow key={item.id} item={item} first={idx === 0} />
            ))}
          </Section>
        )}

        {failed.length > 0 && (
          <Section title={t('queue_section_failed')}>
            {failed.map((item, idx) => (
              <QueueRow key={item.id} item={item} first={idx === 0} />
            ))}
          </Section>
        )}

        {saved.length > 0 && (
          <Section
            title={t('queue_section_saved')}
            action={
              <button
                onClick={() => clearSaved()}
                style={{
                  background: 'none', border: `1px dashed ${C.border}`, borderRadius: 8,
                  padding: '4px 10px', fontSize: 12, fontWeight: 700, color: C.textMuted,
                  cursor: 'pointer', fontFamily: FONT,
                }}
              >
                {t('queue_clear_saved')}
              </button>
            }
          >
            {saved.map((item, idx) => (
              <QueueRow key={item.id} item={item} first={idx === 0} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function SummaryChip({ label, tone }: { label: string; tone: 'normal' | 'error' | 'ok' | 'muted' }) {
  const color = tone === 'error' ? ERR_RED : tone === 'ok' ? OK_GREEN : tone === 'muted' ? C.textSoft : C.text;
  const bg = tone === 'error' ? ERR_BG : C.white;
  return (
    <span style={{
      background: bg, border: `1px solid ${tone === 'error' ? ERR_RED : C.border}`,
      borderRadius: 999, padding: '5px 12px', fontSize: 12.5, fontWeight: 800, color,
    }}>
      {label}
    </span>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: C.textMuted }}>
          {title}
        </div>
        {action}
      </div>
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function QueueRow({ item, first }: { item: QueueItem; first: boolean }) {
  const { t } = useTranslation();
  const isFailed = item.status === 'failed';
  const isSaved = item.status === 'saved';
  const inFlight = item.status === 'detecting' || item.status === 'saving';
  const waitingBackoff =
    (item.status === 'queued' || item.status === 'detected') &&
    !!item.nextAttemptAt && item.nextAttemptAt > Date.now();

  // Async detection reports its pipeline stage — show real progression
  // instead of a bare "Recognizing…" for what can now be minutes on the
  // flex tier. Language-neutral fractions keep i18n out of it.
  const stageSuffix =
    item.status === 'detecting' && item.jobStage
      ? ({ rows: ' · 1/4', detect: ' · 2/4', readout: ' · 3/4', post: ' · 4/4' }[item.jobStage] ?? '')
      : '';

  const statusLabel = isFailed
    ? errorLabel(item, t)
    : waitingBackoff
      ? `${t('queue_retrying')} · ${t('queue_attempts', item.attempts, MAX_ATTEMPTS_SHOWN)}`
      : t(`queue_status_${item.status}` as 'queue_status_queued') + stageSuffix;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
      borderTop: first ? 'none' : `1px solid ${C.border}`,
      background: isFailed ? ERR_BG : 'transparent',
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.previewUrl}
        alt=""
        style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 10, border: `1px solid ${C.border}`, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{
            fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, fontWeight: 800,
            background: C.accentChip, border: `1px solid ${C.border}`, borderRadius: 6, padding: '1px 7px',
          }}>
            {item.aisle}
          </span>
          {item.products.length > 0 && (
            <span style={{ fontSize: 12, color: C.textMuted }}>{t('queue_products_n', item.products.length)}</span>
          )}
        </div>
        <div style={{
          fontSize: 12.5, fontWeight: 600,
          color: isFailed ? ERR_RED : isSaved ? OK_GREEN : C.textMuted,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {inFlight && (
            <span style={{
              width: 7, height: 7, borderRadius: '50%', background: C.primary,
              animation: 'pulse 1.4s ease-in-out infinite', flexShrink: 0,
            }} />
          )}
          {isSaved && <span>✓</span>}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusLabel}</span>
        </div>
        {inFlight && (
          <div style={{ height: 3, borderRadius: 2, background: C.bgMuted, marginTop: 6, overflow: 'hidden', position: 'relative' }}>
            <div style={{
              position: 'absolute', top: 0, bottom: 0, width: '40%', borderRadius: 2,
              background: `linear-gradient(90deg, transparent, ${C.primary}, transparent)`,
              animation: 'indeterminate 1.2s ease-in-out infinite',
            }} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {isFailed && !item.permanent && (
          <RowButton label={t('queue_retry')} onClick={() => retryItem(item.id)} tone="primary" />
        )}
        {!isSaved && (
          <RowButton label={t('queue_delete')} onClick={() => removeItem(item.id)} tone="danger" />
        )}
      </div>
    </div>
  );
}

function RowButton({ label, onClick, tone }: { label: string; onClick: () => void; tone: 'primary' | 'danger' }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${tone === 'danger' ? ERR_RED : C.border}`,
        background: tone === 'danger' ? '#fff' : C.accent,
        color: tone === 'danger' ? ERR_RED : C.text,
        borderRadius: 9, padding: '6px 12px', fontSize: 12.5, fontWeight: 800,
        cursor: 'pointer', fontFamily: FONT, whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function errorLabel(item: QueueItem, t: ReturnType<typeof useTranslation>['t']): string {
  switch (item.errorCode) {
    case 'network': return t('queue_err_network');
    case 'too_large': return t('queue_err_too_large');
    case 'nothing_detected': return t('queue_err_nothing_detected');
    case 'unreadable': return t('queue_err_unreadable');
    case 'save': return t('queue_err_save');
    case 'server': return t('queue_err_server');
    default: return item.error || t('queue_err_server');
  }
}

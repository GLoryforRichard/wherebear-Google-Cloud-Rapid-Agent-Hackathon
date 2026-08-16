'use client';

/**
 * Shelf photo + detection boxes + product list. Shared by the upload-queue
 * "saved" detail so staff can tap a finished job and see what was boxed.
 */

import { useState } from 'react';
import { C, FONT } from '@/lib/theme';
import type { DetectedProduct } from '@/lib/gemini';
import { useTranslation } from '@/lib/i18n';

const BOX = '#ff8a00';

function boxStyle(box: [number, number, number, number]): React.CSSProperties {
  const [y0, x0, y1, x1] = box;
  return {
    position: 'absolute',
    top: `${y0 / 10}%`,
    left: `${x0 / 10}%`,
    width: `${(x1 - x0) / 10}%`,
    height: `${(y1 - y0) / 10}%`,
  };
}

const CONF: Record<string, { bg: string; fg: string }> = {
  high: { bg: '#d1fae5', fg: '#047857' },
  medium: { bg: '#fef3c7', fg: '#b45309' },
  low: { bg: '#fee2e2', fg: '#b91c1c' },
};

export default function ScanResultPreview({
  previewUrl,
  products,
}: {
  previewUrl: string;
  products: DetectedProduct[];
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);

  const boxed = products
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: DetectedProduct & { box_2d: [number, number, number, number] }; i: number } =>
      Array.isArray(x.p.box_2d) && x.p.box_2d.length === 4
    );

  return (
    <div style={{ padding: '0 12px 12px', fontFamily: FONT }}>
      <div style={{
        position: 'relative', width: '100%', borderRadius: 12,
        overflow: 'hidden', border: `1px solid ${C.border}`, background: C.bgMuted,
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={previewUrl} alt="" style={{ width: '100%', display: 'block' }} />
        {boxed.map(({ p, i }) => (
          <button
            key={i}
            type="button"
            aria-label={p.name}
            onClick={() => setActive(active === i ? null : i)}
            style={{
              ...boxStyle(p.box_2d),
              border: `2px solid ${BOX}`,
              background: active === i ? 'rgba(255,138,0,0.28)' : 'transparent',
              zIndex: active === i ? 10 : 1,
              padding: 0, margin: 0, minWidth: 0, minHeight: 0,
              boxSizing: 'border-box', appearance: 'none', WebkitAppearance: 'none',
              cursor: 'pointer',
            }}
          >
            <span style={{
              position: 'absolute', top: 0, left: 0, background: BOX, color: '#fff',
              fontSize: 10, fontFamily: 'ui-monospace, Menlo, monospace',
              padding: '0 4px', lineHeight: '14px', fontWeight: 700,
            }}>
              {i + 1}
            </span>
          </button>
        ))}
      </div>
      {boxed.length === 0 && (
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>{t('queue_no_boxes')}</div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 8, marginTop: 10,
      }}>
        {products.map((p, i) => {
          const conf = CONF[p.confidence ?? ''] ?? { bg: C.bgMuted, fg: C.textMuted };
          const on = active === i;
          return (
            <button
              key={`${p.name}-${i}`}
              type="button"
              onClick={() => setActive(on ? null : i)}
              style={{
                textAlign: 'left', cursor: 'pointer', fontFamily: FONT,
                background: C.white,
                border: on ? `2px solid ${BOX}` : `1px solid ${C.border}`,
                borderRadius: 10, padding: 8, display: 'flex', flexDirection: 'column', gap: 5,
              }}
            >
              <span style={{
                fontSize: 11, color: C.textMuted, fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 700,
              }}>
                #{i + 1}
              </span>
              {p.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.thumbnail}
                  alt=""
                  style={{
                    width: '100%', height: 88, objectFit: 'cover', borderRadius: 6,
                    background: C.bgMuted,
                  }}
                />
              ) : (
                <div style={{ width: '100%', height: 56, borderRadius: 6, background: C.bgMuted }} />
              )}
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.25 }}>{p.name}</span>
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {p.category && (
                  <span style={{
                    background: C.bgMuted, color: C.textMuted, borderRadius: 4,
                    padding: '1px 6px', fontSize: 10, fontWeight: 600,
                  }}>
                    {p.category}
                  </span>
                )}
                {p.confidence && (
                  <span style={{
                    background: conf.bg, color: conf.fg, borderRadius: 4,
                    padding: '1px 6px', fontSize: 10, fontWeight: 600,
                  }}>
                    {p.confidence}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

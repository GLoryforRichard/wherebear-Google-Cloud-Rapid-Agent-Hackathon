'use client';

import { useState } from 'react';
import { C, FONT } from '@/lib/theme';
import { getShelf } from '@/lib/shelves';
import StoreMap from './StoreMap';
import Icon from './Icon';

interface StoreMapModalProps {
  current: string;
  onConfirm: (code: string) => void;
  onClose: () => void;
}

export default function StoreMapModal({ current, onConfirm, onClose }: StoreMapModalProps) {
  const [pending, setPending] = useState(current);

  const handleSelect = (code: string) => {
    setPending(code);
    onConfirm(code);
  };

  const shelf = getShelf(pending);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', flexDirection: 'column',
        fontFamily: FONT,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Sheet */}
      <div style={{
        position: 'absolute', inset: 0,
        background: C.bg,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px 12px',
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Select shelf</div>
            {shelf && (
              <div style={{
                fontSize: 12.5, color: C.textMuted, fontWeight: 500, marginTop: 2,
                maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: C.primary, color: C.text, border: `2px solid ${C.border}`,
                  borderRadius: 5, padding: '1px 7px', fontWeight: 800,
                  fontSize: 11, fontFamily: 'ui-monospace, monospace',
                  marginRight: 6, verticalAlign: 'middle',
                }}>{pending}</span>
                {shelf.description}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: C.bgMuted, border: 'none', cursor: 'pointer',
              width: 36, height: 36, borderRadius: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
            aria-label="Close map"
          >
            <Icon name="x" size={18} style={{ color: C.textMuted }} />
          </button>
        </div>

        {/* Map scroll area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          <StoreMap selected={pending} onSelect={handleSelect} />
        </div>
      </div>
    </div>
  );
}

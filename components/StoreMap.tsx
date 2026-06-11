'use client';

import { C } from '@/lib/theme';

interface StoreMapProps {
  /** Shelf shown as currently picked (green) — used by the picker modal. */
  selected?: string;
  /** Shelf flagged as the search target (red) — used in search results. */
  highlight?: string;
  /** Omit for a read-only map (no clicks, no pointer cursor). */
  onSelect?: (code: string) => void;
}

// Search-target highlight (red), distinct from the green "selected" state.
const HI = '#e5484d';
const HI_DARK = '#c62828';

interface ShelfRect {
  code: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SHELF_RECTS: ShelfRect[] = [
  // ─── B 区 ───
  { code: 'LB1',  x: 240, y: 1880, w: 40,  h: 80 },
  { code: 'B1',   x: 280, y: 1960, w: 160, h: 40 },
  { code: 'RB1',  x: 440, y: 1880, w: 40,  h: 80 },
  { code: 'LB2',  x: 240, y: 1760, w: 40,  h: 80 },
  { code: 'B2',   x: 280, y: 1840, w: 160, h: 40 },
  { code: 'RB2',  x: 440, y: 1760, w: 40,  h: 80 },
  { code: 'LB3',  x: 240, y: 1640, w: 40,  h: 80 },
  { code: 'B3',   x: 280, y: 1720, w: 160, h: 40 },
  { code: 'RB3',  x: 440, y: 1640, w: 40,  h: 80 },
  { code: 'LB4',  x: 240, y: 1520, w: 40,  h: 80 },
  { code: 'B4',   x: 280, y: 1600, w: 160, h: 40 },
  { code: 'RB4',  x: 440, y: 1520, w: 40,  h: 80 },
  { code: 'LB5',  x: 240, y: 1400, w: 40,  h: 80 },
  { code: 'B5',   x: 280, y: 1480, w: 160, h: 40 },
  { code: 'RB5',  x: 440, y: 1400, w: 40,  h: 80 },
  { code: 'B6',   x: 280, y: 1360, w: 160, h: 40 },
  { code: 'LB7',  x: 240, y: 1080, w: 40,  h: 80 },
  { code: 'B7',   x: 280, y: 1160, w: 160, h: 40 },
  { code: 'RB7',  x: 440, y: 1080, w: 40,  h: 80 },
  { code: 'LB8',  x: 240, y:  960, w: 40,  h: 80 },
  { code: 'B8',   x: 280, y: 1040, w: 160, h: 40 },
  { code: 'RB8',  x: 440, y:  960, w: 40,  h: 80 },
  { code: 'LB9',  x: 240, y:  840, w: 40,  h: 80 },
  { code: 'B9',   x: 280, y:  920, w: 160, h: 40 },
  { code: 'RB9',  x: 440, y:  840, w: 40,  h: 80 },
  { code: 'LB10', x: 220, y:  720, w: 60,  h: 80 },
  { code: 'B10',  x: 280, y:  800, w: 160, h: 40 },
  { code: 'RB10', x: 440, y:  720, w: 40,  h: 80 },
  { code: 'LB11', x: 220, y:  600, w: 60,  h: 80 },
  { code: 'B11',  x: 280, y:  680, w: 160, h: 40 },
  { code: 'RB11', x: 440, y:  600, w: 60,  h: 80 },

  // ─── A 区 ───
  { code: 'LA1',  x: 640, y: 1880, w: 40,  h: 80 },
  { code: 'A1',   x: 680, y: 1960, w: 160, h: 40 },
  { code: 'RA1',  x: 840, y: 1880, w: 40,  h: 80 },
  { code: 'LA2',  x: 640, y: 1760, w: 40,  h: 80 },
  { code: 'A2',   x: 680, y: 1840, w: 160, h: 40 },
  { code: 'RA2',  x: 840, y: 1760, w: 40,  h: 80 },
  { code: 'LA3',  x: 640, y: 1640, w: 40,  h: 80 },
  { code: 'A3',   x: 680, y: 1720, w: 160, h: 40 },
  { code: 'RA3',  x: 840, y: 1640, w: 40,  h: 80 },
  { code: 'LA4',  x: 640, y: 1520, w: 40,  h: 80 },
  { code: 'A4',   x: 680, y: 1600, w: 160, h: 40 },
  { code: 'RA4',  x: 840, y: 1520, w: 40,  h: 80 },
  { code: 'LA5',  x: 640, y: 1400, w: 40,  h: 80 },
  { code: 'A5',   x: 680, y: 1480, w: 160, h: 40 },
  { code: 'RA5',  x: 840, y: 1400, w: 40,  h: 80 },
  { code: 'A6',   x: 680, y: 1360, w: 160, h: 40 },
  { code: 'LA7',  x: 640, y: 1080, w: 40,  h: 80 },
  { code: 'A7',   x: 680, y: 1160, w: 160, h: 40 },
  { code: 'RA7',  x: 840, y: 1080, w: 40,  h: 80 },
  { code: 'LA8',  x: 640, y:  960, w: 40,  h: 80 },
  { code: 'A8',   x: 680, y: 1040, w: 160, h: 40 },
  { code: 'RA8',  x: 840, y:  960, w: 40,  h: 80 },
  { code: 'LA9',  x: 640, y:  840, w: 40,  h: 80 },
  { code: 'A9',   x: 680, y:  920, w: 160, h: 40 },
  { code: 'RA9',  x: 840, y:  840, w: 40,  h: 80 },
  { code: 'LA10', x: 620, y:  720, w: 60,  h: 80 },
  { code: 'A10',  x: 680, y:  800, w: 160, h: 40 },
  { code: 'RA10', x: 840, y:  720, w: 60,  h: 80 },
  { code: 'LA11', x: 620, y:  600, w: 60,  h: 80 },
  { code: 'A11',  x: 680, y:  680, w: 160, h: 40 },
  { code: 'RA11', x: 840, y:  600, w: 60,  h: 80 },
  { code: 'A12',  x: 680, y:  560, w: 160, h: 40 },
];

// Center zone (C区) — interactive shelves between A and B sections
const CENTER_RECTS: ShelfRect[] = [
  { code: 'C1',  x: 520, y:  600, w: 80, h: 280 },
  { code: 'C2',  x: 520, y:  920, w: 80, h: 280 },
  { code: 'C3',  x: 520, y: 1360, w: 80, h: 280 },
  { code: 'C4',  x: 520, y: 1680, w: 80, h: 280 },
  { code: 'XB1', x: 240, y: 1240, w: 120, h: 80 },
  { code: 'XB2', x: 360, y: 1240, w: 120, h: 80 },
  { code: 'CX',  x: 520, y: 1240, w: 80,  h: 80 },
  { code: 'XA1', x: 640, y: 1240, w: 120, h: 80 },
  { code: 'XA2', x: 760, y: 1240, w: 120, h: 80 },
  // Cooler cabinet — tall rectangle down the left edge (outside the A/B grid).
  { code: 'CoolerTop', x: 110, y: 600, w: 92, h: 1360 },
];

function isCenter(r: ShelfRect) {
  return r.w >= 100;
}

function isCenterZone(r: ShelfRect) {
  return r.code.startsWith('C') || r.code.startsWith('X');
}

export default function StoreMap({ selected, highlight, onSelect }: StoreMapProps) {
  const clickable = !!onSelect;
  // For a search-target highlight (read-only result map), zoom the viewBox to
  // a tight window around that shelf instead of rendering the whole store.
  let viewBox = '90 545 830 1470';
  if (highlight) {
    const hi = [...SHELF_RECTS, ...CENTER_RECTS].find(r => r.code === highlight);
    if (hi) {
      const padX = 200, padY = 200;
      const vw = hi.w + padX * 2;
      const vh = hi.h + padY * 2;
      const vx = hi.x + hi.w / 2 - vw / 2;
      const vy = hi.y + hi.h / 2 - vh / 2;
      viewBox = `${vx} ${vy} ${vw} ${vh}`;
    }
  }
  return (
    <svg
      viewBox={viewBox}
      width="100%"
      style={{ display: 'block', userSelect: 'none' }}
      aria-label="Store map"
    >
      {/* Section labels */}
      <text x="360" y="575" textAnchor="middle" fontSize={22} fontWeight={800}
        fill={C.textMuted} fontFamily="ui-sans-serif, system-ui, sans-serif">B</text>
      <text x="760" y="575" textAnchor="middle" fontSize={22} fontWeight={800}
        fill={C.textMuted} fontFamily="ui-sans-serif, system-ui, sans-serif">A</text>

      {/* A/B shelf rects */}
      {SHELF_RECTS.map(r => {
        const sel = selected === r.code;
        const hi = highlight === r.code;
        const center = isCenter(r);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const label = center ? r.code : (r.code.startsWith('L') ? 'L' : 'R');
        return (
          <g key={r.code}
            onClick={clickable ? () => onSelect!(r.code) : undefined}
            style={{ cursor: clickable ? 'pointer' : 'default' }}>
            <rect
              x={r.x} y={r.y} width={r.w} height={r.h}
              fill={hi ? HI : sel ? C.primary : (center ? C.accentBg : C.primarySofter)}
              stroke={hi ? HI_DARK : sel ? C.primaryDark : C.primaryChip}
              strokeWidth={(hi || sel) ? 2.5 : 1}
              rx={4}
            />
            <text
              x={cx} y={cy}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={(hi || sel) ? '#fff' : C.text}
              fontSize={center ? 16 : 13}
              fontWeight={700}
              fontFamily="ui-monospace, monospace"
              pointerEvents="none"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* C区 center zone rects */}
      {CENTER_RECTS.map(r => {
        const sel = selected === r.code;
        const hi = highlight === r.code;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const isTall = r.h > r.w;
        return (
          <g key={r.code}
            onClick={clickable ? () => onSelect!(r.code) : undefined}
            style={{ cursor: clickable ? 'pointer' : 'default' }}>
            <rect
              x={r.x} y={r.y} width={r.w} height={r.h}
              fill={hi ? HI : sel ? C.primary : C.accentTint}
              stroke={hi ? HI_DARK : sel ? C.primaryDark : C.accent}
              strokeWidth={(hi || sel) ? 2.5 : 1}
              rx={4}
            />
            <text
              x={cx} y={cy}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={(hi || sel) ? '#fff' : C.accentDark}
              fontSize={isTall ? 11 : 12}
              fontWeight={700}
              fontFamily="ui-monospace, monospace"
              pointerEvents="none"
              transform={isTall ? `rotate(-90,${cx},${cy})` : undefined}
            >
              {r.code}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

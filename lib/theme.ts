// Wherebear 3.0 — "Gumroad" direction (neo-brutalist: cream + hard black
// outlines + offset hard shadows), in WARM ORANGE + golden yellow.
// Tints are pre-computed (primary/accent mixed over white) so we don't depend
// on runtime color-mix support on older in-store devices.
export const C = {
  bg: '#fdf7e3',          // cream page background
  bgMuted: '#f6eed6',     // surface-2 (slightly deeper cream)
  white: '#ffffff',       // card surface — crisp white inside black borders
  border: '#111111',      // hard black outline → the brutalist edge
  text: '#111111',        // ink black
  textMuted: '#6a6359',
  textSoft: '#9a9387',
  primary: '#ff8a00',     // warm orange
  primaryDark: '#8a4a00', // deep amber — readable on tints + as ink
  primarySoft: '#ffd6a8',
  primarySofter: '#ffefdc',
  primaryChip: '#ffc585',
  accent: '#ffc900',      // golden yellow
  accentDark: '#6b5200',
  accent2: '#ffd84d',
  accentBg: '#fff1c2',
  accentTint: '#fffae6',
  accentChip: '#ffe48a',
  pageBg: 'radial-gradient(circle at 20% 10%, #fefbf2 0%, #fdf7e3 55%, #f7eed6 100%)',
} as const;

export const FONT = 'var(--font-space), -apple-system, system-ui, sans-serif';

// Neo-brutalist signature: a crisp offset shadow with NO blur, in ink black,
// so cards/buttons read like stickers pinned to the page.
export const SHADOW = '4px 4px 0 #111111';

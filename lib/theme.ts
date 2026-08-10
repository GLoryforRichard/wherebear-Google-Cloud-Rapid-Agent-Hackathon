// Wherebear 3.1 — Uber-mobile surface language (white / cool gray / ink)
// with Wherebear's warm orange + golden yellow accents retained.
// Neo-brutalist hard borders + offset shadows (tactile buttons) stay.
// Tints are pre-computed (primary/accent mixed over white) so we don't depend
// on runtime color-mix support on older in-store devices.
export const C = {
  bg: '#f6f6f6',          // Uber-like cool page background
  bgMuted: '#eeeeee',     // surface-2
  white: '#ffffff',       // card surface — crisp white inside black borders
  border: '#111111',      // hard black outline → the brutalist edge
  text: '#111111',        // ink black
  textMuted: '#6b6b6b',   // cool gray (was warm taupe)
  textSoft: '#afafaf',
  primary: '#ff8a00',     // warm orange — kept from Wherebear
  primaryDark: '#8a4a00', // deep amber — readable on tints + as ink
  primarySoft: '#ffd6a8',
  primarySofter: '#fff3e6',
  primaryChip: '#ffc585',
  accent: '#ffc900',      // golden yellow — kept from Wherebear
  accentDark: '#6b5200',
  accent2: '#ffd84d',
  accentBg: '#fff6cc',
  accentTint: '#fffbeb',
  accentChip: '#ffe48a',
  pageBg: '#f6f6f6',      // flat Uber-clean surface (no cream radial)
} as const;

export const FONT = 'var(--font-jakarta), -apple-system, system-ui, sans-serif';

// Neo-brutalist signature: a crisp offset shadow with NO blur, in ink black,
// so cards/buttons read like stickers pinned to the page.
export const SHADOW = '4px 4px 0 #111111';

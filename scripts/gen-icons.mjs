// Regenerate app icons + OG image from public/logo.png.
// Run: node scripts/gen-icons.mjs   (needs sharp, already a dep)
// Next.js App Router auto-serves app/icon.png, app/apple-icon.png and
// app/opengraph-image.png — no metadata wiring needed.
import sharp from 'sharp';

const LOGO = 'public/logo.png';

// favicon / app icon (white matte matches the logo's own background)
await sharp(LOGO).resize(512, 512, { fit: 'contain', background: '#ffffff' }).png().toFile('app/icon.png');
// apple touch icon
await sharp(LOGO).resize(180, 180, { fit: 'contain', background: '#ffffff' }).png().toFile('app/apple-icon.png');

// Open Graph / social share card (1200×630): logo + wordmark on white
const logoBuf = await sharp(LOGO)
  .resize(440, 440, { fit: 'contain', background: '#ffffff' })
  .png()
  .toBuffer();
const wordmark = Buffer.from(
  '<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">' +
  '<text x="600" y="575" font-family="Helvetica,Arial,sans-serif" font-size="76" font-weight="bold" fill="#1f1410" text-anchor="middle">Wherebear</text>' +
  '</svg>'
);
await sharp({ create: { width: 1200, height: 630, channels: 4, background: '#ffffff' } })
  .composite([{ input: logoBuf, top: 60, left: 380 }, { input: wordmark, top: 0, left: 0 }])
  .png()
  .toFile('app/opengraph-image.png');

console.log('icons + og generated');

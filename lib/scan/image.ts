import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { PreparedImage } from './types';

const execFileP = promisify(execFile);

const HEIC_BRANDS = [
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
];

export function sniffHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return HEIC_BRANDS.includes(brand);
}

type HeicConversion = 'sharp' | 'sips' | 'heic-convert';

/**
 * Three-tier HEIC→JPEG: sharp (some libvips builds decode HEIC) → macOS sips
 * (dev machines) → heic-convert (pure JS, the Linux-production fallback).
 */
async function heicToJpeg(
  buf: Buffer
): Promise<{ jpeg: Buffer; conversion: HeicConversion }> {
  try {
    // sharp keeps EXIF orientation when asked; some libvips builds decode HEIC
    const jpeg = await sharp(buf).keepExif().jpeg({ quality: 92 }).toBuffer();
    return { jpeg, conversion: 'sharp' };
  } catch {
    // fall through
  }
  if (process.platform === 'darwin') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'whataisle-scan-'));
    const inFile = path.join(dir, 'in.heic');
    const outFile = path.join(dir, 'out.jpg');
    try {
      await writeFile(inFile, buf);
      await execFileP('sips', [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '92',
        inFile,
        '--out',
        outFile,
      ]);
      const jpeg = await readFile(outFile);
      return { jpeg, conversion: 'sips' };
    } catch {
      // fall through
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const { default: heicConvert } = await import('heic-convert');
  const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.92 });
  return { jpeg: Buffer.from(out), conversion: 'heic-convert' };
}

export interface PreparedScanImages {
  /**
   * Upright JPEG, EXIF orientation applied and stripped, long side ≤ 2048 px.
   * This is the coordinate space for row detection and the persisted photo.
   * Long side > 1000 is deliberate: it lets the box parser detect
   * absolute-pixel model outputs (values > 1000).
   */
  processed: PreparedImage;
  /**
   * Upright JPEG at the ORIGINAL resolution (EXIF-rotated, not downscaled) —
   * the source for high-res band slicing (rows-hd) and readout crops.
   */
  full: PreparedImage;
  conversion: HeicConversion | 'none';
}

/**
 * Any upload → the two working images the scan engine needs, entirely
 * in-memory (nothing touches disk except the sips fallback's temp files).
 * HEIC is converted exactly once; both outputs derive from the same decode.
 */
export async function prepareScanImages(
  buf: Buffer
): Promise<PreparedScanImages> {
  let working = buf;
  let conversion: PreparedScanImages['conversion'] = 'none';
  if (sniffHeic(buf)) {
    const converted = await heicToJpeg(buf);
    working = converted.jpeg;
    conversion = converted.conversion;
  }

  const fullJpeg = await sharp(working)
    .rotate() // applies EXIF orientation, strips the tag
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const fullMeta = await sharp(fullJpeg).metadata();

  const processedJpeg = await sharp(working)
    .rotate()
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const processedMeta = await sharp(processedJpeg).metadata();

  return {
    processed: {
      jpeg: processedJpeg,
      width: processedMeta.width ?? 0,
      height: processedMeta.height ?? 0,
    },
    full: {
      jpeg: fullJpeg,
      width: fullMeta.width ?? 0,
      height: fullMeta.height ?? 0,
    },
    conversion,
  };
}

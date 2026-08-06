/**
 * Decode-once raw pixel access for the scan pipeline.
 *
 * The rows-hd stages need many crops from the same full-resolution photo:
 * band slices (≤8), grid-readout cells (one per detected box, 60-80 on dense
 * shelves), per-crop fallbacks, and product thumbnails. `sharp(jpeg)
 * .extract(...)` decodes the JPEG EVERY time — ~78 full 12MP decodes cost
 * tens of CPU-seconds on the 2-vCPU VM and were the hidden bulk of the
 * pipeline's wall time. Decoding once to a raw RGB buffer makes each extract
 * a near-free memory copy. Identical pixels, identical model inputs — this
 * is purely a CPU optimization.
 */

import sharp from 'sharp';
import type { PreparedImage } from './types';

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

export async function decodeRaw(img: PreparedImage): Promise<RawImage> {
  const { data, info } = await sharp(img.jpeg).raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels as 3 | 4,
  };
}

/** A sharp instance reading from the raw buffer, cropped to `rect`. */
export function extractFromRaw(
  raw: RawImage,
  rect: { left: number; top: number; width: number; height: number }
): sharp.Sharp {
  return sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels },
  }).extract(rect);
}

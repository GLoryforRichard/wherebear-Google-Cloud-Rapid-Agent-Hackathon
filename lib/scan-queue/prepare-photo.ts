'use client';

/**
 * Turn whatever the phone hands us (HEIC from the album, a huge JPEG, a
 * canvas capture) into a modest JPEG *before* it hits IndexedDB or the
 * network. Two reasons this lives on the client:
 *
 *  1. iOS album uploads of HEIC arrive as multipart that undici cannot
 *     parse (`Failed to parse body as FormData`) — the camera path already
 *     went through canvas JPEG and never hit this. Re-encoding here makes
 *     album shots take the same road.
 *  2. The server pipeline downscales to 2048px anyway; shipping a 12 MB
 *     original just to have sharp throw it away wastes radio and RAM.
 *
 * Safari also returns IndexedDB blobs that look fine but cannot be
 * appended to FormData or drawn until sliced into a new Blob — reviveBlob
 * is that workaround.
 */

const MAX_SIDE = 2048;
const JPEG_QUALITY = 0.85;

export function reviveBlob(blob: Blob): Blob {
  return blob.slice(0, blob.size, blob.type || 'image/jpeg');
}

export async function preparePhoto(input: Blob): Promise<Blob> {
  const src = reviveBlob(input);
  // Already a modest JPEG (camera capture, or a previous preparePhoto pass).
  if (src.type === 'image/jpeg' && src.size > 0 && src.size <= 2 * 1024 * 1024) {
    return src;
  }
  const bitmap = await decodeBitmap(src);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('jpeg encode failed'))),
        'image/jpeg',
        JPEG_QUALITY
      );
    });
    return blob;
  } finally {
    bitmap.close();
  }
}

async function decodeBitmap(src: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(src, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(src);
  }
}

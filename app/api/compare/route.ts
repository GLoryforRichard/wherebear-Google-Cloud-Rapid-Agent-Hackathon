import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { runWherebearParadigm } from '@/lib/compare/run-wherebear';
import { prewarmScan, runWhatAisleParadigm } from '@/lib/compare/run-whataisle';
import { heicToJpeg, sniffHeic } from '@/lib/scan/image';
import { CompareParadigm, CompareRunResult } from '@/lib/compare/types';

export const runtime = 'nodejs';
// One paradigm per request (the client fires three in parallel). Dense
// shelves through the two-stage pipeline can take a while on 3.6-flash.
export const maxDuration = 180;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const VALID_PARADIGMS: CompareParadigm[] = [
  'wherebear',
  'whataisle-openrouter',
  'whataisle-vertex',
];

/** In-flight/recent HEIC conversions keyed by content hash. Entries expire
 *  after 5 minutes; a failed conversion is evicted immediately so a retry
 *  doesn't replay the cached rejection. */
const heicConversions = new Map<string, Promise<Buffer>>();

function convertHeicShared(heic: Buffer): Promise<Buffer> {
  const key = createHash('sha1').update(heic).digest('hex');
  let pending = heicConversions.get(key);
  if (!pending) {
    pending = heicToJpeg(heic).then((c) => c.jpeg);
    heicConversions.set(key, pending);
    pending.catch(() => heicConversions.delete(key));
    for (const k of heicConversions.keys()) {
      if (heicConversions.size <= 3) break;
      heicConversions.delete(k);
    }
    setTimeout(() => heicConversions.delete(key), 5 * 60_000).unref();
  }
  return pending;
}

/** Browser-displayable preview for the overlay base image (the client may
 *  have uploaded a HEIC it cannot render itself). Upright (EXIF applied),
 *  same coordinate space as every paradigm's boxes. Shared across the three
 *  concurrent paradigm requests by content hash. */
const previewCache = new Map<string, Promise<string>>();

function previewShared(jpeg: Buffer): Promise<string> {
  const key = createHash('sha1').update(jpeg).digest('hex');
  let pending = previewCache.get(key);
  if (!pending) {
    pending = sharp(jpeg)
      .rotate()
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
      .then((buf) => `data:image/jpeg;base64,${buf.toString('base64')}`);
    previewCache.set(key, pending);
    pending.catch(() => previewCache.delete(key));
    for (const k of previewCache.keys()) {
      if (previewCache.size <= 3) break;
      previewCache.delete(k);
    }
    setTimeout(() => previewCache.delete(key), 5 * 60_000).unref();
  }
  return pending;
}

export async function POST(req: NextRequest) {
  let paradigm: CompareParadigm | 'prepare' | undefined;
  try {
    const formData = await req.formData();
    const file = formData.get('image');
    const p = (formData.get('paradigm') as string | null)?.trim() as CompareParadigm | 'prepare';

    if (p !== 'prepare' && !VALID_PARADIGMS.includes(p)) {
      return NextResponse.json(
        { ok: false, error: `paradigm must be one of ${VALID_PARADIGMS.join(', ')}` },
        { status: 400 }
      );
    }
    paradigm = p;

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No image file provided' }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ ok: false, error: 'Image is too large. Use a photo under 20 MB.' }, { status: 413 });
    }
    // Some clients ship HEIC (or any photo) as application/octet-stream —
    // let content sniffing decide; sharp errors out cleanly on non-images.
    if (
      file.type &&
      file.type !== 'application/octet-stream' &&
      (!file.type.startsWith('image/') || file.type === 'image/svg+xml')
    ) {
      return NextResponse.json({ ok: false, error: 'Please upload a photo file.' }, { status: 400 });
    }

    let buffer: Buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'image/jpeg';

    // iPhone HEIC uploads: the VM's sharp/libvips has no HEIF support, and
    // the browser can't render HEIC either. Normalize here so every paradigm
    // (and the preview below) gets a plain JPEG. The client fires all three
    // paradigm requests with the SAME photo at once, and the pure-JS
    // heic-convert fallback costs ~30s of CPU on the 2-vCPU VM — dedupe by
    // content hash so the three requests share one conversion.
    if (sniffHeic(buffer)) {
      buffer = await convertHeicShared(buffer);
    }

    // Prewarm: fired by the client the moment a file is picked, so HEIC
    // conversion, resize, raw decode, the preview, and both paradigms'
    // (single, un-raced) row-detect calls are all underway before the user
    // clicks Run.
    if (p === 'prepare') {
      await Promise.all([prewarmScan(buffer), previewShared(buffer)]);
      return NextResponse.json({ ok: true, prepared: true });
    }

    const previewPromise = previewShared(buffer);
    let result: CompareRunResult;
    if (p === 'wherebear') {
      result = await runWherebearParadigm(buffer, mimeType);
    } else {
      result = await runWhatAisleParadigm(buffer, mimeType, p);
    }
    result.previewImage = await previewPromise;

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[compare] ${paradigm ?? '(unknown paradigm)'} failed: ${msg}`,
      err instanceof Error && err.stack ? `\n${err.stack}` : ''
    );
    return NextResponse.json({ ok: false, paradigm, error: msg }, { status: 500 });
  }
}

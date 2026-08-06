import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { runWherebearParadigm } from '@/lib/compare/run-wherebear';
import { runWhatAisleParadigm } from '@/lib/compare/run-whataisle';
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

export async function POST(req: NextRequest) {
  let paradigm: CompareParadigm | undefined;
  try {
    const formData = await req.formData();
    const file = formData.get('image');
    const p = (formData.get('paradigm') as string | null)?.trim() as CompareParadigm;

    if (!VALID_PARADIGMS.includes(p)) {
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
    // the browser can't render HEIC either. Normalize ONCE here so every
    // paradigm (and the preview below) gets a plain JPEG.
    if (sniffHeic(buffer)) {
      const converted = await heicToJpeg(buffer);
      buffer = converted.jpeg;
    }

    // Browser-displayable preview for the overlay base image (the client may
    // have uploaded a HEIC it cannot render itself). Upright (EXIF applied),
    // same coordinate space as every paradigm's boxes.
    const previewJpeg = await sharp(buffer)
      .rotate()
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const previewImage = `data:image/jpeg;base64,${previewJpeg.toString('base64')}`;

    let result: CompareRunResult;
    if (p === 'wherebear') {
      result = await runWherebearParadigm(buffer, mimeType);
    } else {
      result = await runWhatAisleParadigm(buffer, mimeType, p);
    }
    result.previewImage = previewImage;

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

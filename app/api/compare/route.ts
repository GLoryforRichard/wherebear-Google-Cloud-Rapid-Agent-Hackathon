import { NextRequest, NextResponse } from 'next/server';
import { runWherebearParadigm } from '@/lib/compare/run-wherebear';
import { runWhatAisleParadigm } from '@/lib/compare/run-whataisle';
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
    if (file.type && (!file.type.startsWith('image/') || file.type === 'image/svg+xml')) {
      return NextResponse.json({ ok: false, error: 'Please upload a photo file.' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'image/jpeg';

    let result: CompareRunResult;
    if (p === 'wherebear') {
      result = await runWherebearParadigm(buffer, mimeType);
    } else {
      result = await runWhatAisleParadigm(buffer, mimeType, p);
    }

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

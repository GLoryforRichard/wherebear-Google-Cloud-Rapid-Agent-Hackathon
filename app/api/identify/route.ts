import { NextRequest, NextResponse } from 'next/server';
import { identifyProductFromPhoto } from '@/lib/gemini';
import { logOp } from '@/lib/ops';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// "Find by photo": the shopper photographs the single product they're looking
// for; Gemini names it so we can search the store. Distinct from /api/vision,
// which detects ALL products on a shelf with bounding boxes.
export async function POST(req: NextRequest) {
  let reqInfo = 'image=(none)';
  try {
    const formData = await req.formData();
    const file = formData.get('image');
    const lang = (formData.get('lang') as string | null)?.trim();
    reqInfo =
      `image=${file instanceof File ? `${file.type || '?'},${file.size}B` : '(not a file)'} ` +
      `lang=${lang || '?'}`;

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ ok: false, error: 'Image is too large. Use a photo under 8 MB.' }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { text, text_en, usage } = await identifyProductFromPhoto(
      buffer,
      file.type || 'image/jpeg',
      lang || undefined,
    );
    await logOp('identify', usage);

    return NextResponse.json({ ok: true, text, text_en });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[identify] failed — ${reqInfo}: ${msg}`,
      err instanceof Error && err.stack ? `\n${err.stack}` : '',
    );
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

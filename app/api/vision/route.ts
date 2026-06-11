import { NextRequest, NextResponse } from 'next/server';
import { detectAndIdentifyProducts } from '@/lib/gemini';
import { buildShelfContext } from '@/lib/shelves';
import { logOp } from '@/lib/ops';

export const runtime = 'nodejs';
// Two-stage pipeline: 1× detect call + 1× batch-identify call. Identify can
// take longer than a single-shot run when there are many crops, so give it
// a wider window than the old 60s ceiling.
export const maxDuration = 120;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // Captured up here so the failure log in `catch` can describe the request
  // (the formData locals are out of scope down there).
  let reqInfo = 'aisle=(none) file=(none)';
  try {
    const formData = await req.formData();
    const file = formData.get('image');
    const aisle = (formData.get('aisle') as string | null)?.trim();
    reqInfo =
      `aisle=${aisle || '(none)'} file=` +
      (file instanceof File
        ? `${file.name || 'unnamed'},${file.type || '?'},${file.size}B`
        : '(not a file)');

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No image file provided' }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ ok: false, error: 'Image is too large. Use a photo under 8 MB.' }, { status: 413 });
    }
    if (file.type && (!file.type.startsWith('image/') || file.type === 'image/svg+xml')) {
      return NextResponse.json({ ok: false, error: 'Please upload a photo file.' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'image/jpeg';

    const shelfContext = aisle ? buildShelfContext(aisle) : undefined;
    const { products, usage } = await detectAndIdentifyProducts(buffer, mimeType, shelfContext);

    await logOp('snap', usage);

    return NextResponse.json({
      ok: true,
      count: products.length,
      products,
      aisle_hint: shelfContext,
      usage,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Always leave a breadcrumb in pm2 logs — the client only ever sees the
    // `error` string, so without this a request that 500s is invisible
    // server-side and impossible to diagnose after the fact.
    console.error(
      `[vision] request failed — ${reqInfo}: ${msg}`,
      err instanceof Error && err.stack ? `\n${err.stack}` : ''
    );
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { runShelfIntake } from '@/lib/scan/intake';
import { logOp } from '@/lib/ops';
import { isScanLabEnabled, scanLabNotFound } from '@/lib/scan-lab';

export const runtime = 'nodejs';
// rows-hd pipeline: rows call + up to 8 band calls (with one serial retry
// layer) + grid readout. Typical run is 60-120s; one full band-retry wave
// ≈ 240s. 300 keeps margin while staying at the browser's ~300s fetch
// ceiling. (Self-hosted Next doesn't enforce this — documented intent.)
export const maxDuration = 300;

// 20 MB matches whataisle's vision-test limit — modern phone photos can
// exceed 8 MB, and the pipeline downscales before the model sees anything.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest) {
  if (!isScanLabEnabled()) return scanLabNotFound();
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
      return NextResponse.json({ ok: false, error: 'Image is too large. Use a photo under 20 MB.' }, { status: 413 });
    }
    if (file.type && (!file.type.startsWith('image/') || file.type === 'image/svg+xml')) {
      return NextResponse.json({ ok: false, error: 'Please upload a photo file.' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // rows-hd takes no shelf hint — its prompts stay byte-identical to the
    // benchmark champion. The `aisle` form field is still parsed above for
    // the failure log; the queue client uses its own copy for the save.
    // prepareScanImages sniffs HEIC from bytes, so iPhone gallery uploads
    // work without a mime hint.
    const { products, usage } = await runShelfIntake(buffer);

    await logOp('snap', usage);

    return NextResponse.json({
      ok: true,
      count: products.length,
      products,
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

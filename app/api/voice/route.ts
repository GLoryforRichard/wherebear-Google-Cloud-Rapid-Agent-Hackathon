import { NextRequest, NextResponse } from 'next/server';
import { transcribeAudio } from '@/lib/gemini';
import { logOp } from '@/lib/ops';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Gemini's inline-data ceiling is 20 MB for the whole request; a 16kHz mono
// WAV is ~32 KB/s, so even a 15s clip is well under 1 MB. Cap defensively.
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let reqInfo = 'audio=(none)';
  try {
    const formData = await req.formData();
    const file = formData.get('audio');
    const lang = (formData.get('lang') as string | null)?.trim();
    reqInfo =
      `audio=${file instanceof File ? `${file.type || '?'},${file.size}B` : '(not a file)'} ` +
      `lang=${lang || '?'}`;

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No audio provided' }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ ok: false, error: 'Audio clip is too long.' }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { text, text_en, usage } = await transcribeAudio(
      buffer.toString('base64'),
      file.type || 'audio/wav',
      lang || undefined,
    );
    await logOp('voice', usage);

    return NextResponse.json({ ok: true, text, text_en });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Mirror /api/vision: always leave a server-side breadcrumb for failures.
    console.error(
      `[voice] transcribe failed — ${reqInfo}: ${msg}`,
      err instanceof Error && err.stack ? `\n${err.stack}` : '',
    );
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

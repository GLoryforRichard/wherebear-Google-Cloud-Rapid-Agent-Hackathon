/**
 * Async shelf-intake: submit a photo as a scan job.
 *
 * POST multipart {image, aisle} → 202 {jobId, hash, status}. Idempotent by
 * photo content hash — re-submitting bytes the server already knows returns
 * the existing job instead of re-running (and re-billing) the pipeline.
 * Backpressure: past SCAN_JOBS_MAX_QUEUED active jobs the route answers
 * 429 {retryAfterMs}; the client outbox is the deep buffer.
 *
 * The synchronous /api/vision route stays untouched — stale tabs keep
 * working across the rollout, and it remains the fallback path.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  SCAN_JOBS_MAX_QUEUED,
  activeJobCount,
  createOrGetJob,
  ensureJobIndexes,
  sha1,
  writeJobPhoto,
} from '@/lib/scan/jobs';
import { SCAN_SERVICE_TIER } from '@/lib/scan/transport-flex';

export const runtime = 'nodejs';
// Accept + hash + disk write only — the pipeline runs in the worker.
export const maxDuration = 30;

// Mirrors /api/vision: modern phone photos exceed 8 MB; pipeline downscales.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[vision-jobs] submit failed: ${msg} (content-type=${req.headers.get('content-type') ?? ''} content-length=${req.headers.get('content-length') ?? ''})`
      );
      return NextResponse.json({ ok: false, error: 'unreadable photo' }, { status: 400 });
    }
    const file = formData.get('image');
    const aisle = (formData.get('aisle') as string | null)?.trim() ?? '';

    // Duck-type Blob: some runtimes hand back a Blob that isn't `instanceof File`.
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ ok: false, error: 'No image file provided' }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'Image is too large. Use a photo under 20 MB.' },
        { status: 413 }
      );
    }
    if (file.type && (!file.type.startsWith('image/') || file.type === 'image/svg+xml')) {
      return NextResponse.json({ ok: false, error: 'Please upload a photo file.' }, { status: 400 });
    }

    await ensureJobIndexes();

    const active = await activeJobCount();
    if (active >= SCAN_JOBS_MAX_QUEUED) {
      return NextResponse.json(
        { ok: false, error: 'scan queue is full', retryAfterMs: 20_000 },
        { status: 429 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = sha1(buffer);
    // Photo lands on disk BEFORE the doc can flip to queued — the worker's
    // claim must never win a race against a missing file.
    await writeJobPhoto(hash, buffer);
    const job = await createOrGetJob(hash, aisle, SCAN_SERVICE_TIER);

    return NextResponse.json(
      { ok: true, jobId: String(job._id), hash, status: job.status },
      { status: 202 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vision-jobs] submit failed: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

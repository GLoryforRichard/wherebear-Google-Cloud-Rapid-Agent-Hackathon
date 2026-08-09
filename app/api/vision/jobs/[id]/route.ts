/**
 * Async shelf-intake: poll / ack one scan job.
 *
 * GET → {ok, jobId, status, stage?, count?, products?, usage?,
 *        estimatedCostUsd?, error?} — products only when done (read from the
 * job's result.json on disk; if that file is gone the job is flipped to
 * failed so the client re-submits instead of polling forever).
 * DELETE → client ack after it has persisted the products: removes the job
 * dir and doc immediately instead of waiting for the TTL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteJobDir, failJob, getJob, readJobResult } from '@/lib/scan/jobs';
import { getDb } from '@/lib/mongodb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ ok: false, error: 'job not found' }, { status: 404 });
    }

    if (job.status === 'done') {
      const products = await readJobResult(job.hash);
      if (!products) {
        // Result evaporated (disk sweep/restart edge) — fail it so the
        // client's re-submit path takes over rather than spinning forever.
        if (job._id) await failJob(job._id, 'result lost after completion — resubmit');
        return NextResponse.json({
          ok: true,
          jobId: id,
          status: 'failed',
          error: 'result lost after completion — resubmit',
        });
      }
      return NextResponse.json({
        ok: true,
        jobId: id,
        status: job.status,
        count: job.count ?? products.length,
        products,
        usage: job.usage,
        estimatedCostUsd: job.estimatedCostUsd ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      jobId: id,
      status: job.status,
      stage: job.stage,
      error: job.error,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const job = await getJob(id);
    if (job) {
      await deleteJobDir(job.hash);
      const db = await getDb();
      await db.collection('scan_jobs').deleteOne({ _id: job._id });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * In-process scan-job worker: drains the `scan_jobs` queue with photo-level
 * concurrency. Started once from instrumentation.ts (pm2 runs a single fork
 * process — no cluster, so one loop total; the lease/reclaim machinery in
 * jobs.ts covers restarts anyway).
 *
 * Tier wiring:
 *  - flex (SCAN_SERVICE_TIER=flex): calls go through callModelVertexFlex —
 *    the dedicated half-price lane — so WORKER_PHOTO_CONCURRENCY photos can
 *    run side by side without touching the standard interactive gate.
 *  - standard: photo concurrency is FORCED to 1. N photos × 8 bands through
 *    the shared 12-slot gate would recreate the queue-erodes-abort-window
 *    accuracy hazard documented in lib/scan/intake.ts:22-27.
 */

import type { DetectedProduct } from '@/lib/gemini';
import { logOp } from '@/lib/ops';
import { ScanFailedError } from './detect';
import { SCAN_MODEL, usageFromOutcomes } from './intake';
import {
  type ScanJobDoc,
  claimNextJob,
  completeJob,
  deleteJobPhoto,
  ensureJobIndexes,
  failJob,
  heartbeat,
  readJobPhoto,
  reclaimStale,
  setJobStage,
  sweepOrphans,
  writeJobResult,
} from './jobs';
import { runRowsHd } from './run';
import { sumCost } from './cost';
import { callModelVertex } from './transport';
import { SCAN_SERVICE_TIER, callModelVertexFlex } from './transport-flex';

const PHOTO_CONCURRENCY =
  SCAN_SERVICE_TIER === 'flex'
    ? Math.max(1, Number(process.env.WORKER_PHOTO_CONCURRENCY) || 2)
    : 1;

const TICK_MS = 3_000;
const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 6 * 3_600_000;

let inFlight = 0;

export function startScanWorker(): void {
  // Dev HMR / double-import guard.
  const g = globalThis as { __scanWorkerStarted?: boolean };
  if (g.__scanWorkerStarted) return;
  g.__scanWorkerStarted = true;

  void (async () => {
    try {
      await ensureJobIndexes();
      await reclaimStale();
      await sweepOrphans();
    } catch (err) {
      console.warn('[scan-worker] boot housekeeping failed (non-fatal):', err instanceof Error ? err.message : err);
    }
    console.log(
      `[scan-worker] started — tier=${SCAN_SERVICE_TIER}, photoConcurrency=${PHOTO_CONCURRENCY}, model=${SCAN_MODEL}`
    );
    setInterval(() => void tick(), TICK_MS).unref();
    setInterval(() => void sweepOrphans().catch(() => {}), SWEEP_MS).unref();
  })();
}

async function tick(): Promise<void> {
  while (inFlight < PHOTO_CONCURRENCY) {
    let job: ScanJobDoc | null;
    try {
      job = await claimNextJob();
    } catch (err) {
      console.warn('[scan-worker] claim failed:', err instanceof Error ? err.message : err);
      return;
    }
    if (!job) return;
    inFlight++;
    void runJob(job).finally(() => {
      inFlight--;
    });
  }
}

async function runJob(job: ScanJobDoc): Promise<void> {
  const id = job._id;
  if (!id) return;
  const hb = setInterval(() => void heartbeat(id).catch(() => {}), HEARTBEAT_MS);
  const t0 = Date.now();
  try {
    const photo = await readJobPhoto(job.hash).catch(() => null);
    if (!photo) {
      await failJob(id, 'photo lost (restart/sweep before processing) — resubmit');
      return;
    }

    const { entries, outcomes } = await runRowsHd(photo, {
      callModel: SCAN_SERVICE_TIER === 'flex' ? callModelVertexFlex : callModelVertex,
      modelId: SCAN_MODEL,
      bandConcurrency: 8,
      gridConcurrency: 6,
      tag: `vision-job:${job.hash.slice(0, 8)}`,
      onStage: (stage) => void setJobStage(id, stage).catch(() => {}),
    });

    // Same product shape the sync route returns (intake.ts).
    const products: DetectedProduct[] = entries.map((e) => ({
      name: e.name,
      box_2d: e.box_2d,
      thumbnail: e.thumbnail,
    }));
    const usage = usageFromOutcomes(outcomes, products);
    const estimatedCostUsd = sumCost(outcomes);

    await writeJobResult(job.hash, products);
    await deleteJobPhoto(job.hash); // free the disk the moment the pipeline succeeds
    await completeJob(id, { count: products.length, usage, estimatedCostUsd });
    await logOp('snap', usage, { estimatedCostUsd, serviceTier: SCAN_SERVICE_TIER, jobHash: job.hash });
    console.log(
      `[scan-worker] job ${job.hash.slice(0, 8)} done — ${products.length} products, ${Math.round((Date.now() - t0) / 1000)}s, tier=${SCAN_SERVICE_TIER}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Meter a failed run honestly — the band calls that DID run were billed.
    if (err instanceof ScanFailedError && err.outcomes.length > 0) {
      const usage = usageFromOutcomes(err.outcomes, []);
      await logOp('snap', usage, {
        estimatedCostUsd: sumCost(err.outcomes),
        serviceTier: SCAN_SERVICE_TIER,
        failed: true,
        jobHash: job.hash,
      });
    }
    console.error(`[scan-worker] job ${job.hash.slice(0, 8)} failed after ${Math.round((Date.now() - t0) / 1000)}s: ${msg}`);
    await failJob(id, msg).catch(() => {});
  } finally {
    clearInterval(hb);
  }
}

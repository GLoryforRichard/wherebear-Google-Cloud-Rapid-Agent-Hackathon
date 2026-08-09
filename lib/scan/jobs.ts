/**
 * Server-side scan-job store: the async intake queue's source of truth.
 *
 * Storage split (both stores are tiny by design — hard platform caps):
 *  - Mongo `scan_jobs` (M0 = 512MB total): status/stage/usage ONLY. No
 *    photos, no products — a 50-SKU result with thumbnails is ~1.25MB and
 *    a deep queue of those would eat the cluster.
 *  - VM disk (~1.8G free): `<SCAN_JOBS_DIR>/<hash>/photo.bin` until the
 *    pipeline SUCCEEDS (then deleted immediately), `result.json` until the
 *    client acks (DELETE) or TTL. The accept cap (SCAN_JOBS_MAX_QUEUED)
 *    bounds worst-case disk at cap × 20MB; the client's IndexedDB outbox is
 *    the deep buffer behind the 429 backpressure.
 *
 * Idempotency: one job per photo content hash (unique index). Re-submitting
 * bytes the server already knows returns the existing queued/running/done
 * job — client retry storms cannot double-bill. A FAILED job is reset to
 * queued on re-submit (attempts back to 0: a manual retry buys a fresh
 * budget), otherwise a failed photo would be pinned to its failure forever.
 *
 * Crash safety: running jobs carry a leaseAt heartbeat; a lease older than
 * LEASE_STALE_MS is reclaimed to queued (photo still on disk), but only
 * MAX_JOB_ATTEMPTS times — a photo that keeps killing the worker parks at
 * failed instead of crash-looping pm2 forever. result.json is written
 * tmp+rename so a poll can never read torn JSON.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Collection, ObjectId } from 'mongodb';
import type { UsageTotals } from '@/lib/cost';
import type { DetectedProduct } from '@/lib/gemini';
import { getDb } from '@/lib/mongodb';

export type ScanJobStatus = 'queued' | 'running' | 'done' | 'failed';
export type ScanJobStage = 'rows' | 'detect' | 'readout' | 'post';

export interface ScanJobDoc {
  _id?: ObjectId;
  /** sha1 of the photo bytes — unique index, the idempotency key. */
  hash: string;
  /** Informational; the queue client keeps its own copy for the save step. */
  aisle: string;
  status: ScanJobStatus;
  stage?: ScanJobStage;
  /** Processing claims (incremented on claim, reset on manual re-submit). */
  attempts: number;
  count?: number;
  usage?: UsageTotals;
  estimatedCostUsd?: number | null;
  serviceTier: 'standard' | 'flex';
  error?: string;
  leaseAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  /** Mongo TTL index target. */
  expiresAt: Date;
}

const JOBS_DIR = process.env.SCAN_JOBS_DIR || path.join(os.tmpdir(), 'wherebear-scan-jobs');
export const SCAN_JOBS_MAX_QUEUED = Math.max(1, Number(process.env.SCAN_JOBS_MAX_QUEUED) || 20);
const TTL_HOURS = Math.max(1, Number(process.env.SCAN_JOBS_TTL_HOURS) || 24);
const LEASE_STALE_MS = 2 * 60_000;
const MAX_JOB_ATTEMPTS = 3;

async function jobsCol(): Promise<Collection<ScanJobDoc>> {
  const db = await getDb();
  return db.collection<ScanJobDoc>('scan_jobs');
}

let indexesEnsured = false;
export async function ensureJobIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const col = await jobsCol();
  await col.createIndex({ hash: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await col.createIndex({ status: 1, createdAt: 1 });
  indexesEnsured = true;
}

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function jobDir(hash: string): string {
  return path.join(JOBS_DIR, hash);
}

export async function writeJobPhoto(hash: string, buf: Buffer): Promise<void> {
  await mkdir(jobDir(hash), { recursive: true });
  await writeFile(path.join(jobDir(hash), 'photo.bin'), buf);
}

export async function readJobPhoto(hash: string): Promise<Buffer> {
  return readFile(path.join(jobDir(hash), 'photo.bin'));
}

export async function deleteJobPhoto(hash: string): Promise<void> {
  await rm(path.join(jobDir(hash), 'photo.bin'), { force: true });
}

export async function writeJobResult(hash: string, products: DetectedProduct[]): Promise<void> {
  await mkdir(jobDir(hash), { recursive: true });
  const file = path.join(jobDir(hash), 'result.json');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(products));
  await rename(tmp, file);
}

export async function readJobResult(hash: string): Promise<DetectedProduct[] | null> {
  try {
    return JSON.parse(await readFile(path.join(jobDir(hash), 'result.json'), 'utf8')) as DetectedProduct[];
  } catch {
    return null;
  }
}

export async function deleteJobDir(hash: string): Promise<void> {
  await rm(jobDir(hash), { recursive: true, force: true });
}

function expiry(): Date {
  return new Date(Date.now() + TTL_HOURS * 3_600_000);
}

export async function activeJobCount(): Promise<number> {
  const col = await jobsCol();
  return col.countDocuments({ status: { $in: ['queued', 'running'] } });
}

export async function getJob(id: string): Promise<ScanJobDoc | null> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }
  const col = await jobsCol();
  return col.findOne({ _id: oid });
}

export async function createOrGetJob(
  hash: string,
  aisle: string,
  serviceTier: 'standard' | 'flex'
): Promise<ScanJobDoc> {
  const col = await jobsCol();
  const now = new Date();
  const existing = await col.findOne({ hash });
  if (existing) {
    if (existing.status !== 'failed') return existing;
    const requeued = await col.findOneAndUpdate(
      { hash, status: 'failed' },
      {
        $set: { status: 'queued' as const, attempts: 0, aisle, serviceTier, updatedAt: now, expiresAt: expiry() },
        $unset: { error: '', stage: '', leaseAt: '' },
      },
      { returnDocument: 'after' }
    );
    if (requeued) return requeued;
    // Lost a race with another re-submit — whatever state it's in now wins.
    return (await col.findOne({ hash })) ?? existing;
  }
  const doc: ScanJobDoc = {
    hash,
    aisle,
    status: 'queued',
    attempts: 0,
    serviceTier,
    createdAt: now,
    updatedAt: now,
    expiresAt: expiry(),
  };
  try {
    const res = await col.insertOne(doc);
    doc._id = res.insertedId;
    return doc;
  } catch (err) {
    // Unique-index race with a concurrent submit of the same bytes.
    if ((err as { code?: number })?.code === 11000) {
      const winner = await col.findOne({ hash });
      if (winner) return winner;
    }
    throw err;
  }
}

export async function claimNextJob(): Promise<ScanJobDoc | null> {
  const col = await jobsCol();
  return col.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running' as const, leaseAt: new Date(), updatedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

export async function heartbeat(id: ObjectId): Promise<void> {
  const col = await jobsCol();
  await col.updateOne({ _id: id, status: 'running' }, { $set: { leaseAt: new Date() } });
}

export async function setJobStage(id: ObjectId, stage: ScanJobStage): Promise<void> {
  const col = await jobsCol();
  await col.updateOne({ _id: id, status: 'running' }, { $set: { stage, updatedAt: new Date() } });
}

export async function completeJob(
  id: ObjectId,
  result: { count: number; usage: UsageTotals; estimatedCostUsd: number | null }
): Promise<void> {
  const col = await jobsCol();
  await col.updateOne(
    { _id: id },
    {
      $set: {
        status: 'done' as const,
        count: result.count,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
        updatedAt: new Date(),
        expiresAt: expiry(),
      },
      $unset: { leaseAt: '', stage: '' },
    }
  );
}

export async function failJob(id: ObjectId, error: string): Promise<void> {
  const col = await jobsCol();
  await col.updateOne(
    { _id: id },
    {
      $set: { status: 'failed' as const, error: error.slice(0, 500), updatedAt: new Date(), expiresAt: expiry() },
      $unset: { leaseAt: '', stage: '' },
    }
  );
}

/** Re-queue running jobs whose lease went stale (worker died mid-photo);
 *  a job that keeps losing its lease parks at failed (poison guard). */
export async function reclaimStale(): Promise<void> {
  const col = await jobsCol();
  const cutoff = new Date(Date.now() - LEASE_STALE_MS);
  await col.updateMany(
    { status: 'running', leaseAt: { $lt: cutoff }, attempts: { $gte: MAX_JOB_ATTEMPTS } },
    {
      $set: {
        status: 'failed' as const,
        error: `lease lost ${MAX_JOB_ATTEMPTS} times (worker crash mid-photo?) — resubmit to retry`,
        updatedAt: new Date(),
      },
      $unset: { leaseAt: '', stage: '' },
    }
  );
  await col.updateMany(
    { status: 'running', leaseAt: { $lt: cutoff } },
    { $set: { status: 'queued' as const, updatedAt: new Date() }, $unset: { leaseAt: '', stage: '' } }
  );
}

/** Delete job dirs whose Mongo doc is gone (TTL-expired or acked). */
export async function sweepOrphans(): Promise<void> {
  let dirs: string[];
  try {
    dirs = await readdir(JOBS_DIR);
  } catch {
    return; // dir doesn't exist yet
  }
  if (dirs.length === 0) return;
  const col = await jobsCol();
  const live = new Set(
    (await col.find({ hash: { $in: dirs } }, { projection: { hash: 1 } }).toArray()).map((d) => d.hash)
  );
  for (const dir of dirs) {
    if (!live.has(dir)) {
      await rm(path.join(JOBS_DIR, dir), { recursive: true, force: true }).catch(() => {});
    }
  }
}

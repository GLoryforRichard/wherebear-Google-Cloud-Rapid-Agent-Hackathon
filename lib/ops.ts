/**
 * Operation analytics: log every billable user operation to `op_events` and
 * aggregate by day for the dashboard.
 *
 * One row per operation: type + timestamp + the run's UsageTotals (token /
 * byte counters). Logging is best-effort — it must never throw into a
 * request path.
 */

import { ObjectId } from 'mongodb';
import { getDb } from './mongodb';
import { UsageTotals, EMPTY_USAGE, addUsage } from './cost';

export type OpType = 'snap' | 'voice' | 'identify' | 'search' | 'save';

export interface DailyOpStat {
  date: string;        // YYYY-MM-DD (America/Toronto)
  type: OpType;
  count: number;
}

// Bucket days in the store's local timezone so "today" lines up with the
// worker's day, not UTC.
const TZ = 'America/Toronto';

export async function logOp(type: OpType, usage: Partial<UsageTotals>): Promise<void> {
  try {
    const full = addUsage({ ...EMPTY_USAGE }, usage);
    const db = await getDb();
    await db.collection('op_events').insertOne({
      type,
      ts: new Date(),
      usage: full,
    });
  } catch (err) {
    // Never break the actual operation because analytics failed.
    console.error('[ops] logOp failed:', err instanceof Error ? err.message : err);
  }
}

/** Per-day, per-type counts + summed cost over the last `days` days. */
export async function getDailyStats(days = 30): Promise<DailyOpStat[]> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.collection('op_events').aggregate([
    { $match: { ts: { $gte: since } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: TZ } },
          type: '$type',
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.date': -1 } },
  ]).toArray();

  return rows.map(r => {
    const id = r._id as { date: string; type: OpType };
    return {
      date: id.date,
      type: id.type,
      count: r.count as number,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Search history — every query + its result, recorded deterministically at
// the end of each /api/search run (NOT via the agent's optional log_search
// tool, which it sometimes skips and which never captured the actual result).
// ─────────────────────────────────────────────────────────────────────────

/** Worker feedback on a search result. `correct` names which candidate was the
 *  right one; `wrong` means none of them were. null = not yet rated. */
export type SearchFeedback =
  | { verdict: 'correct'; product: string }
  | { verdict: 'wrong' }
  | null;

export interface SearchLogCandidate {
  canonical_name: string;
  aisles: string[];
  score: number | null;
  evidence_count: number | null;
}

export interface SearchLogEntry {
  id: string;
  query: string;
  found: boolean;
  product: string | null;
  aisles: string[];
  candidates: SearchLogCandidate[];
  answer_en: string | null;
  answer_zh: string | null;
  feedback: SearchFeedback;
  ts: string | Date;
}

/** Record one finished search. `result` is Agent B's finish `data` (or null). */
export async function logSearchHistory(
  query: string,
  result: Record<string, unknown> | null,
): Promise<string | null> {
  try {
    const product = result?.product as
      | { canonical_name?: string; aisles?: string[]; latest_aisle?: string }
      | null
      | undefined;
    const aisles = product?.aisles ?? (product?.latest_aisle ? [product.latest_aisle] : []);
    // Slim candidate list for the search-log detail view (no thumbnails — the
    // detail view is text-only; images can be re-fetched by name if ever needed).
    const rawCands = Array.isArray((result as Record<string, unknown> | null)?.candidates)
      ? ((result as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
      : [];
    const candidates = rawCands.map(c => ({
      canonical_name: (c.canonical_name as string) ?? '',
      aisles: (c.aisles as string[]) ?? (c.latest_aisle ? [c.latest_aisle as string] : []),
      score: typeof c.score === 'number' ? c.score : null,
      evidence_count: typeof c.evidence_count === 'number' ? c.evidence_count : null,
    }));
    const db = await getDb();
    const res = await db.collection('search_history').insertOne({
      query,
      found: !!product,
      product: product?.canonical_name ?? null,
      aisles,
      candidates,
      answer_en: (result?.answer_en as string) ?? (result?.answer as string) ?? null,
      answer_zh: (result?.answer_zh as string) ?? null,
      feedback: null,   // worker rates it later via setSearchFeedback
      ts: new Date(),
    });
    return res.insertedId.toString();
  } catch (err) {
    console.error('[ops] logSearchHistory failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getRecentSearches(limit = 100): Promise<SearchLogEntry[]> {
  const db = await getDb();
  const rows = await db.collection('search_history').find({}).sort({ ts: -1 }).limit(limit).toArray();
  return rows.map(r => ({
    id: r._id.toString(),
    query: (r.query as string) ?? '',
    found: !!r.found,
    product: (r.product as string) ?? null,
    aisles: (r.aisles as string[]) ?? [],
    candidates: (r.candidates as SearchLogCandidate[]) ?? [],
    answer_en: (r.answer_en as string) ?? null,
    answer_zh: (r.answer_zh as string) ?? null,
    feedback: (r.feedback as SearchFeedback) ?? null,
    ts: r.ts as Date,
  }));
}

/** Record worker feedback on a logged search (idempotent — overwrites). */
export async function setSearchFeedback(id: string, feedback: SearchFeedback): Promise<boolean> {
  try {
    const db = await getDb();
    const res = await db.collection('search_history').updateOne(
      { _id: new ObjectId(id) },
      { $set: { feedback, feedback_at: new Date() } },
    );
    return res.matchedCount > 0;
  } catch (err) {
    console.error('[ops] setSearchFeedback failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

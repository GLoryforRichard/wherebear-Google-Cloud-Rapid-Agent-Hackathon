import { Db } from 'mongodb';
import { FinishCandidate } from '@/lib/agents/tools-b';
import { getAisleLastScans, classifyAisles } from '@/lib/aisle-freshness';

/**
 * Backfill thumbnail + freshness-ordered aisle list from Mongo for each
 * candidate, mutating in place. Shared by both search pipelines (legacy
 * agent-b and the ADK loop) so the aisle-staleness rules live in one place.
 *
 * After this runs: `aisles` holds only locations with no later contradicting
 * re-scan (most recently seen first), and `stale_aisles` holds shelves that
 * were re-photographed after the last sighting without the product — the UI
 * greys those out instead of presenting them as current.
 */
export async function enrichCandidates(db: Db, list: FinishCandidate[]): Promise<void> {
  if (list.length === 0) return;
  const lastScans = await getAisleLastScans(db).catch(() => new Map<string, Date>());
  await Promise.all(
    list.map(async (c) => {
      if (!c.canonical_name) return;
      try {
        const e = await db.collection('products').findOne(
          { canonical_name: c.canonical_name },
          { projection: { thumbnail: 1, aisles: 1, latest_aisle: 1, aisle_seen: 1 } }
        );
        if (!e) return;
        if (typeof e.thumbnail === 'string') c.thumbnail = e.thumbnail;
        const { fresh, stale } = classifyAisles(
          e as { aisles?: string[]; latest_aisle?: string; aisle_seen?: Record<string, unknown> },
          lastScans
        );
        if (fresh.length || stale.length) {
          c.aisles = fresh;
          c.stale_aisles = stale;
        }
      } catch {
        /* non-fatal — that card just won't show an image / extra aisles */
      }
    })
  );
}

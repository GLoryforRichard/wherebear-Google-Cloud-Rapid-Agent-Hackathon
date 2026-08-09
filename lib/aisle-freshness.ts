import { Db } from 'mongodb';

/**
 * Sighting-freshness for a product's aisle list.
 *
 * A product doc accumulates every shelf it was ever seen on (`aisles` +
 * `aisle_seen.<aisle> = last sighting`), but nothing ever removes an aisle —
 * so after a SKU moves, the vacated shelf keeps showing up in search forever.
 * Instead of deleting evidence, we compare each sighting against the shelf's
 * most recent scan (`shelf_evidence`): if the shelf was re-photographed well
 * AFTER the product was last seen there and the product didn't show up, that
 * location is probably stale. Display-only — no data is removed, so a partial
 * re-scan of a long aisle can only grey a badge out, never lose the record.
 */
export interface AisleFreshness {
  /** Aisles with no later contradicting scan, most recently seen first. */
  fresh: string[];
  /** Aisles re-scanned ≥ RESCAN_MARGIN after the last sighting without the
   *  product being detected again, while a fresher sighting exists elsewhere
   *  — likely where the item moved FROM. */
  stale: string[];
}

/**
 * A single aisle is photographed in several sections over a few minutes, and
 * each section's save stamps a slightly different time. The margin keeps one
 * multi-photo session from marking its own earlier sections stale; anything
 * beyond it is a genuine later re-scan.
 */
const RESCAN_MARGIN_MS = 6 * 60 * 60 * 1000;

/** shelf_evidence changes only when someone uploads, so a short TTL cache
 *  spares every search request one aggregation. */
const CACHE_TTL_MS = 60_000;
let cache: { at: number; scans: Map<string, Date> } | null = null;

export async function getAisleLastScans(db: Db): Promise<Map<string, Date>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.scans;
  const rows = await db
    .collection('shelf_evidence')
    .aggregate([{ $group: { _id: '$aisle', last: { $max: '$timestamp' } } }])
    .toArray();
  const scans = new Map<string, Date>();
  for (const r of rows) {
    if (r._id && r.last instanceof Date) scans.set(String(r._id), r.last);
  }
  cache = { at: Date.now(), scans };
  return scans;
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // MCP responses carry EJSON: { $date: "ISO" } or { $date: { $numberLong: "ms" } }.
  // mongo-ops only revives top-level fields, and aisle_seen is nested.
  if (v && typeof v === 'object' && '$date' in (v as Record<string, unknown>)) {
    const inner = (v as { $date: unknown }).$date;
    if (inner && typeof inner === 'object' && '$numberLong' in (inner as Record<string, unknown>)) {
      return toDate(Number((inner as { $numberLong: string }).$numberLong));
    }
    return toDate(inner);
  }
  return null;
}

export function classifyAisles(
  doc: {
    aisles?: string[];
    latest_aisle?: string;
    aisle_seen?: Record<string, unknown>;
  },
  lastScans: Map<string, Date>
): AisleFreshness {
  const all = Array.from(
    new Set(
      (doc.aisles && doc.aisles.length ? doc.aisles : [doc.latest_aisle]).filter(
        (a): a is string => typeof a === 'string' && a.length > 0
      )
    )
  );

  const fresh: { aisle: string; seenAt: number }[] = [];
  const stale: { aisle: string; seenAt: number }[] = [];
  for (const aisle of all) {
    const seen = toDate(doc.aisle_seen?.[aisle]);
    const scanned = lastScans.get(aisle);
    // No sighting timestamp (legacy doc) → can't judge, fail open as fresh.
    const isStale =
      !!seen && !!scanned && scanned.getTime() - seen.getTime() > RESCAN_MARGIN_MS;
    // Undated sightings sort after dated ones, latest_aisle first among them.
    const seenAt = seen ? seen.getTime() : aisle === doc.latest_aisle ? 1 : 0;
    (isStale ? stale : fresh).push({ aisle, seenAt });
  }

  const byRecency = (a: { seenAt: number }, b: { seenAt: number }) => b.seenAt - a.seenAt;

  // A stale marking needs a fresher sighting elsewhere. Long aisles are
  // photographed in sections across different days, so "the aisle was
  // re-scanned without this product" is routinely just "a DIFFERENT section
  // was re-scanned" — measured on real data that would grey out ~23% of the
  // catalog. But when the product HAS a current location, a contradicted
  // older one is almost certainly where it moved FROM, so greying it is safe.
  if (fresh.length === 0) {
    return { fresh: stale.sort(byRecency).map(x => x.aisle), stale: [] };
  }
  return {
    fresh: fresh.sort(byRecency).map(x => x.aisle),
    stale: stale.sort(byRecency).map(x => x.aisle),
  };
}

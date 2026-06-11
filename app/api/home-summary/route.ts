import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lightweight rollup for the home dashboard cards. Direct MongoDB driver (no
 * MCP) — products total, today's searches, recent hit-rate + last found item.
 * Best-effort: any failure returns ok:false and the home cards fall back to
 * dashes.
 */
export async function GET() {
  try {
    const db = await getDb();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    const [products, todaySearches, recent] = await Promise.all([
      db.collection('products').countDocuments(),
      db.collection('search_history').countDocuments({ ts: { $gte: dayStart } }),
      db.collection('search_history')
        .find({}, { projection: { found: 1, product: 1, ts: 1 } })
        .sort({ ts: -1 })
        .limit(50)
        .toArray(),
    ]);

    const found = recent.filter((r) => r.found).length;
    const hitRate = recent.length ? Math.round((found / recent.length) * 100) : null;
    const lastFound = (recent.find((r) => r.found && r.product)?.product as string) ?? null;

    return NextResponse.json({ ok: true, products, todaySearches, hitRate, lastFound });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ActivityItem {
  type: 'snap' | 'find';
  title: string;
  subtitle?: string;
  timestamp: string;
}

export async function GET() {
  try {
    const db = await getDb();
    const [snaps, finds] = await Promise.all([
      db.collection('shelf_evidence')
        .find({})
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray(),
      db.collection('search_logs')
        .find({})
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray(),
    ]);

    const items: ActivityItem[] = [];

    for (const s of snaps) {
      items.push({
        type: 'snap',
        title: `Snapped ${s.aisle}`,
        subtitle: `${(s.products_detected || []).length} products`,
        timestamp: new Date(s.timestamp).toISOString(),
      });
    }

    for (const f of finds) {
      const found = (f.results_found ?? 0) > 0;
      items.push({
        type: 'find',
        title: found
          ? `Found "${f.query}"`
          : `No result for "${f.query}"`,
        subtitle: f.resolved_intent || undefined,
        timestamp: new Date(f.timestamp).toISOString(),
      });
    }

    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return NextResponse.json({ ok: true, items: items.slice(0, 30) });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';

export async function GET() {
  try {
    const db = await getDb();
    const collections = await db.listCollections().toArray();
    const names = collections.map(c => c.name).sort();

    const counts: Record<string, number> = {};
    for (const name of ['shelf_evidence', 'products', 'search_logs']) {
      counts[name] = await db.collection(name).countDocuments();
    }

    return NextResponse.json({
      ok: true,
      db: db.databaseName,
      collections: names,
      counts,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

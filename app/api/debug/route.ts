import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();

    const [shelfEvidence, products, searchLogs, counts] = await Promise.all([
      db.collection('shelf_evidence').find({}).sort({ timestamp: -1 }).limit(50).toArray(),
      db.collection('products').find({}).sort({ updated_at: -1 }).limit(200).toArray(),
      db.collection('search_logs').find({}).sort({ timestamp: -1 }).limit(50).toArray(),
      Promise.all([
        db.collection('shelf_evidence').countDocuments(),
        db.collection('products').countDocuments(),
        db.collection('search_logs').countDocuments(),
      ]),
    ]);

    return NextResponse.json({
      ok: true,
      db: db.databaseName,
      counts: {
        shelf_evidence: counts[0],
        products: counts[1],
        search_logs: counts[2],
      },
      shelf_evidence: shelfEvidence,
      products,
      search_logs: searchLogs,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

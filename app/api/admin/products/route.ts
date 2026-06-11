import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { adminWriteGuard } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildSearchText(canonical: string, aliases: string[]): string {
  return Array.from(new Set([canonical, ...aliases].map(s => s.trim()).filter(Boolean))).join(' · ');
}

export async function GET(req: NextRequest) {
  try {
    const aisle = req.nextUrl.searchParams.get('aisle')?.trim();
    const db = await getDb();

    if (aisle) {
      // List one shelf's products
      const rows = await db.collection('products')
        .find({ latest_aisle: aisle }, { projection: { embedding: 0 } })
        .sort({ updated_at: -1 })
        .limit(200)
        .toArray();
      return NextResponse.json({
        ok: true,
        aisle,
        count: rows.length,
        products: rows.map(r => ({ ...r, _id: r._id.toString() })),
      });
    }

    // No aisle: return counts per shelf for the index view
    const grouped = await db.collection('products').aggregate([
      { $group: { _id: '$latest_aisle', count: { $sum: 1 } } },
    ]).toArray();

    const counts: Record<string, number> = {};
    for (const g of grouped) {
      if (g._id) counts[String(g._id)] = g.count;
    }

    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/products?aisle=A2
 *
 * Removes every product whose latest_aisle matches. Note: a product whose
 * latest_aisle is currently A2 may have been seen on other shelves in the
 * past — we only track the most recent — so deleting wipes the doc, not
 * a per-aisle association. Re-scanning the SKU later inserts it fresh.
 */
export async function DELETE(req: NextRequest) {
  const locked = adminWriteGuard();
  if (locked) return locked;
  try {
    const aisle = req.nextUrl.searchParams.get('aisle')?.trim();
    if (!aisle) {
      return NextResponse.json(
        { ok: false, error: 'aisle query param is required' },
        { status: 400 }
      );
    }
    const db = await getDb();
    const result = await db.collection('products').deleteMany({ latest_aisle: aisle });
    return NextResponse.json({
      ok: true,
      aisle,
      deleted: result.deletedCount ?? 0,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

/**
 * POST /api/admin/products — manually add one product to a shelf. Mirrors the
 * shelf-save doc shape (search_text from canonical + aliases) so Atlas
 * auto-embed indexes it and it becomes searchable like a scanned product.
 */
export async function POST(req: NextRequest) {
  const locked = adminWriteGuard();
  if (locked) return locked;
  try {
    const body = await req.json() as {
      canonical_name?: string; category?: string; aliases?: string[];
      latest_aisle?: string; evidence_count?: number;
    };
    const canonical = (body.canonical_name || '').trim();
    const aisle = (body.latest_aisle || '').trim();
    if (!canonical || !aisle) {
      return NextResponse.json(
        { ok: false, error: 'canonical_name and latest_aisle are required' },
        { status: 400 }
      );
    }
    const aliases = Array.from(new Set(
      [canonical, ...(Array.isArray(body.aliases) ? body.aliases : [])]
        .map(s => s.trim()).filter(Boolean)
    ));
    const now = new Date();
    const doc = {
      canonical_name: canonical,
      aliases,
      search_text: buildSearchText(canonical, aliases),
      category: body.category?.trim() || undefined,
      latest_aisle: aisle,
      aisles: [aisle],
      evidence_count: typeof body.evidence_count === 'number'
        ? Math.max(1, Math.floor(body.evidence_count)) : 1,
      created_at: now,
      updated_at: now,
    };
    const db = await getDb();
    const res = await db.collection('products').insertOne(doc);
    return NextResponse.json({ ok: true, product: { ...doc, _id: res.insertedId.toString() } });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

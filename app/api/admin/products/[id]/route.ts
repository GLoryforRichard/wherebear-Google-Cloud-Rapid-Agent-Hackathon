import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { adminWriteGuard } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PatchBody {
  canonical_name?: string;
  aliases?: string[];
  category?: string;
  latest_aisle?: string;
  evidence_count?: number;
}

function buildSearchText(canonical: string, aliases: string[]): string {
  return Array.from(new Set([canonical, ...aliases].map(s => s.trim()).filter(Boolean))).join(' · ');
}

function parseId(raw: string): ObjectId | null {
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const locked = adminWriteGuard();
  if (locked) return locked;
  const { id } = await ctx.params;
  const objId = parseId(id);
  if (!objId) {
    return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 });
  }

  try {
    const body = (await req.json()) as PatchBody;
    const db = await getDb();
    const col = db.collection('products');

    const existing = await col.findOne({ _id: objId });
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }

    const canonical = (body.canonical_name ?? existing.canonical_name).trim();
    const aliases = Array.isArray(body.aliases)
      ? Array.from(new Set([canonical, ...body.aliases].map(s => s.trim()).filter(Boolean)))
      : existing.aliases;

    const update: Record<string, unknown> = {
      canonical_name: canonical,
      aliases,
      search_text: buildSearchText(canonical, aliases),
      updated_at: new Date(),
    };
    if (body.category !== undefined) update.category = body.category;
    if (body.latest_aisle !== undefined) update.latest_aisle = body.latest_aisle;
    if (typeof body.evidence_count === 'number' && Number.isFinite(body.evidence_count)) {
      update.evidence_count = Math.max(0, Math.floor(body.evidence_count));
    }

    await col.updateOne({ _id: objId }, { $set: update });
    const fresh = await col.findOne({ _id: objId }, { projection: { embedding: 0 } });
    return NextResponse.json({
      ok: true,
      product: fresh ? { ...fresh, _id: fresh._id.toString() } : null,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const locked = adminWriteGuard();
  if (locked) return locked;
  const { id } = await ctx.params;
  const objId = parseId(id);
  if (!objId) {
    return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 });
  }
  try {
    const db = await getDb();
    const res = await db.collection('products').deleteOne({ _id: objId });
    return NextResponse.json({ ok: true, deleted: res.deletedCount });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

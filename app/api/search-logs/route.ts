import { NextResponse } from 'next/server';
import { getRecentSearches } from '@/lib/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const logs = await getRecentSearches(100);
    return NextResponse.json({ ok: true, logs });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

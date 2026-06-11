import { NextRequest, NextResponse } from 'next/server';
import { getDailyStats } from '@/lib/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const daysParam = Number(req.nextUrl.searchParams.get('days'));
    const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 30;
    const stats = await getDailyStats(days);
    return NextResponse.json({ ok: true, days, stats });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

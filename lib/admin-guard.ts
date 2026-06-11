import { NextResponse } from 'next/server';

/**
 * The deployment is public (hackathon judging) while the database serves a
 * real store, so admin WRITE endpoints are hard-locked server-side — the UI
 * only simulates writes locally, and even a hand-crafted curl gets a 403.
 * Set ADMIN_WRITES=unlocked in the environment to re-enable real writes
 * (e.g. for in-store use after the judging window).
 */
export function adminWriteGuard(): NextResponse | null {
  if (process.env.ADMIN_WRITES === 'unlocked') return null;
  return NextResponse.json(
    {
      ok: false,
      error:
        'Write actions are disabled on this public demo deployment — the database serves a real store. (Set ADMIN_WRITES=unlocked server-side to re-enable.)',
    },
    { status: 403 },
  );
}

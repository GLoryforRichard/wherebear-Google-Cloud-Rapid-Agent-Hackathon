import { NextResponse } from 'next/server';
import { mcpAggregate } from '@/lib/mcp/mongo-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  process.env.MCP_DEBUG = '1';
  try {
    const result = await mcpAggregate({
      collection: 'products',
      pipeline: [
        {
          $vectorSearch: {
            index: 'vector_index',
            path: 'search_text',
            query: '年糕',
            numCandidates: 50,
            limit: 3,
          },
        },
        {
          $project: {
            _id: { $toString: '$_id' },
            canonical_name: 1,
            latest_aisle: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ],
    });
    return NextResponse.json({ ok: true, count: result.data.length, via: result.via, results: result.data });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

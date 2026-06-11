import { NextResponse } from 'next/server';
import { listMongoMcpTools, callMongoMcp, extractMcpText } from '@/lib/mcp/mongo-mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  try {
    const tools = await listMongoMcpTools();
    const toolNames = (tools.tools || []).map(t => ({ name: t.name, desc: t.description?.slice(0, 80) }));

    let pingResult: unknown = null;
    try {
      const ping = await callMongoMcp('list-databases', {});
      pingResult = extractMcpText(ping).slice(0, 500);
    } catch (e) {
      pingResult = `list-databases failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    return NextResponse.json({
      ok: true,
      tool_count: toolNames.length,
      tools: toolNames,
      ping: pingResult,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

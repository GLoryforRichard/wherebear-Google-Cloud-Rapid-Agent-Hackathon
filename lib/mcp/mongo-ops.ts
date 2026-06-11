/**
 * High-level MongoDB operations.
 *
 * The default path routes through the MongoDB MCP Server. If the MCP
 * subprocess can't be spawned (e.g. Vercel serverless), we silently
 * fall back to the direct Node.js driver so the app keeps working.
 *
 * Each result is tagged with `via: 'mcp' | 'sdk'` so the UI can render
 * a badge that reflects what actually happened.
 */

import { ObjectId } from 'mongodb';
import { callMongoMcp, extractMcpText } from './mongo-mcp';
import { getDb } from '@/lib/mongodb';

const DB = process.env.MONGODB_DB || 'wherebear';

// One-shot probe so we don't pay the spawn-failure tax on every call.
let mcpUsable: boolean | null = null;

async function tryMcp<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  if (mcpUsable === false) return { ok: false, reason: 'mcp previously failed' };
  try {
    const data = await fn();
    mcpUsable = true;
    return { ok: true, data };
  } catch (err) {
    if (mcpUsable === null) {
      // First-time failure — assume the environment can't spawn the
      // subprocess at all and skip MCP for the rest of the process life.
      mcpUsable = false;
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function stripUntrusted(text: string): string {
  return text
    .replace(/<untrusted-user-data-[\w-]+>/g, '')
    .replace(/<\/untrusted-user-data-[\w-]+>/g, '')
    .replace(/WARNING: Executing[^\n]*/g, '')
    .replace(/The following section[^\n]*/g, '')
    .trim();
}

function parseJsonish<T>(raw: string, fallback: T): T {
  const cleaned = stripUntrusted(raw);
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed as T;
      return [parsed] as unknown as T;
    } catch {
      /* fall through */
    }
  }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(fallback)) return [parsed] as unknown as T;
      return parsed as T;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

// EJSON helpers — Atlas MCP responses serialize ObjectIds as { $oid: "..." }
// and dates as { $date: "..." }. Direct SDK calls expect real instances.
function reviveEJsonId(v: unknown): unknown {
  if (v && typeof v === 'object' && '$oid' in (v as Record<string, unknown>)) {
    try {
      return new ObjectId(String((v as { $oid: string }).$oid));
    } catch {
      return v;
    }
  }
  return v;
}

function reviveEJsonDate(v: unknown): unknown {
  if (v && typeof v === 'object' && '$date' in (v as Record<string, unknown>)) {
    return new Date(String((v as { $date: string }).$date));
  }
  return v;
}

function reviveEJsonDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveEJsonDeep);
  if (!v || typeof v !== 'object') return v;
  if ('$oid' in (v as Record<string, unknown>)) return reviveEJsonId(v);
  if ('$date' in (v as Record<string, unknown>)) return reviveEJsonDate(v);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    out[key] = reviveEJsonDeep(value);
  }
  return out;
}

function reviveDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') out[k] = reviveEJsonId(v);
    else if (v && typeof v === 'object' && '$date' in (v as Record<string, unknown>)) out[k] = reviveEJsonDate(v);
    else out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Find
// ─────────────────────────────────────────────────────────────

export interface McpFindArgs {
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  limit?: number;
}

export interface OpResult<T> {
  data: T;
  via: 'mcp' | 'sdk';
}

export async function mcpFind<T = Record<string, unknown>>(args: McpFindArgs): Promise<OpResult<T[]>> {
  const mcp = await tryMcp(async () => {
    const raw = await callMongoMcp('find', {
      database: DB,
      collection: args.collection,
      filter: args.filter ?? {},
      projection: args.projection,
      limit: args.limit ?? 10,
    });
    return parseJsonish<T[]>(extractMcpText(raw), []);
  });
  if (mcp.ok) return { data: mcp.data, via: 'mcp' };

  // SDK fallback
  const db = await getDb();
  const cursor = db.collection(args.collection).find(args.filter ?? {}, {
    projection: args.projection,
    limit: args.limit ?? 10,
  });
  const docs = await cursor.toArray();
  return { data: docs as unknown as T[], via: 'sdk' };
}

// ─────────────────────────────────────────────────────────────
// Insert many
// ─────────────────────────────────────────────────────────────

export interface McpInsertArgs {
  collection: string;
  documents: Record<string, unknown>[];
}

export async function mcpInsertMany(args: McpInsertArgs): Promise<OpResult<{ insertedCount: number }>> {
  const mcp = await tryMcp(async () => {
    const raw = await callMongoMcp('insert-many', {
      database: DB,
      collection: args.collection,
      documents: args.documents,
    });
    const text = stripUntrusted(extractMcpText(raw));
    const countMatch = text.match(/Inserted\s+(\d+)\s+document/i);
    return { insertedCount: countMatch ? parseInt(countMatch[1], 10) : args.documents.length };
  });
  if (mcp.ok) return { data: mcp.data, via: 'mcp' };

  const db = await getDb();
  const revived = args.documents.map(reviveDoc);
  const res = await db.collection(args.collection).insertMany(revived);
  return { data: { insertedCount: res.insertedCount }, via: 'sdk' };
}

// ─────────────────────────────────────────────────────────────
// Update many
// ─────────────────────────────────────────────────────────────

export interface McpUpdateArgs {
  collection: string;
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  upsert?: boolean;
}

export async function mcpUpdateMany(args: McpUpdateArgs): Promise<OpResult<{ matched: number; modified: number }>> {
  const mcp = await tryMcp(async () => {
    const raw = await callMongoMcp('update-many', {
      database: DB,
      collection: args.collection,
      filter: args.filter,
      update: args.update,
      upsert: args.upsert ?? false,
    });
    const text = stripUntrusted(extractMcpText(raw));
    return {
      matched: parseInt(text.match(/Matched\s+(\d+)/i)?.[1] ?? '0', 10),
      modified: parseInt(text.match(/Modified\s+(\d+)/i)?.[1] ?? '0', 10),
    };
  });
  if (mcp.ok) return { data: mcp.data, via: 'mcp' };

  const db = await getDb();
  const update = reviveEJsonDeep(args.update) as Record<string, unknown>;
  const res = await db.collection(args.collection).updateMany(args.filter, update, {
    upsert: args.upsert ?? false,
  });
  return {
    data: { matched: res.matchedCount, modified: res.modifiedCount },
    via: 'sdk',
  };
}

// ─────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────

export interface McpAggregateArgs {
  collection: string;
  pipeline: Record<string, unknown>[];
}

export async function mcpAggregate<T = Record<string, unknown>>(args: McpAggregateArgs): Promise<OpResult<T[]>> {
  const mcp = await tryMcp(async () => {
    const raw = await callMongoMcp('aggregate', {
      database: DB,
      collection: args.collection,
      pipeline: args.pipeline,
    });
    return parseJsonish<T[]>(extractMcpText(raw), []);
  });
  if (mcp.ok) return { data: mcp.data, via: 'mcp' };

  const db = await getDb();
  const docs = await db.collection(args.collection).aggregate(args.pipeline).toArray();
  return { data: docs as unknown as T[], via: 'sdk' };
}

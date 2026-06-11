import { Db, ObjectId } from 'mongodb';
import { Type, FunctionDeclaration } from '@google/genai';
import { generateContentWithRetry, VISION_MODEL } from '@/lib/gemini';
import { Product, ShelfEvidence } from '@/lib/types';
import { mcpFind, mcpInsertMany, mcpUpdateMany } from '@/lib/mcp/mongo-ops';

// ─────────────────────────────────────────────────────────────
// Tool declarations sent to Gemini
// ─────────────────────────────────────────────────────────────

export const AGENT_A_TOOLS: FunctionDeclaration[] = [
  {
    name: 'find_existing_products',
    description:
      'BATCH lookup — PREFERRED over find_existing_product whenever you have 2+ products. ' +
      'One MongoDB $in query for all canonical_names at once. Returns a results map keyed by ' +
      'canonical_name, where each entry is either { found: true, product: {...} } or ' +
      '{ found: false }. Use this in Phase 1 with the entire input list.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        canonical_names: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of canonical English names to look up in one query.',
        },
      },
      required: ['canonical_names'],
    },
  },
  {
    name: 'find_existing_product',
    description:
      'DEPRECATED — single-product lookup. Use find_existing_products with a 1-element array instead. ' +
      'Returns the existing record (aliases, latest_aisle, evidence_count) or { found: false }.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        canonical_name: {
          type: Type.STRING,
          description: 'Exact canonical English name of the product to look up.',
        },
      },
      required: ['canonical_name'],
    },
  },
  {
    name: 'expand_aliases',
    description:
      'Generate Chinese aliases for a SINGLE product (2–4 strings). Prefer expand_aliases_batch when ' +
      'you have 3+ new products — it is much faster because it does one LLM call instead of N.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        canonical_name: {
          type: Type.STRING,
          description: 'Canonical English name of the product.',
        },
        category: {
          type: Type.STRING,
          description: 'Optional category hint (e.g. "sauce", "noodle", "frozen").',
        },
      },
      required: ['canonical_name'],
    },
  },
  {
    name: 'expand_aliases_batch',
    description:
      'PREFERRED for shelves with many new products. Generate Chinese aliases for many products in a ' +
      'single LLM call. Returns a map { canonical_name: [aliases…] }. Call this once near the start ' +
      'of the run with every brand-new canonical_name, then use the returned aliases when calling ' +
      'save_product for each of those items.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        canonical_names: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of canonical English names to expand.',
        },
        shelf_context: {
          type: Type.STRING,
          description: 'Optional shelf description so the model knows what category these are.',
        },
      },
      required: ['canonical_names'],
    },
  },
  {
    name: 'save_products',
    description:
      'BATCH save/upsert — PREFERRED over save_product whenever you have 2+ products to save. ' +
      'Shared aisle code at top level, one entry per product underneath. ' +
      'Returns { results: [{canonical_name, action, evidence_count}], totals: {inserted, updated} }. ' +
      'Use this in Phase 3 with all products at once.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        aisle: {
          type: Type.STRING,
          description: 'The aisle code shared by every product in this batch.',
        },
        products: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              canonical_name: { type: Type.STRING },
              aliases: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'All searchable names including canonical_name itself.',
              },
              category: { type: Type.STRING },
            },
            required: ['canonical_name', 'aliases'],
          },
        },
      },
      required: ['aisle', 'products'],
    },
  },
  {
    name: 'save_product',
    description:
      'DEPRECATED — single-product save. Use save_products with a 1-element array instead. ' +
      'Inserts or upserts one product and bumps evidence_count.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        canonical_name: { type: Type.STRING },
        aliases: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'All searchable names for this product including canonical_name itself.',
        },
        category: { type: Type.STRING },
        aisle: {
          type: Type.STRING,
          description: 'The aisle this product was just seen in.',
        },
      },
      required: ['canonical_name', 'aliases', 'aisle'],
    },
  },
  {
    name: 'record_shelf_evidence',
    description:
      'Save the raw shelf snap as one piece of evidence linking an aisle to a list of products. ' +
      'Call this once after all products on the shelf have been processed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        aisle: { type: Type.STRING },
        products_detected: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Canonical names of all products that were on the shelf.',
        },
      },
      required: ['aisle', 'products_detected'],
    },
  },
  {
    name: 'finish',
    description:
      'Indicate that all work is complete. Call this only after every product is saved ' +
      'and the shelf evidence is recorded.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: {
          type: Type.STRING,
          description: 'Short human-readable summary of what was done.',
        },
      },
      required: ['summary'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Tool executors
// ─────────────────────────────────────────────────────────────

function buildSearchText(canonical: string, aliases: string[]): string {
  return Array.from(new Set([canonical, ...aliases].map(s => s.trim()).filter(Boolean))).join(' · ');
}

function normalizeCanonicalName(raw: string): string {
  return raw
    .trim()
    .replace(/\s*[\[(][^\])]*[\])]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FoundProduct {
  _id: string;
  canonical_name: string;
  aliases: string[];
  category?: string;
  latest_aisle: string;
  evidence_count: number;
}

type FindResult = { found: true; product: FoundProduct } | { found: false };

export async function execFindExistingProducts(
  _db: Db,
  args: { canonical_names: string[] }
): Promise<{ results: Record<string, FindResult>; via: 'mcp' | 'sdk' }> {
  const names = Array.from(new Set((args.canonical_names || []).map(normalizeCanonicalName).filter(Boolean)));
  if (names.length === 0) return { results: {}, via: 'sdk' };

  const { data: docs, via } = await mcpFind<Product & { _id?: { $oid?: string } | string | ObjectId }>({
    collection: 'products',
    filter: { canonical_name: { $in: names } },
    limit: names.length,
  });

  const byName = new Map<string, FoundProduct>();
  for (const doc of docs) {
    const rawId = doc._id;
    const idStr =
      rawId && typeof rawId === 'object' && '$oid' in (rawId as object)
        ? (rawId as { $oid: string }).$oid
        : String(rawId ?? '');
    byName.set(doc.canonical_name, {
      _id: idStr,
      canonical_name: doc.canonical_name,
      aliases: doc.aliases,
      category: doc.category,
      latest_aisle: doc.latest_aisle,
      evidence_count: doc.evidence_count,
    });
  }

  const results: Record<string, FindResult> = {};
  for (const name of names) {
    const hit = byName.get(name);
    results[name] = hit ? { found: true, product: hit } : { found: false };
  }
  return { results, via };
}

export async function execFindExistingProduct(_db: Db, args: { canonical_name: string }) {
  const canonical = normalizeCanonicalName(args.canonical_name || '');
  if (!canonical) return { found: false, via: 'sdk' };
  // Routed through MongoDB MCP Server when the subprocess is available,
  // otherwise falls back to the direct driver (Vercel / serverless).
  const { data: docs, via } = await mcpFind<Product & { _id?: { $oid?: string } | string | ObjectId }>({
    collection: 'products',
    filter: { canonical_name: canonical },
    limit: 1,
  });
  const doc = docs[0];
  if (!doc) return { found: false, via };
  const rawId = doc._id;
  const idStr =
    rawId && typeof rawId === 'object' && '$oid' in (rawId as object)
      ? (rawId as { $oid: string }).$oid
      : String(rawId ?? '');
  return {
    found: true,
    via,
    product: {
      _id: idStr,
      canonical_name: doc.canonical_name,
      aliases: doc.aliases,
      category: doc.category,
      latest_aisle: doc.latest_aisle,
      evidence_count: doc.evidence_count,
    },
  };
}

const ALIAS_PROMPT = `You generate Chinese aliases for grocery products in a bilingual (English + Chinese) supermarket.

Vector search is already multilingual, so do NOT generate Korean / Japanese / romanized variants — they'd just be noise. The point of this list is to give the store a readable bilingual label and to catch Chinese-only customer queries.

Given a canonical English product name, return ONLY a JSON array of Chinese strings (no prose, no code fence):
- 1–2 standard Chinese names (simplified)
- 1 traditional form ONLY if obviously different
- 1 common descriptive phrase IF customers describe rather than name this item ("红辣椒酱", "黑色寿司纸")

Aim for 2–4 short aliases total. Do not include the English name. Return [] if no useful Chinese form exists.

Example for "Gochujang" -> ["韩式辣椒酱","辣椒酱"]
Example for "Lao Gan Ma chili crisp" -> ["老干妈","油辣椒"]`;

export async function execExpandAliases(args: { canonical_name: string; category?: string }) {
  const result = await generateContentWithRetry({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: ALIAS_PROMPT },
          {
            text:
              `Canonical name: ${args.canonical_name}` +
              (args.category ? `\nCategory: ${args.category}` : ''),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  });
  try {
    const parsed = JSON.parse(result.text ?? '[]');
    if (!Array.isArray(parsed)) return { aliases: [] };
    return { aliases: parsed.filter((s: unknown): s is string => typeof s === 'string') };
  } catch {
    return { aliases: [] };
  }
}

const ALIAS_BATCH_PROMPT = `You generate Chinese aliases for a list of grocery products in a bilingual (English + Chinese) supermarket.

Vector search is already multilingual; aliases are only for displaying a readable bilingual label and catching Chinese-only queries.

Return ONLY a JSON object (no prose, no code fence) where each key is the input canonical English name (verbatim) and the value is an array of 2–4 short Chinese aliases:
- 1–2 standard Chinese names (simplified)
- 1 traditional form ONLY if obviously different
- 1 descriptive phrase if customers describe rather than name this item

Return [] for items with no useful Chinese form. Do not include the English name in any value.

Example input names: ["Gochujang", "Lao Gan Ma chili crisp"]
Example output: {"Gochujang":["韩式辣椒酱","辣椒酱"],"Lao Gan Ma chili crisp":["老干妈","油辣椒"]}`;

export async function execExpandAliasesBatch(args: {
  canonical_names: string[];
  shelf_context?: string;
}): Promise<{ aliases_by_name: Record<string, string[]> }> {
  if (!args.canonical_names || args.canonical_names.length === 0) {
    return { aliases_by_name: {} };
  }
  const result = await generateContentWithRetry({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: ALIAS_BATCH_PROMPT },
          {
            text:
              (args.shelf_context ? `Shelf context: ${args.shelf_context}\n\n` : '') +
              `Canonical names:\n${JSON.stringify(args.canonical_names)}`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  });
  try {
    const parsed = JSON.parse(result.text ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { aliases_by_name: {} };
    }
    const out: Record<string, string[]> = {};
    for (const name of args.canonical_names) {
      const v = (parsed as Record<string, unknown>)[name];
      out[name] = Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    }
    return { aliases_by_name: out };
  } catch {
    return { aliases_by_name: {} };
  }
}

export async function execSaveProduct(
  _db: Db,
  args: { canonical_name: string; aliases: string[]; category?: string; aisle: string }
) {
  const canonical = normalizeCanonicalName(args.canonical_name || '');
  if (!canonical) {
    throw new Error('canonical_name is required');
  }
  const aliases = Array.from(new Set([canonical, ...(args.aliases ?? [])].map(s => s.trim()).filter(Boolean)));
  const now = new Date();

  const found = await mcpFind<Product>({
    collection: 'products',
    filter: { canonical_name: canonical },
    limit: 1,
  });

  if (found.data.length > 0) {
    const existing = found.data[0];
    const set: Record<string, unknown> = {
      latest_aisle: args.aisle,
      updated_at: { $date: now.toISOString() },
      aliases,
      search_text: buildSearchText(canonical, aliases),
    };
    const category = args.category ?? existing.category;
    if (category) set.category = category;

    const upd = await mcpUpdateMany({
      collection: 'products',
      filter: { canonical_name: canonical },
      update: {
        $set: set,
        $inc: { evidence_count: 1 },
      },
    });
    return {
      action: 'updated',
      via: upd.via,
      evidence_count: (existing.evidence_count ?? 0) + 1,
    };
  }

  const doc: Record<string, unknown> = {
    canonical_name: canonical,
    aliases,
    search_text: buildSearchText(canonical, aliases),
    latest_aisle: args.aisle,
    evidence_count: 1,
    created_at: { $date: now.toISOString() },
    updated_at: { $date: now.toISOString() },
  };
  if (args.category) doc.category = args.category;

  const ins = await mcpInsertMany({
    collection: 'products',
    documents: [doc],
  });
  return { action: 'inserted', via: ins.via, evidence_count: 1 };
}

interface SaveOneInput {
  canonical_name: string;
  aliases: string[];
  category?: string;
}

interface SaveOneResult {
  canonical_name: string;
  action: 'inserted' | 'updated';
  evidence_count: number;
}

export async function execSaveProducts(
  db: Db,
  args: { aisle: string; products: SaveOneInput[] }
): Promise<{
  results: SaveOneResult[];
  totals: { inserted: number; updated: number };
  via: 'mcp' | 'sdk';
}> {
  const byName = new Map<string, SaveOneInput>();
  for (const raw of args.products || []) {
    const canonical = normalizeCanonicalName(raw?.canonical_name || '');
    if (!canonical) continue;
    const existing = byName.get(canonical);
    const aliases = Array.from(new Set([
      ...(existing?.aliases ?? []),
      ...(raw.aliases ?? []),
    ].map(s => s.trim()).filter(Boolean)));

    byName.set(canonical, {
      canonical_name: canonical,
      aliases,
      category: raw.category?.trim() || existing?.category,
    });
  }

  const items = Array.from(byName.values());
  if (items.length === 0) {
    return { results: [], totals: { inserted: 0, updated: 0 }, via: 'sdk' };
  }

  const now = new Date();
  const names = items.map(p => p.canonical_name);
  const found = await mcpFind<Product>({
    collection: 'products',
    filter: { canonical_name: { $in: names } },
    limit: names.length,
  });
  const existingByName = new Map(found.data.map(p => [p.canonical_name, p]));

  const results: SaveOneResult[] = [];
  let inserted = 0;
  let updated = 0;
  let via: 'mcp' | 'sdk' = found.via;

  for (const item of items) {
    const existing = existingByName.get(item.canonical_name);
    const aliases = Array.from(new Set([
      item.canonical_name,
      ...(existing?.aliases ?? []),
      ...(item.aliases ?? []),
    ].map(s => s.trim()).filter(Boolean)));
    const category = item.category ?? existing?.category;
    const set: Record<string, unknown> = {
      latest_aisle: args.aisle,
      updated_at: { $date: now.toISOString() },
      aliases,
      search_text: buildSearchText(item.canonical_name, aliases),
    };
    if (category) set.category = category;

    const write = await mcpUpdateMany({
      collection: 'products',
      filter: { canonical_name: item.canonical_name },
      update: {
        $set: set,
        $setOnInsert: {
          canonical_name: item.canonical_name,
          created_at: { $date: now.toISOString() },
        },
        $inc: { evidence_count: 1 },
      },
      upsert: true,
    });
    via = write.via;

    const action: SaveOneResult['action'] = existing ? 'updated' : 'inserted';
    results.push({
      canonical_name: item.canonical_name,
      action,
      evidence_count: (existing?.evidence_count ?? 0) + 1,
    });
    if (action === 'inserted') inserted += 1;
    else updated += 1;
  }

  return { results, totals: { inserted, updated }, via };
}

export async function execRecordShelfEvidence(
  _db: Db,
  args: { aisle: string; products_detected: string[] }
) {
  const evidence: ShelfEvidence = {
    photo_url: '',
    aisle: args.aisle,
    products_detected: args.products_detected,
    timestamp: new Date(),
  };
  const ins = await mcpInsertMany({
    collection: 'shelf_evidence',
    documents: [{
      ...evidence,
      timestamp: { $date: evidence.timestamp.toISOString() },
    }],
  });
  return { via: ins.via, inserted: ins.data.insertedCount };
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────

export type ToolName =
  | 'find_existing_products'
  | 'find_existing_product'
  | 'expand_aliases'
  | 'expand_aliases_batch'
  | 'save_products'
  | 'save_product'
  | 'record_shelf_evidence'
  | 'finish';

export async function dispatchToolA(
  db: Db,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name as ToolName) {
    case 'find_existing_products':
      return execFindExistingProducts(db, args as { canonical_names: string[] });
    case 'find_existing_product':
      return execFindExistingProduct(db, args as { canonical_name: string });
    case 'expand_aliases':
      return execExpandAliases(args as { canonical_name: string; category?: string });
    case 'expand_aliases_batch':
      return execExpandAliasesBatch(args as Parameters<typeof execExpandAliasesBatch>[0]);
    case 'save_products':
      return execSaveProducts(db, args as Parameters<typeof execSaveProducts>[1]);
    case 'save_product':
      return execSaveProduct(db, args as Parameters<typeof execSaveProduct>[1]);
    case 'record_shelf_evidence':
      return execRecordShelfEvidence(db, args as Parameters<typeof execRecordShelfEvidence>[1]);
    case 'finish':
      return { ok: true, summary: (args as { summary?: string }).summary ?? '' };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ObjectId is re-exported so the route can serialize without imports
export { ObjectId };

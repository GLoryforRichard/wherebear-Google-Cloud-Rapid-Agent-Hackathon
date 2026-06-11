/**
 * One-off: create the Atlas Search (lexical) index `text_index` on `products`,
 * which enables Hybrid Search ($search + $vectorSearch, see lib/agents/tools-b.ts).
 *
 * SAFE / ADDITIVE: this does NOT touch any documents or the existing
 * `vector_index`. It only registers a new search index; Atlas builds it in the
 * background (~1 min). Until the build finishes, $search returns nothing and the
 * code fails open to vector-only — so running this never breaks live search.
 *
 * Run from the project root:
 *   node --env-file=.env.local scripts/create-search-index.mjs
 *
 * (Requires Node 20.6+ for --env-file. The .env.local must contain MONGODB_URI.)
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'wherebear';
const INDEX_NAME = 'text_index';

if (!uri) {
  console.error('✗ MONGODB_URI not set. Run with: node --env-file=.env.local scripts/create-search-index.mjs');
  process.exit(1);
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const coll = client.db(dbName).collection('products');

  const existing = await coll.listSearchIndexes().toArray();
  if (existing.some((i) => i.name === INDEX_NAME)) {
    console.log(`✓ Search index "${INDEX_NAME}" already exists — nothing to do.`);
  } else {
    await coll.createSearchIndex({
      name: INDEX_NAME,
      // Lexical index (type defaults to 'search', NOT 'vectorSearch'). Dynamic
      // mapping indexes every string field, so fuzzy $search can hit
      // canonical_name / aliases / search_text without a hand-written mapping.
      definition: { mappings: { dynamic: true } },
    });
    console.log(`✓ Created Search index "${INDEX_NAME}". Atlas is building it now (~1 min).`);
    console.log('  $search stays empty until the build completes (search code fails open meanwhile).');
  }

  const all = await coll.listSearchIndexes().toArray();
  console.log(
    'Current search indexes:',
    all.map((i) => `${i.name} [${i.type ?? 'search'}] (${i.status ?? 'n/a'})`).join(', ')
  );
} catch (err) {
  console.error('✗ Failed to create search index:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.close();
}

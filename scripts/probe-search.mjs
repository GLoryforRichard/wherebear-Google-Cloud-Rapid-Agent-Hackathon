/**
 * Dev tool: probe the products search layer.
 *
 *   node --env-file=.env.local scripts/probe-search.mjs            # auto self-test
 *   node --env-file=.env.local scripts/probe-search.mjs "samyung"  # probe a query
 *
 * With no query it waits for `text_index` to finish building, then proves the
 * lexical/fuzzy leg: it grabs a real product, injects a 1-char typo, and checks
 * $search still returns the original (the typo-rescue Hybrid Search relies on).
 * With a query it prints the top vector hits and the top fuzzy $search hits side
 * by side — handy for comparing retrieval before/after and for reranker eval.
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'wherebear';
if (!uri) { console.error('✗ MONGODB_URI not set (use --env-file=.env.local)'); process.exit(1); }

const query = process.argv[2];
const client = new MongoClient(uri);

const textSearch = (coll, q, limit = 5) => coll.aggregate([
  { $search: { index: 'text_index', text: { query: q, path: ['canonical_name', 'aliases', 'search_text'], fuzzy: { maxEdits: 2, prefixLength: 1 } } } },
  { $limit: limit },
  { $project: { _id: 0, canonical_name: 1, latest_aisle: 1, score: { $meta: 'searchScore' } } },
]).toArray();

const vectorSearch = (coll, q, limit = 5) => coll.aggregate([
  { $vectorSearch: { index: 'vector_index', path: 'search_text', query: q, numCandidates: 100, limit } },
  { $project: { _id: 0, canonical_name: 1, latest_aisle: 1, score: { $meta: 'vectorSearchScore' } } },
]).toArray();

try {
  await client.connect();
  const coll = client.db(dbName).collection('products');

  // Wait for the lexical index to be queryable (build is ~1 min).
  for (let i = 0; i < 24; i++) {
    const idx = (await coll.listSearchIndexes().toArray()).find((x) => x.name === 'text_index');
    if (idx?.queryable || idx?.status === 'READY') { console.log(`✓ text_index ready (after ~${i * 5}s)\n`); break; }
    if (i === 0) console.log(`text_index status: ${idx?.status ?? 'missing'} — waiting for build…`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (query) {
    console.log(`Query: "${query}"\n`);
    const [vec, txt] = await Promise.all([vectorSearch(coll, query), textSearch(coll, query)]);
    console.log('— $vectorSearch —');
    vec.forEach((h, i) => console.log(`  ${i + 1}. ${h.canonical_name}  @${h.latest_aisle}  (${h.score?.toFixed(3)})`));
    console.log('\n— $search (fuzzy) —');
    txt.forEach((h, i) => console.log(`  ${i + 1}. ${h.canonical_name}  @${h.latest_aisle}  (${h.score?.toFixed(2)})`));
  } else {
    // Auto self-test: real product + 1-char typo → must still be found by fuzzy.
    const sample = await coll.findOne({ canonical_name: { $regex: /^.{6,}$/ } }, { projection: { canonical_name: 1 } });
    if (!sample) { console.log('No products to sample.'); }
    else {
      const name = sample.canonical_name;
      const i = 3; // swap a middle char to make a guaranteed 1-edit typo
      const typo = name.slice(0, i) + (name[i] === 'x' ? 'y' : 'x') + name.slice(i + 1);
      console.log(`Sample product : "${name}"`);
      console.log(`Injected typo  : "${typo}"\n`);
      const hits = await textSearch(coll, typo, 5);
      hits.forEach((h, n) => console.log(`  ${n + 1}. ${h.canonical_name}  (${h.score?.toFixed(2)})`));
      const found = hits.some((h) => h.canonical_name === name);
      console.log(`\n${found ? '✓ PASS' : '✗ FAIL'} — fuzzy $search ${found ? 'recovered' : 'did NOT recover'} the original from a typo.`);
    }
  }
} catch (err) {
  console.error('✗ probe failed:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.close();
}

/**
 * One-off migration for the name_key + aisle_seen upgrade.
 *
 *   node scripts/migrate-name-key.mjs            # dry-run: print the plan only
 *   node scripts/migrate-name-key.mjs --execute  # apply + create unique index
 *
 * Steps:
 *   1. Group all products by nameKey(canonical_name); merge each duplicate
 *      group into the most recently updated doc (aliases/aisles union,
 *      evidence summed), delete the losers. Full losers+winner docs are
 *      backed up to scripts/backup-name-key-<ts>.json first.
 *   2. Backfill aisle_seen per product from shelf_evidence (last time each
 *      aisle's scan detected the product), falling back to updated_at for
 *      latest_aisle / created_at for older aisles.
 *   3. Set name_key + aisles on every doc, then create the unique index.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const EXECUTE = process.argv.includes('--execute');

// Keep in sync with lib/name-key.ts
function nameKey(raw) {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function buildSearchText(canonical, aliases) {
  return Array.from(new Set([canonical, ...aliases].map(s => s.trim()).filter(Boolean))).join(' · ');
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || undefined);
const products = db.collection('products');

// ---------- step 1: find duplicate groups ----------
const all = await products
  .find({}, { projection: { thumbnail: 0 } })
  .toArray();
console.log(`products: ${all.length} docs (${EXECUTE ? 'EXECUTE' : 'dry-run'})`);

const groups = new Map();
for (const p of all) {
  const key = nameKey(p.canonical_name || '');
  if (!key) { console.warn('  ! empty name_key, skipping:', JSON.stringify(p.canonical_name)); continue; }
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}
const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(`duplicate groups to merge: ${dupGroups.length}`);

const deletes = [];
const mergeOps = [];
for (const [key, docs] of dupGroups) {
  docs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const [winner, ...losers] = docs;
  const aliases = Array.from(new Set(docs.flatMap(d => d.aliases || [d.canonical_name])
    .map(s => (s || '').trim()).filter(Boolean)));
  const aisles = Array.from(new Set(docs.flatMap(d =>
    (d.aisles && d.aisles.length ? d.aisles : [d.latest_aisle])).filter(Boolean)));
  const evidence = docs.reduce((s, d) => s + (d.evidence_count || 0), 0);
  const createdAt = new Date(Math.min(...docs.map(d => new Date(d.created_at || d.updated_at))));
  console.log(`  merge [${key}] ← ${docs.map(d => `"${d.canonical_name}"(${d.latest_aisle})`).join(' + ')}`);
  mergeOps.push({
    updateOne: {
      filter: { _id: winner._id },
      update: {
        $set: {
          aliases,
          aisles,
          search_text: buildSearchText(winner.canonical_name, aliases),
          evidence_count: evidence,
          created_at: createdAt,
        },
      },
    },
  });
  deletes.push(...losers.map(d => d._id));
}

if (EXECUTE && dupGroups.length) {
  // Back up every doc involved (with thumbnails) before touching anything.
  const ids = dupGroups.flatMap(([, docs]) => docs.map(d => d._id));
  const backup = await products.find({ _id: { $in: ids } }).toArray();
  const file = `scripts/backup-name-key-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`backup written: ${file} (${backup.length} docs)`);

  if (mergeOps.length) await products.bulkWrite(mergeOps, { ordered: false });
  if (deletes.length) {
    const res = await products.deleteMany({ _id: { $in: deletes } });
    console.log(`merged: ${mergeOps.length} winners updated, ${res.deletedCount} losers deleted`);
  }
}

// ---------- step 2: backfill aisle_seen from shelf_evidence ----------
const evidence = await db.collection('shelf_evidence')
  .find({}, { projection: { aisle: 1, products_detected: 1, timestamp: 1 } })
  .toArray();
console.log(`shelf_evidence: ${evidence.length} scans`);

// nameKey -> aisle -> latest sighting Date
const seenMap = new Map();
for (const ev of evidence) {
  const ts = new Date(ev.timestamp);
  if (!ev.aisle || Number.isNaN(ts.getTime())) continue;
  for (const name of ev.products_detected || []) {
    const key = nameKey(name || '');
    if (!key) continue;
    if (!seenMap.has(key)) seenMap.set(key, new Map());
    const byAisle = seenMap.get(key);
    const prev = byAisle.get(ev.aisle);
    if (!prev || ts > prev) byAisle.set(ev.aisle, ts);
  }
}

// ---------- step 3: stamp name_key + aisles + aisle_seen on every survivor ----------
const survivors = await products
  .find({}, { projection: { canonical_name: 1, latest_aisle: 1, aisles: 1, created_at: 1, updated_at: 1 } })
  .toArray();
const stampOps = [];
for (const p of survivors) {
  const key = nameKey(p.canonical_name || '');
  if (!key) continue;
  const aisles = Array.from(new Set(
    (p.aisles && p.aisles.length ? p.aisles : [p.latest_aisle]).filter(Boolean)
  ));
  const byAisle = seenMap.get(key);
  const aisleSeen = {};
  for (const a of aisles) {
    if (/[.$]/.test(a)) continue;
    const fromEvidence = byAisle?.get(a);
    aisleSeen[a] = fromEvidence
      ?? (a === p.latest_aisle ? new Date(p.updated_at) : new Date(p.created_at));
  }
  stampOps.push({
    updateOne: {
      filter: { _id: p._id },
      update: { $set: { name_key: key, aisles, aisle_seen: aisleSeen } },
    },
  });
}
console.log(`stamping name_key/aisles/aisle_seen on ${stampOps.length} docs`);

if (EXECUTE) {
  for (let i = 0; i < stampOps.length; i += 500) {
    await products.bulkWrite(stampOps.slice(i, i + 500), { ordered: false });
  }
  await products.createIndex({ name_key: 1 }, { unique: true, name: 'name_key_unique' });
  console.log('unique index name_key_unique created');
  const remaining = await products.countDocuments({ name_key: { $exists: false } });
  console.log(`done. docs still missing name_key: ${remaining}`);
} else {
  console.log('\ndry-run complete — re-run with --execute to apply.');
}
await client.close();

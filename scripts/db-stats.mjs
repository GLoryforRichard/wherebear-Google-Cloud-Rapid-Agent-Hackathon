/**
 * Dev tool: report MongoDB storage usage vs the Atlas M0 512 MB ceiling.
 *   node --env-file=.env.local scripts/db-stats.mjs
 *
 * Gemini-independent. Supports the Phase 3.1 capacity check: 13k+ products with
 * inline 240px JPEG thumbnails are the main pressure on the free-tier limit.
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'wherebear';
if (!uri) { console.error('✗ MONGODB_URI not set (use --env-file=.env.local)'); process.exit(1); }

const MB = 1024 * 1024;
const M0_LIMIT_MB = 512;
const fmt = (b) => `${(b / MB).toFixed(1)} MB`;
const client = new MongoClient(uri);

try {
  await client.connect();
  const db = client.db(dbName);

  const s = await db.command({ dbStats: 1 });
  const used = s.storageSize + s.indexSize;
  console.log(`Database "${dbName}" vs Atlas M0 (${M0_LIMIT_MB} MB):`);
  console.log(`  dataSize    (uncompressed) : ${fmt(s.dataSize)}`);
  console.log(`  storageSize (on disk)      : ${fmt(s.storageSize)}`);
  console.log(`  indexSize                  : ${fmt(s.indexSize)}`);
  console.log(`  → on-disk + indexes        : ${fmt(used)}  (${(used / MB / M0_LIMIT_MB * 100).toFixed(0)}% of M0)`);
  console.log(`  → uncompressed data        : ${fmt(s.dataSize)}  (${(s.dataSize / MB / M0_LIMIT_MB * 100).toFixed(0)}% of M0)\n`);

  console.log('Per-collection:');
  for (const c of await db.listCollections().toArray()) {
    try {
      const st = await db.collection(c.name).aggregate([{ $collStats: { storageStats: {} } }]).next();
      const ss = st.storageStats;
      console.log(`  ${c.name.padEnd(15)} count=${String(ss.count).padStart(7)}  data=${fmt(ss.size).padStart(9)}  disk=${fmt(ss.storageSize).padStart(9)}  idx=${fmt(ss.totalIndexSize).padStart(9)}  avgObj=${(ss.avgObjSize || 0).toFixed(0)}B`);
    } catch (e) { console.log(`  ${c.name}: collStats failed (${e.message})`); }
  }

  const agg = await db.collection('products').aggregate([
    { $group: {
      _id: null,
      total: { $sum: 1 },
      withThumb: { $sum: { $cond: [{ $ifNull: ['$thumbnail', false] }, 1, 0] } },
      thumbBytes: { $sum: { $strLenBytes: { $ifNull: ['$thumbnail', ''] } } },
    } },
  ]).next();
  console.log('\nThumbnails (inline in products):');
  console.log(`  ${agg.withThumb}/${agg.total} products carry a thumbnail`);
  console.log(`  total thumbnail bytes      : ${fmt(agg.thumbBytes)}  (~${(agg.thumbBytes / Math.max(agg.withThumb, 1) / 1024).toFixed(1)} KB each)`);
  console.log(`  → thumbnails are ${(agg.thumbBytes / Math.max(s.dataSize, 1) * 100).toFixed(0)}% of all document data`);
} catch (err) {
  console.error('✗ db-stats failed:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.close();
}

import { Db } from 'mongodb';
import { Product } from './types';
import { DetectedProduct } from './gemini';

function buildSearchText(canonicalName: string, aliases: string[]): string {
  const all = [canonicalName, ...aliases];
  return Array.from(new Set(all.map(s => s.trim()).filter(Boolean))).join(' · ');
}

export async function upsertDetectedProducts(
  db: Db,
  detected: DetectedProduct[],
  aisle: string
): Promise<{ upserted: number; updated: number }> {
  const col = db.collection<Product>('products');
  let upserted = 0;
  let updated = 0;
  const now = new Date();

  for (const item of detected) {
    const canonical = item.name.trim();
    if (!canonical) continue;

    const existing = await col.findOne({ canonical_name: canonical });

    if (existing) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: { latest_aisle: aisle, updated_at: now, category: item.category ?? existing.category },
          $inc: { evidence_count: 1 },
        }
      );
      updated += 1;
    } else {
      const aliases = [canonical];
      await col.insertOne({
        canonical_name: canonical,
        aliases,
        search_text: buildSearchText(canonical, aliases),
        category: item.category,
        latest_aisle: aisle,
        evidence_count: 1,
        created_at: now,
        updated_at: now,
      });
      upserted += 1;
    }
  }

  return { upserted, updated };
}

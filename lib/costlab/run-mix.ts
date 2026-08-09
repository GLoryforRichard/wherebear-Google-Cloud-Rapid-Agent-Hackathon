/**
 * Run the rows-hd pipeline with a DIFFERENT model per stage. Orchestration
 * mirrors lib/scan/run.ts (stage barriers, dedup, thumbnails) but binds each
 * stage to its scheme's transport+model, and reports cost per stage.
 * Reuses the production stage implementations (detect.ts / readout.ts /
 * names.ts) so every scheme sees byte-identical band slices and grid images —
 * only the model behind each stage differs.
 */

import sharp from 'sharp';
import { detectBoxes, detectRowBands } from '@/lib/scan/detect';
import { cropRect } from '@/lib/scan/grid';
import { prepareScanImages } from '@/lib/scan/image';
import { applyReadoutNames, extractEntries } from '@/lib/scan/names';
import { type RawImage, decodeRaw, extractFromRaw } from '@/lib/scan/raw';
import { readProductNames } from '@/lib/scan/readout';
import type { CallOutcome } from '@/lib/scan/transport';
import type { NormalizedBox, PreparedImage } from '@/lib/scan/types';
import type { LabScheme } from './schemes';
import { stageCallModel } from './transport-lab';
import type { LabEntry, LabRunArtifact, StageCost } from './types';

function stageCost(outcomes: CallOutcome[]): StageCost {
  const c: StageCost = {
    calls: outcomes.length,
    failures: outcomes.filter((o) => !o.ok).length,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  for (const o of outcomes) {
    c.inputTokens += o.tokens?.prompt ?? 0;
    c.outputTokens += (o.tokens?.completion ?? 0) + (o.tokens?.reasoning ?? 0);
    c.costUsd += o.costUsd ?? 0;
  }
  return c;
}

function toBox2d(b: NormalizedBox): [number, number, number, number] {
  return [
    Math.round(b.y * 1000),
    Math.round(b.x * 1000),
    Math.round((b.y + b.h) * 1000),
    Math.round((b.x + b.w) * 1000),
  ];
}

async function makeThumbnail(
  raw: RawImage | undefined,
  full: PreparedImage,
  box: NormalizedBox
): Promise<string | undefined> {
  try {
    const rect = cropRect(box, full.width, full.height);
    const source = raw ? extractFromRaw(raw, rect) : sharp(full.jpeg).extract(rect);
    const buf = await source
      .resize(240, 240, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export interface MixRunResult {
  artifact: Omit<LabRunArtifact, 'photo' | 'runTag'>;
  /** Processed (≤2048px) upright JPEG — the overlay base image. */
  preview: PreparedImage;
}

export async function runMix(imageBuffer: Buffer, scheme: LabScheme): Promise<MixRunResult> {
  const t0 = Date.now();
  const stages: Record<string, number> = {};
  const warnings: string[] = [];

  const images = await prepareScanImages(imageBuffer);
  const raw = await decodeRaw(images.full).catch(() => undefined);
  stages.prep = Date.now() - t0;

  // Stage 0: rows (scheme.rows model)
  const tRows = Date.now();
  const rows = await detectRowBands(
    stageCallModel(scheme.rows),
    scheme.rows.modelId,
    images.processed
  );
  stages.rows = Date.now() - tRows;
  if (rows.warning) warnings.push(`rows: ${rows.warning}`);
  const rowsOutcomes = rows.outcome ? [rows.outcome] : [];

  // Stage 1: band detection (scheme.detect model) — full reasoning, barrier
  const tDet = Date.now();
  const det = await detectBoxes(
    stageCallModel(scheme.detect),
    scheme.detect.modelId,
    images.full,
    rows.bands,
    { bandConcurrency: scheme.bandConcurrency, raw }
  );
  stages.detect = Date.now() - tDet;
  warnings.push(...det.parse.warnings.map((w) => `detect: ${w}`));

  // Stage 2: grid readout (scheme.readout model) — reasoning off
  const tRead = Date.now();
  const readout = await readProductNames(
    stageCallModel(scheme.readout),
    scheme.readout.modelId,
    images.full,
    det.boxes,
    { gridConcurrency: scheme.gridConcurrency, raw }
  );
  stages.readout = Date.now() - tRead;
  if (readout.fallbackChunks > 0) {
    warnings.push(`readout: ${readout.fallbackChunks} grid chunk(s) fell back to per-crop`);
  }
  if (readout.failedCount > 0) {
    warnings.push(`readout: ${readout.failedCount} box(es) kept their detection label`);
  }

  // Stage 3: names + dedup + thumbnails (pure code, identical to production)
  const tPost = Date.now();
  const labeled = applyReadoutNames(det.boxes, readout.names);
  const rawEntries = extractEntries(labeled);
  const entries: LabEntry[] = await Promise.all(
    rawEntries.map(async (e) => {
      const largest = e.boxIndices.reduce((best, i) =>
        labeled[i].w * labeled[i].h > labeled[best].w * labeled[best].h ? i : best
      );
      return {
        name: e.name,
        count: e.count,
        box_2d: toBox2d(labeled[largest]),
        boxes_2d: e.boxIndices.map((i) => toBox2d(labeled[i])),
        thumbnail: await makeThumbnail(raw, images.full, labeled[largest]),
      };
    })
  );
  stages.post = Date.now() - tPost;

  return {
    artifact: {
      schemeId: scheme.id,
      at: new Date().toISOString(),
      models: {
        rows: scheme.rows.modelId,
        detect: scheme.detect.modelId,
        readout: scheme.readout.modelId,
      },
      imageWidth: images.processed.width,
      imageHeight: images.processed.height,
      entries,
      count: entries.length,
      totalBoxes: det.boxes.length,
      elapsedMs: Date.now() - t0,
      stages,
      perStage: {
        rows: stageCost(rowsOutcomes),
        detect: stageCost(det.outcomes),
        readout: stageCost(readout.outcomes),
      },
      totalCostUsd:
        stageCost(rowsOutcomes).costUsd +
        stageCost(det.outcomes).costUsd +
        stageCost(readout.outcomes).costUsd,
      warnings,
    },
    preview: images.processed,
  };
}

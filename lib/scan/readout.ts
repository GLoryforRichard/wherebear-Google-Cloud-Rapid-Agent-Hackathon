/**
 * Grid readout (stage 2), ported from whataisle-store/lib/scan/readout.ts.
 * Difference from the source: the model transport (`callModel`), model id,
 * and concurrency/grid-size knobs are PARAMETERS instead of fixed imports.
 *
 * Re-reads each detected box's product name from its full-resolution crop,
 * GRID_K crops stitched per call (≈10× fewer calls than per-crop), with
 * per-crop fallback for any grid chunk that fails twice. Runs with minimal
 * reasoning — naming a single crop needs no thinking (measured near-lossless
 * and much cheaper than full reasoning).
 */

import pLimit from 'p-limit';
import sharp from 'sharp';
import { extractJson } from './box-parser';
import {
  type CropRect,
  GRID_CELL_SIZE,
  cropRect,
  gridLayout,
  parseGridNames,
} from './grid';
import type { CallModelFn, CallOutcome } from './transport';
import {
  READ_NAME_PROMPT,
  READ_NAME_SCHEMA,
  buildGridReadPrompt,
  buildGridReadSchema,
} from './prompts';
import { type RawImage, extractFromRaw } from './raw';
import type { NormalizedBox, PreparedImage } from './types';

/** Crop source: pre-decoded raw pixels when available (one decode for the
 *  whole readout instead of one full JPEG decode PER CROP), else the JPEG.
 *  Same decoded pixels either way — no model input changes. */
interface CropSource {
  jpeg: Buffer;
  raw?: RawImage;
}

function extractCrop(src: CropSource, rect: CropRect): sharp.Sharp {
  return src.raw ? extractFromRaw(src.raw, rect) : sharp(src.jpeg).extract(rect);
}

/** Stitch crops into one white-background numbered grid image. */
async function buildGridImage(
  src: CropSource,
  rects: CropRect[]
): Promise<Buffer> {
  const layout = gridLayout(rects.length);
  const CELL = GRID_CELL_SIZE;
  const resized = await Promise.all(
    rects.map((r) =>
      extractCrop(src, r)
        .resize(CELL, CELL, { fit: 'inside', withoutEnlargement: false })
        .jpeg({ quality: 88 })
        .toBuffer()
        .then(async (buf) => ({ buf, meta: await sharp(buf).metadata() }))
    )
  );
  const numberSvgParts = layout.cells.map(
    (c, i) =>
      `<text x="${c.labelX}" y="${c.labelY}" font-family="sans-serif" font-size="34" font-weight="bold" fill="#1d4ed8" stroke="#ffffff" stroke-width="6" paint-order="stroke">${i + 1}</text>` +
      `<rect x="${c.x - 2}" y="${c.y - 2}" width="${c.w + 4}" height="${c.h + 4}" fill="none" stroke="#d1d5db" stroke-width="2"/>`
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">${numberSvgParts.join('')}</svg>`;
  return sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([
      ...resized.map(({ buf, meta }, i) => ({
        input: buf,
        // center the crop inside its cell
        left:
          layout.cells[i].x +
          Math.max(0, Math.round((CELL - (meta.width ?? CELL)) / 2)),
        top:
          layout.cells[i].y +
          Math.max(0, Math.round((CELL - (meta.height ?? CELL)) / 2)),
      })),
      { input: Buffer.from(svg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function readOneBox(
  callModel: CallModelFn,
  modelId: string,
  src: CropSource,
  rect: CropRect,
  collect: CallOutcome[]
): Promise<string | null> {
  const crop = await extractCrop(src, rect)
    .jpeg({ quality: 88 })
    .toBuffer();
  const attempt = async (): Promise<string | null> => {
    const outcome = await callModel({
      modelId,
      imageJpeg: crop,
      prompt: READ_NAME_PROMPT,
      schema: READ_NAME_SCHEMA,
      schemaName: 'product_name',
      timeoutMs: 60_000,
      reasoningEffort: 'off',
    });
    collect.push(outcome);
    if (!outcome.ok) return null;
    const data = extractJson(outcome.rawText ?? '') as {
      name?: unknown;
    } | null;
    return typeof data?.name === 'string' && data.name.trim()
      ? data.name.trim()
      : null;
  };
  const first = await attempt();
  if (first !== null) return first;
  await new Promise((r) => setTimeout(r, 1000));
  return attempt();
}

/** One grid chunk: stitch → single call → K names. null = chunk failed. */
async function readGridChunk(
  callModel: CallModelFn,
  modelId: string,
  src: CropSource,
  rects: CropRect[],
  collect: CallOutcome[],
  repair = false
): Promise<(string | null)[] | null> {
  const grid = await buildGridImage(src, rects);
  // Some providers enforce JSON-Schema array arity more softly than others,
  // so the retry pass appends an explicit corrective line.
  const prompt = repair
    ? `${buildGridReadPrompt(rects.length)}\n\nIMPORTANT: your previous answer did not have exactly ${rects.length} entries. Return EXACTLY ${rects.length} names — one per numbered cell, in cell-number order, no more, no fewer.`
    : buildGridReadPrompt(rects.length);
  const outcome = await callModel({
    modelId,
    imageJpeg: grid,
    prompt,
    schema: buildGridReadSchema(rects.length),
    schemaName: 'grid_product_names',
    timeoutMs: 120_000,
    reasoningEffort: 'off',
  });
  collect.push(outcome);
  if (!outcome.ok) return null;
  return parseGridNames(outcome.rawText ?? '', rects.length);
}

export interface ReadoutOptions {
  gridK?: number;
  gridConcurrency?: number;
  /** Pre-decoded full-image pixels (see CropSource). */
  raw?: RawImage;
}

export interface ReadoutResult {
  /** names[i] overrides boxes[i].label; null = read failed, keep the label. */
  names: (string | null)[];
  outcomes: CallOutcome[];
  fallbackChunks: number;
  failedCount: number;
  latencyMs: number;
}

export async function readProductNames(
  callModel: CallModelFn,
  modelId: string,
  full: PreparedImage,
  boxes: NormalizedBox[],
  opts: ReadoutOptions = {}
): Promise<ReadoutResult> {
  if (boxes.length === 0) {
    return {
      names: [],
      outcomes: [],
      fallbackChunks: 0,
      failedCount: 0,
      latencyMs: 0,
    };
  }
  const started = performance.now();
  const gridK = Math.max(1, opts.gridK ?? 6);
  const src: CropSource = { jpeg: full.jpeg, raw: opts.raw };
  const rects = boxes.map((b) => cropRect(b, full.width, full.height));
  const outcomes: CallOutcome[] = [];

  const chunks: { start: number; rects: CropRect[] }[] = [];
  for (let i = 0; i < rects.length; i += gridK) {
    chunks.push({ start: i, rects: rects.slice(i, i + gridK) });
  }
  const limit = pLimit(Math.max(1, opts.gridConcurrency ?? 2));
  const names: (string | null)[] = new Array(rects.length).fill(null);
  let fallbackChunks = 0;

  await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        let res = await readGridChunk(
          callModel,
          modelId,
          src,
          chunk.rects,
          outcomes
        );
        if (!res) {
          res = await readGridChunk(
            callModel,
            modelId,
            src,
            chunk.rects,
            outcomes,
            /* repair */ true
          );
        }
        if (res) {
          res.forEach((n, j) => {
            names[chunk.start + j] = n;
          });
          return;
        }
        // grid failed twice → per-crop fallback for this chunk (accuracy first)
        fallbackChunks++;
        const singles = await Promise.all(
          chunk.rects.map((r) =>
            readOneBox(callModel, modelId, src, r, outcomes)
          )
        );
        singles.forEach((n, j) => {
          names[chunk.start + j] = n;
        });
      })
    )
  );

  return {
    names,
    outcomes,
    fallbackChunks,
    failedCount: names.filter((n) => n === null).length,
    latencyMs: Math.round(performance.now() - started),
  };
}

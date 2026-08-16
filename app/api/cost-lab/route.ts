/**
 * Cost-lab API.
 *
 * POST {photo, scheme, runTag?} — run one scheme over one registered photo,
 * persist the artifact to public/cost-lab-results/<photo>/<scheme>[-tag].json
 * (plus preview.jpg once per photo), return a summary.
 *
 * GET — rebuild public/cost-lab-results/index.json: score every artifact
 * against the photo's baseline reference (baseline.json), including the
 * baseline-vs-itself noise floor (baseline-alt.json), and return it.
 *
 * Local experiment tooling — never linked from user-facing pages.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { compareRuns } from '@/lib/costlab/metrics';
import { getScheme, SCHEMES } from '@/lib/costlab/schemes';
import { runMix } from '@/lib/costlab/run-mix';
import type {
  IndexPhoto,
  IndexScheme,
  LabIndex,
  LabRunArtifact,
} from '@/lib/costlab/types';
import { ScanFailedError } from '@/lib/scan/detect';
import { isScanLabEnabled, scanLabNotFound } from '@/lib/scan-lab';

export const runtime = 'nodejs';
export const maxDuration = 900;

const PHOTOS: Record<string, string> = {
  'test-shelf': 'test-shelf.JPEG',
  'sample-shelf': 'public/sample-shelf.jpg',
};

const RESULTS_DIR = path.join(process.cwd(), 'public', 'cost-lab-results');

function artifactFile(scheme: string, runTag: string): string {
  return runTag === 'main' ? `${scheme}.json` : `${scheme}-${runTag}.json`;
}

/** On the public VM this route can spend real model credits — when
 *  COSTLAB_TOKEN is set, both methods require the matching header.
 *  (The showcase pages never call this API; they read static artifacts.) */
function authorized(req: NextRequest): boolean {
  const token = process.env.COSTLAB_TOKEN;
  if (!token) return true;
  return req.headers.get('x-costlab-token') === token;
}

export async function POST(req: NextRequest) {
  if (!isScanLabEnabled()) return scanLabNotFound();
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  let body: { photo?: string; scheme?: string; runTag?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const photo = body.photo ?? '';
  const schemeId = body.scheme ?? '';
  const runTag = body.runTag ?? 'main';
  const rel = PHOTOS[photo];
  const scheme = getScheme(schemeId);
  if (!rel) {
    return NextResponse.json(
      { ok: false, error: `unknown photo '${photo}' (have: ${Object.keys(PHOTOS).join(', ')})` },
      { status: 400 }
    );
  }
  if (!scheme) {
    return NextResponse.json(
      { ok: false, error: `unknown scheme '${schemeId}' (have: ${SCHEMES.map((s) => s.id).join(', ')})` },
      { status: 400 }
    );
  }

  const imageBuffer = await readFile(path.join(process.cwd(), rel));
  const dir = path.join(RESULTS_DIR, photo);
  await mkdir(dir, { recursive: true });

  try {
    const { artifact, preview } = await runMix(imageBuffer, scheme);
    const full: LabRunArtifact = { ...artifact, photo, runTag };
    await writeFile(path.join(dir, artifactFile(schemeId, runTag)), JSON.stringify(full));
    // Overlay base image, written once per photo.
    const previewPath = path.join(dir, 'preview.jpg');
    await writeFile(previewPath, preview.jpeg).catch(() => {});

    return NextResponse.json({
      ok: true,
      scheme: schemeId,
      runTag,
      photo,
      count: full.count,
      totalBoxes: full.totalBoxes,
      elapsedMs: full.elapsedMs,
      stages: full.stages,
      perStage: full.perStage,
      totalCostUsd: full.totalCostUsd,
      warnings: full.warnings,
    });
  } catch (err) {
    const outcomes = err instanceof ScanFailedError ? err.outcomes : [];
    const spent = outcomes.reduce((s, o) => s + (o.costUsd ?? 0), 0);
    return NextResponse.json(
      {
        ok: false,
        scheme: schemeId,
        photo,
        error: err instanceof Error ? err.message : String(err),
        spentUsd: spent,
      },
      { status: 500 }
    );
  }
}

async function loadArtifact(dir: string, file: string): Promise<LabRunArtifact | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, file), 'utf8')) as LabRunArtifact;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!isScanLabEnabled()) return scanLabNotFound();
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const photos: IndexPhoto[] = [];
  for (const photo of Object.keys(PHOTOS)) {
    const dir = path.join(RESULTS_DIR, photo);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    const baseline = await loadArtifact(dir, 'baseline.json');
    const baselineAlt = await loadArtifact(dir, 'baseline-alt.json');

    const schemes: IndexScheme[] = [];
    let anyArt: LabRunArtifact | null = null;
    for (const file of files.sort()) {
      const art = await loadArtifact(dir, file);
      if (!art) continue;
      anyArt = art;
      const isReference = file === 'baseline.json';
      schemes.push({
        schemeId: art.schemeId,
        runTag: art.runTag,
        file: `/cost-lab-results/${photo}/${file}`,
        models: art.models,
        count: art.count,
        totalBoxes: art.totalBoxes,
        elapsedMs: art.elapsedMs,
        perStage: art.perStage,
        totalCostUsd: art.totalCostUsd,
        warnings: art.warnings,
        metrics:
          !isReference && baseline ? compareRuns(art.entries, baseline.entries) : null,
      });
    }

    photos.push({
      photo,
      preview: `/cost-lab-results/${photo}/preview.jpg`,
      imageWidth: baseline?.imageWidth ?? anyArt?.imageWidth ?? 0,
      imageHeight: baseline?.imageHeight ?? anyArt?.imageHeight ?? 0,
      noiseFloor:
        baseline && baselineAlt ? compareRuns(baselineAlt.entries, baseline.entries) : null,
      schemes,
    });
  }

  const index: LabIndex = { generatedAt: new Date().toISOString(), photos };
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path.join(RESULTS_DIR, 'index.json'), JSON.stringify(index));
  return NextResponse.json(index);
}

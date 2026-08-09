/**
 * Cost-lab: swap individual rows-hd pipeline stages onto cheaper models and
 * measure whether the FINAL output still matches the all-gemini-3.6-flash
 * baseline. Shared shapes for runner, metrics, API route and the /cost-lab
 * page. Experiment-only code — production intake (lib/scan/intake.ts) does
 * not import anything from lib/costlab.
 */

export interface LabEntry {
  name: string;
  count: number;
  /** Wire format [ymin, xmin, ymax, xmax] on 0–1000 (largest box). */
  box_2d: [number, number, number, number];
  boxes_2d: [number, number, number, number][];
  /** 240px JPEG data URL, cropped locally (no model cost). */
  thumbnail?: string;
}

export interface StageCost {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** OpenRouter actual billed usage.cost (or Vertex list-price estimate). */
  costUsd: number;
}

export type StageName = 'rows' | 'detect' | 'readout';

export interface LabRunArtifact {
  schemeId: string;
  photo: string;
  runTag: string;
  at: string;
  models: Record<StageName, string>;
  /** Processed (≤2048px) preview dimensions, for overlay aspect. */
  imageWidth: number;
  imageHeight: number;
  entries: LabEntry[];
  count: number;
  totalBoxes: number;
  elapsedMs: number;
  /** Per-stage wall times (ms): prep, rows, detect, readout, post. */
  stages: Record<string, number>;
  perStage: Record<StageName, StageCost>;
  totalCostUsd: number;
  warnings: string[];
}

/** Similarity of one run against the baseline reference run. */
export interface SchemeMetrics {
  /** Fraction of baseline boxes matched by IoU ≥ threshold. */
  boxRecall: number;
  /** Fraction of this run's boxes that match a baseline box. */
  boxPrecision: number;
  /** Among IoU-matched box pairs: fraction whose names agree (fuzzy). */
  nameAgreement: number;
  /** Fuzzy Jaccard over the deduped product-name lists. */
  entryJaccard: number;
  matchedBoxes: number;
  baseBoxes: number;
  schemeBoxes: number;
  /** Baseline entry names this run missed entirely (fuzzy, top few). */
  missedNames: string[];
  /** Entry names this run has that baseline does not (top few). */
  extraNames: string[];
}

export interface IndexScheme {
  schemeId: string;
  runTag: string;
  file: string;
  models: Record<StageName, string>;
  count: number;
  totalBoxes: number;
  elapsedMs: number;
  perStage: Record<StageName, StageCost>;
  totalCostUsd: number;
  warnings: string[];
  /** null for the reference run itself. */
  metrics: SchemeMetrics | null;
}

export interface IndexPhoto {
  photo: string;
  preview: string;
  imageWidth: number;
  imageHeight: number;
  /** Metrics of baseline run #2 vs run #1 — the model's own noise floor. */
  noiseFloor: SchemeMetrics | null;
  schemes: IndexScheme[];
}

export interface LabIndex {
  generatedAt: string;
  photos: IndexPhoto[];
}

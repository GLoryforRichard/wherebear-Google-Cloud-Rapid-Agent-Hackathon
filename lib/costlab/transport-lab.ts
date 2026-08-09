/**
 * Per-stage model binding for cost-lab runs, on top of the production
 * transports (lib/scan/transport.ts). Adds two lab-only degradations so
 * cheap OpenRouter models that reject strict response_format or the
 * reasoning parameter still produce output (the prompts already demand
 * ONLY-JSON and box-parser tolerates raw text):
 *   1. provider rejects json_schema → retry without response_format
 *   2. provider rejects reasoning   → retry without reasoning
 * Production transports stay untouched.
 */

import { extractJson } from '@/lib/scan/box-parser';
import {
  type CallModelFn,
  type CallModelOptions,
  callModelOpenRouter,
  callModelVertex,
} from '@/lib/scan/transport';

export interface StageSpec {
  modelId: string;
  transport?: 'openrouter' | 'vertex';
  /** Floor for per-call timeout — :batch variants can queue for minutes. */
  minTimeoutMs?: number;
  /**
   * Coordinate adapter: Qwen-VL models habitually emit [xmin,ymin,xmax,ymax]
   * into box_2d even when the prompt demands y-first (measured: all-qwen's
   * boxes came back as 374×15 slivers — transposed). Swaps every box_2d in
   * the response to the pipeline's [ymin,xmin,ymax,xmax] convention.
   */
  swapBoxOrder?: boolean;
}

function swapBox2d(text: string): string {
  const data = extractJson(text);
  if (!data || typeof data !== 'object') return text;
  let touched = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const b = rec.box_2d;
    if (Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number')) {
      rec.box_2d = [b[1], b[0], b[3], b[2]];
      touched = true;
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(data);
  return touched ? JSON.stringify(data) : text;
}

export function stageCallModel(spec: StageSpec): CallModelFn {
  const base = spec.transport === 'vertex' ? callModelVertex : callModelOpenRouter;
  return async (opts: CallModelOptions) => {
    const merged: CallModelOptions = {
      ...opts,
      modelId: spec.modelId,
      timeoutMs: Math.max(opts.timeoutMs ?? 60_000, spec.minTimeoutMs ?? 0),
    };
    let outcome = await base(merged);
    if (
      !outcome.ok &&
      merged.schema &&
      outcome.error &&
      /response_format|json_schema|structured output|schema/i.test(outcome.error)
    ) {
      const degraded = { ...merged };
      delete degraded.schema;
      delete degraded.schemaName;
      console.warn(`[cost-lab] ${spec.modelId}: retrying without response_format (${outcome.error.slice(0, 120)})`);
      outcome = await base(degraded);
    }
    if (
      !outcome.ok &&
      merged.reasoningEffort &&
      outcome.error &&
      /reasoning/i.test(outcome.error)
    ) {
      const degraded = { ...merged };
      delete degraded.reasoningEffort;
      console.warn(`[cost-lab] ${spec.modelId}: retrying without reasoning param (${outcome.error.slice(0, 120)})`);
      outcome = await base(degraded);
    }
    if (outcome.ok && outcome.rawText && spec.swapBoxOrder) {
      outcome = { ...outcome, rawText: swapBox2d(outcome.rawText) };
    }
    return outcome;
  };
}

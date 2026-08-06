/**
 * Pluggable model transports for the rows-hd scan engine.
 *
 * The pipeline (detect.ts / readout.ts) is written against one contract —
 * `callModel(CallModelOptions) → CallOutcome` — with two implementations:
 *
 *  - `callModelVertex`     — Vertex AI via wherebear's shared @google/genai
 *    client (lib/gemini.ts), inheriting its process-wide 4-slot concurrency
 *    gate and 5-attempt 429/5xx backoff. Cost is ESTIMATED from the price
 *    table (Vertex reports no billed cost).
 *  - `callModelOpenRouter` — OpenRouter's OpenAI-compatible HTTP API, ported
 *    from whataisle/src/ai/scan/openrouter.ts. Cost is the ACTUAL billed
 *    `usage.cost` from OpenRouter's usage accounting.
 *
 * Mapping notes (Vertex):
 * - Schemas pass through UNCHANGED via `responseJsonSchema` — since
 *   @google/genai v1.9 the backend accepts native JSON Schema, including
 *   additionalProperties:false and the grid schema's minItems/maxItems arity.
 * - reasoningEffort 'off' → ThinkingLevel.MINIMAL (Gemini 3.x can't disable
 *   thinking; `thinkingBudget: 0` is silently IGNORED on 3.x). undefined →
 *   no thinkingConfig at all = full dynamic thinking (band detection needs
 *   it: "the reasoning is the source of correct product grouping").
 */

import { ThinkingLevel } from '@google/genai';
import pLimit from 'p-limit';
import { generateContentWithRetry } from '@/lib/gemini';
import { estimateCostUsd } from './pricing';

export interface CallOutcome {
  ok: boolean;
  rawText: string | null;
  latencyMs: number;
  costUsd: number | null;
  tokens: { prompt: number; completion: number; reasoning: number } | null;
  generationId: string | null;
  error: string | null;
}

export interface CallModelOptions {
  modelId: string;
  imageJpeg: Buffer;
  prompt: string;
  schema?: object;
  schemaName?: string;
  timeoutMs?: number;
  /**
   * 'off' asks for the smallest thinking budget the provider accepts (some
   * models mandate reasoning and can't hard-disable it); leave unset for
   * full reasoning.
   */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'off';
}

export type CallModelFn = (opts: CallModelOptions) => Promise<CallOutcome>;

// ── Vertex AI transport ──────────────────────────────────────────────────

const THINKING_LEVEL: Record<NonNullable<CallModelOptions['reasoningEffort']>, ThinkingLevel> = {
  off: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const callModelVertex: CallModelFn = async (opts) => {
  const {
    modelId,
    imageJpeg,
    prompt,
    schema,
    // Below every route budget that reaches this, so a caller that forgets to
    // pass one cannot outlive its own request.
    timeoutMs = 60_000,
    reasoningEffort,
  } = opts;

  const config: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: 16_000,
    responseMimeType: 'application/json',
  };
  if (schema) config.responseJsonSchema = schema;
  if (reasoningEffort) {
    config.thinkingConfig = { thinkingLevel: THINKING_LEVEL[reasoningEffort] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  config.abortSignal = controller.signal;

  const started = performance.now();
  try {
    const response = await generateContentWithRetry({
      model: modelId,
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: imageJpeg.toString('base64') } },
          ],
        },
      ],
      config,
    });
    const latencyMs = Math.round(performance.now() - started);

    const meta = response.usageMetadata;
    const tokens = meta
      ? {
          prompt: meta.promptTokenCount ?? 0,
          completion: meta.candidatesTokenCount ?? 0,
          reasoning: meta.thoughtsTokenCount ?? 0,
        }
      : null;
    const costUsd = estimateCostUsd(modelId, tokens);
    const generationId = response.responseId ?? null;

    const text = response.text ?? '';
    // An empty completion happens when the model burns its whole token budget
    // thinking (billed, zero output). Treat as failure so callers' retry paths
    // engage; keep cost/tokens for honest accounting.
    if (!text.trim()) {
      return {
        ok: false,
        rawText: null,
        latencyMs,
        costUsd,
        tokens,
        generationId,
        error: 'empty completion (model produced no output)',
      };
    }
    return { ok: true, rawText: text, latencyMs, costUsd, tokens, generationId, error: null };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    let msg: string;
    if (err instanceof Error && err.name === 'AbortError') {
      msg = `timeout after ${timeoutMs / 1000}s`;
    } else if (err instanceof Error) {
      const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
      msg = err.message + cause;
    } else {
      msg = String(err);
    }
    return {
      ok: false,
      rawText: null,
      latencyMs,
      costUsd: null,
      tokens: null,
      generationId: null,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ── OpenRouter transport ─────────────────────────────────────────────────

const OR_BASE = 'https://openrouter.ai/api/v1';

const OPENROUTER_MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.OPENROUTER_MAX_CONCURRENT) || 32
);

/**
 * Global governor: every OpenRouter call in the process shares one
 * concurrency pool so concurrent scans can't stampede the provider.
 */
const orGlobalLimit = pLimit(OPENROUTER_MAX_CONCURRENT);

/**
 * Transient rate-limit/overload errors are worth waiting out; a hard key
 * spending cap is not.
 */
function isTransientLimit(error: string | null): boolean {
  if (!error) return false;
  if (/key limit/i.test(error)) return false;
  return /HTTP 429|rate.?limit|overloaded|HTTP 503|HTTP 502/i.test(error);
}

function openRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  return key.trim().replace(/^["']|["']$/g, '');
}

/**
 * Transient network failures (socket resets, DNS hiccups under concurrent
 * bursts) surface as a thrown fetch — retry those once before giving up.
 * Transient 429/502/503 get exponential backoff on top.
 */
export const callModelOpenRouter: CallModelFn = async (opts) => {
  return orGlobalLimit(async () => {
    let outcome = await callOpenRouterOnce(opts);
    if (!outcome.ok && outcome.error?.startsWith('network:')) {
      await new Promise((r) => setTimeout(r, 1000));
      outcome = await callOpenRouterOnce(opts);
    }
    for (const delayMs of [1000, 4000, 16000]) {
      if (outcome.ok || !isTransientLimit(outcome.error)) break;
      await new Promise((r) => setTimeout(r, delayMs));
      outcome = await callOpenRouterOnce(opts);
    }
    return outcome;
  });
};

async function callOpenRouterOnce(opts: CallModelOptions): Promise<CallOutcome> {
  const {
    modelId,
    imageJpeg,
    prompt,
    schema,
    schemaName = 'scan_result',
    timeoutMs = 60_000,
    reasoningEffort,
  } = opts;
  const content = [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${imageJpeg.toString('base64')}`,
      },
    },
  ];
  const payload: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: 'user', content }],
    max_tokens: 16000,
    temperature: 0,
    // OpenRouter currently returns usage.cost without being asked, but that is
    // an undocumented default and our cost column depends on it. Ask for it.
    usage: { include: true },
  };
  if (reasoningEffort === 'off') payload.reasoning = { max_tokens: 128 };
  else if (reasoningEffort) payload.reasoning = { effort: reasoningEffort };
  if (schema) {
    payload.response_format = {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey()}`,
        'Content-Type': 'application/json',
        'X-Title': 'wherebear-compare',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // fetch resolves on headers; generation streams in with the body.
    // Wall-clock latency must include the full body read.
    const bodyText = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      return {
        ok: false,
        rawText: null,
        latencyMs,
        costUsd: null,
        tokens: null,
        generationId: null,
        error: `HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
      };
    }
    const body = JSON.parse(bodyText) as {
      id?: string;
      choices?: {
        message?: { content?: string };
        error?: { message?: string };
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      error?: { message?: string };
    };
    if (body.error?.message) {
      return {
        ok: false,
        rawText: null,
        latencyMs,
        costUsd: null,
        tokens: null,
        generationId: body.id ?? null,
        error: body.error.message,
      };
    }
    const text = body.choices?.[0]?.message?.content ?? '';
    const usage = body.usage;
    const tokens = usage
      ? {
          prompt: usage.prompt_tokens ?? 0,
          completion: usage.completion_tokens ?? 0,
          reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        }
      : null;
    // HTTP 200 with an empty completion happens when a reasoning model burns
    // its whole token budget thinking (billed, zero output). Treat as failure
    // so callers' retry paths engage; keep cost/tokens for honest accounting.
    if (!text.trim()) {
      return {
        ok: false,
        rawText: null,
        latencyMs,
        costUsd: usage?.cost ?? null,
        tokens,
        generationId: body.id ?? null,
        error: 'empty completion (model produced no output)',
      };
    }
    return {
      ok: true,
      rawText: text,
      latencyMs,
      costUsd: usage?.cost ?? null,
      tokens,
      generationId: body.id ?? null,
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    let msg: string;
    if (err instanceof Error && err.name === 'AbortError') {
      msg = `timeout after ${timeoutMs / 1000}s`;
    } else if (err instanceof Error) {
      // undici hides the real reason (ECONNRESET etc.) in err.cause
      const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
      msg = `network: ${err.message}${cause}`;
    } else {
      msg = `network: ${String(err)}`;
    }
    return {
      ok: false,
      rawText: null,
      latencyMs,
      costUsd: null,
      tokens: null,
      generationId: null,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export { sumCost } from './cost';

/** Sum token usage across a set of call outcomes (for usage metering rows). */
export function sumTokens(outcomes: CallOutcome[]): {
  prompt: number;
  completion: number;
  reasoning: number;
} {
  const t = { prompt: 0, completion: 0, reasoning: 0 };
  for (const o of outcomes) {
    t.prompt += o.tokens?.prompt ?? 0;
    t.completion += o.tokens?.completion ?? 0;
    t.reasoning += o.tokens?.reasoning ?? 0;
  }
  return t;
}

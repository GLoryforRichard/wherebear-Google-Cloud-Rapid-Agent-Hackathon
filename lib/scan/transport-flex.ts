/**
 * Vertex Flex-tier transport — the half-price service tier for the intake
 * pipeline (SCAN_SERVICE_TIER=flex).
 *
 * Flex facts this file is built around (verified 2026-08):
 *  - Enabled per request via the HTTP header
 *    `X-Vertex-AI-LLM-Shared-Request-Type: flex`. The SDK's serviceTier
 *    config is SILENTLY IGNORED on Vertex (googleapis/js-genai#1468) — the
 *    header is the only working mechanism, and a missing header means full
 *    price with no error. Billing must be verified from the GCP console.
 *  - Latency target is 1–15 min; under load requests are preempted with
 *    429/503 and must be retried with exponential backoff.
 *  - `config.httpOptions.timeout` is MANDATORY, not optional: it raises
 *    undici's global dispatcher headers/body timeout (Node default 300s),
 *    which would otherwise kill a parked flex call at the transport layer.
 *    An external AbortController cannot do this. The timeout also arms per
 *    attempt — i.e. after the lane slot is acquired — which avoids the
 *    timer-before-gate erosion hazard documented in lib/scan/intake.ts.
 *  - Flex shares the standard RPM/TPM quota (no extended quota), but must
 *    NOT share lib/gemini.ts's standard concurrency gate: minutes-long flex
 *    calls sitting in that gate would starve search/voice/identify. Hence
 *    the dedicated lane below.
 *
 * The pipeline's own per-call timeoutMs (60–120s, tuned for the standard
 * tier) is deliberately ignored here — flex queueing routinely exceeds it.
 */

import pLimit from 'p-limit';
import { genai } from '@/lib/gemini';
import {
  type CallModelFn,
  buildVertexConfig,
  vertexContents,
  vertexOutcomeFromResponse,
} from './transport';

export const SCAN_SERVICE_TIER: 'standard' | 'flex' =
  process.env.SCAN_SERVICE_TIER === 'flex' ? 'flex' : 'standard';

const FLEX_MAX_CONCURRENT = Math.max(1, Number(process.env.FLEX_MAX_CONCURRENT) || 24);

/** Per-attempt transport timeout (SDK httpOptions.timeout), ≥60s. */
const FLEX_ATTEMPT_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.FLEX_ATTEMPT_TIMEOUT_MS) || 900_000
);

/** Total wall budget per call across all retries. */
const FLEX_CALL_DEADLINE_MS = Math.max(
  FLEX_ATTEMPT_TIMEOUT_MS,
  Number(process.env.FLEX_CALL_DEADLINE_MS) || 1_800_000
);

const MAX_ATTEMPTS = 5;

/** Dedicated flex lane — never touches lib/gemini.ts's standard gate. */
const flexLimit = pLimit(FLEX_MAX_CONCURRENT);

const FLEX_HEADER = 'X-Vertex-AI-LLM-Shared-Request-Type';

/**
 * Preemption (429/503), transient 500s, and transport-level timeouts are all
 * "flex is busy" signals worth retrying inside the deadline. Anything else
 * (400 schema errors, auth) rethrows immediately.
 */
function isRetryableFlex(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status ?? (err as { code?: number })?.code;
  if (status === 429 || status === 500 || status === 503) return true;
  return /RESOURCE_EXHAUSTED|resource exhausted|quota|UNAVAILABLE|INTERNAL|timeout|timed out|UND_ERR|fetch failed|ECONNRESET|socket/i.test(
    msg
  );
}

/**
 * generateContent on the flex tier: dedicated lane, own retry engine
 * (backoff 2s → 60s cap + jitter, bounded by FLEX_CALL_DEADLINE_MS).
 * Backoff sleeps happen OUTSIDE the lane so waiting calls don't hold slots.
 */
export async function generateContentFlex(
  params: Parameters<typeof genai.models.generateContent>[0]
): Promise<Awaited<ReturnType<typeof genai.models.generateContent>>> {
  const deadline = Date.now() + FLEX_CALL_DEADLINE_MS;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await flexLimit(() =>
        genai.models.generateContent({
          ...params,
          config: {
            ...(params.config ?? {}),
            httpOptions: {
              headers: { [FLEX_HEADER]: 'flex' },
              timeout: Math.min(FLEX_ATTEMPT_TIMEOUT_MS, remaining),
            },
          },
        })
      );
    } catch (err) {
      lastErr = err;
      if (!isRetryableFlex(err) || attempt === MAX_ATTEMPTS) throw err;
      const backoff = Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.random() * 1_000;
      if (Date.now() + backoff >= deadline) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[flex] attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${Math.round(backoff / 1000)}s — ${msg.slice(0, 120)}`
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastErr ?? new Error(`flex call exceeded ${FLEX_CALL_DEADLINE_MS}ms deadline`);
}

/** CallModelFn on the flex tier — drop-in for callModelVertex in runRowsHd. */
export const callModelVertexFlex: CallModelFn = async (opts) => {
  const started = performance.now();
  try {
    const response = await generateContentFlex({
      model: opts.modelId,
      contents: vertexContents(opts.prompt, opts.imageJpeg),
      config: buildVertexConfig(opts),
    });
    return vertexOutcomeFromResponse(
      response,
      Math.round(performance.now() - started),
      opts.modelId,
      'flex'
    );
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const msg =
      err instanceof Error
        ? err.message + (err.cause instanceof Error ? `: ${err.cause.message}` : '')
        : String(err);
    return {
      ok: false,
      rawText: null,
      latencyMs,
      costUsd: null,
      tokens: null,
      generationId: null,
      error: `flex: ${msg}`,
    };
  }
};

/**
 * Smoke test: confirm the Vertex FLEX service tier accepts our header and
 * measure its latency vs the standard tier.
 *   node --env-file=.env.local scripts/smoke-flex.mjs
 * Mirrors lib/gemini.ts config (vertexai, project, location='global') and
 * lib/scan/transport-flex.ts mechanics (header + httpOptions.timeout).
 *
 * NOTE: acceptance here only proves the header didn't error. Half-price
 * billing must be confirmed in the GCP Billing console (Flex SKUs) the next
 * day — a silently-ignored header bills at FULL price.
 */
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
const project = process.env.GOOGLE_CLOUD_PROJECT;
const model = process.env.GEMINI_SCAN_MODEL || 'gemini-3.6-flash';
console.log(`auth: ${apiKey ? 'AI Studio key' : 'Vertex ADC'} | project: ${project || '(n/a)'} | model: ${model}`);

const genai = apiKey
  ? new GoogleGenAI({ apiKey })
  : new GoogleGenAI({ vertexai: true, project, location: 'global' });

async function call(tier) {
  const config = { maxOutputTokens: 2000 };
  if (tier === 'flex') {
    config.httpOptions = {
      headers: { 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' },
      timeout: 900_000,
    };
  }
  const t0 = Date.now();
  const r = await genai.models.generateContent({
    model,
    contents: 'Reply with exactly: ok',
    config,
  });
  const ms = Date.now() - t0;
  console.log(
    `✓ ${tier.padEnd(8)} ${String(ms).padStart(6)}ms | responseId ${r.responseId ?? '(none)'} | text ${JSON.stringify(r.text)} | tokens in/out/think ${r.usageMetadata?.promptTokenCount}/${r.usageMetadata?.candidatesTokenCount}/${r.usageMetadata?.thoughtsTokenCount ?? 0}`
  );
}

try {
  await call('standard');
  await call('flex');
  console.log('Flex header accepted. Verify half-price in GCP Billing (Flex SKUs) tomorrow.');
} catch (e) {
  console.error('✗ call failed:', e?.message ?? e);
  process.exitCode = 1;
}

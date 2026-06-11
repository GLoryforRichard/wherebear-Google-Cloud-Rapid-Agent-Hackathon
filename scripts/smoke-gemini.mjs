/**
 * Smoke test: confirm Vertex AI Gemini auth works with current env + ADC.
 *   node --env-file=.env.local scripts/smoke-gemini.mjs
 * Mirrors lib/gemini.ts config (vertexai, project, location='global').
 */
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
const project = process.env.GOOGLE_CLOUD_PROJECT;
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
console.log(`auth: ${apiKey ? 'AI Studio key' : 'Vertex ADC'} | project: ${project || '(n/a)'} | model: ${model}`);

const genai = apiKey
  ? new GoogleGenAI({ apiKey })
  : new GoogleGenAI({ vertexai: true, project, location: 'global' });

try {
  const r = await genai.models.generateContent({ model, contents: 'Reply with exactly: ok' });
  console.log('✓ Gemini responded:', JSON.stringify(r.text));
} catch (e) {
  console.error('✗ Gemini call failed:', e?.message ?? e);
  process.exitCode = 1;
}

import { generateContentWithRetry, VISION_MODEL, DetectedProduct } from '@/lib/gemini';
import { Content, FunctionCall } from '@google/genai';
import { getDb } from '@/lib/mongodb';
import { AGENT_A_TOOLS, dispatchToolA } from './tools-a';
import { AgentEvent } from './types';
import { buildShelfContext } from '@/lib/shelves';

export interface AgentAInput {
  aisle: string;
  products: DetectedProduct[];
}

const SYSTEM_PROMPT = `You are Agent A, the "store memory writer" inside Wherebear, a small assistant for grocery workers in a bilingual (English + Chinese) shop.

You receive a list of products that were just detected on one shelf in a specific aisle. Your job is to weave each one into the store's persistent memory.

Vector search is multilingual, so customers can already find items in Korean / Japanese / typos via semantic similarity. The aliases you save are purely for a readable bilingual label, NOT for matching.

ULTRA-EFFICIENT WORKFLOW — exactly 4 turns total. Each turn issues ONE batched tool call. DO NOT call any single-product variant. NEVER fan a batchable operation into N individual calls.

Turn 1 — Look up every product in ONE call:
  - Call \`find_existing_products\` ONCE with the full \`canonical_names\` array
    of every input product. Returns a results map keyed by name.

Turn 2 — Generate aliases for the brand-new ones in ONE call:
  - Collect every canonical_name where results[name].found === false.
  - Call \`expand_aliases_batch\` ONCE with that list. If no new products, skip
    this turn and go straight to Turn 3.

Turn 3 — Save every product in ONE call:
  - Call \`save_products\` ONCE with the shared aisle code and a products array.
    Each entry has { canonical_name, aliases, category }.
    For new products: aliases = expand_aliases_batch result for that name.
    For known products: aliases = the existing aliases from Turn 1's result.

Turn 4 — Wrap up in ONE response containing BOTH tool calls (parallel):
  - \`record_shelf_evidence\` with aisle + canonical_names array
  - \`finish\` with a one-sentence summary.

Hard rules:
- find_existing_product (singular) and save_product (singular) are DEPRECATED.
  Always use the plural batched versions. The judges grade on efficiency.
- Don't ask the user questions. Don't include explanations between tool calls.
- Don't repeat tool calls for the same product.

CANONICAL_NAME RULES (critical — field-test bug caused 60% duplication):
- canonical_name MUST be ONLY the human-readable product name.
- Strip every parenthetical and bracketed suffix from the name before saving.
  e.g. "Raw Peanuts (dry-good)" → "Raw Peanuts"
       "Mung Beans [high]" → "Mung Beans"
       "Soy Sauce (sauce) [high]" → "Soy Sauce"
- The vision_category and vision_confidence hints in the user message are
  separate metadata. NEVER bake them into canonical_name.
- Use the same canonical_name on every visit so find_existing_products can
  bump evidence_count instead of inserting a near-duplicate row.`;

const MAX_STEPS = 80;

export async function* runAgentA(input: AgentAInput): AsyncGenerator<AgentEvent> {
  const db = await getDb();

  yield {
    type: 'plan_start',
    ts: Date.now(),
    message: `Got ${input.products.length} products for ${input.aisle}. Building memory…`,
  };

  const shelfContext = buildShelfContext(input.aisle);
  // IMPORTANT: name and metadata are kept on separate labeled lines so the
  // model never confuses category/confidence with the canonical_name. Previously
  // `${name} (${category}) [${confidence}]` was on one line and Gemini saved
  // names like "Mung Beans (dry-good)" into the DB, producing duplicate entries.
  const userTurn =
    `Aisle code: ${input.aisle}\n` +
    `Shelf context: ${shelfContext}\n\n` +
    `Products to process (use shelf context + vision_category as a hint to pick the saved category):\n` +
    input.products.map((p, i) => {
      const lines = [`${i + 1}. name: ${JSON.stringify(p.name)}`];
      if (p.category) lines.push(`   vision_category: ${p.category}`);
      if (p.confidence) lines.push(`   vision_confidence: ${p.confidence}`);
      return lines.join('\n');
    }).join('\n');

  const history: Content[] = [
    { role: 'user', parts: [{ text: userTurn }] },
  ];

  let step = 0;
  while (step < MAX_STEPS) {
    step += 1;

    const resp = await generateContentWithRetry({
      model: VISION_MODEL,
      contents: history,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: AGENT_A_TOOLS }],
        temperature: 0.2,
      },
    });

    const cand = resp.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const calls: FunctionCall[] = parts
      .map(p => p.functionCall)
      .filter((c): c is FunctionCall => !!c);

    // Capture any plain text the model emits (often a brief plan)
    const text = parts.map(p => p.text).filter(Boolean).join('').trim();
    if (text) {
      yield { type: 'agent_message', ts: Date.now(), message: text };
    }

    if (calls.length === 0) {
      yield { type: 'done', ts: Date.now(), summary: text || 'Agent ended without explicit finish.' };
      return;
    }

    history.push({ role: 'model', parts: cand!.content!.parts! });

    const functionResponses: Content['parts'] = [];
    let sawFinish = false;
    let finishSummary = '';

    for (const call of calls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const name = call.name ?? 'unknown';

      yield { type: 'tool_call', ts: Date.now(), tool: name, args };
      const result = await dispatchToolA(db, name, args);
      yield { type: 'tool_result', ts: Date.now(), tool: name, result };

      functionResponses.push({
        functionResponse: {
          name,
          response: result as Record<string, unknown>,
        },
      });

      if (name === 'finish') {
        sawFinish = true;
        finishSummary = (args.summary as string) ?? 'Done.';
      }
    }

    history.push({ role: 'user', parts: functionResponses });

    if (sawFinish) {
      yield { type: 'done', ts: Date.now(), summary: finishSummary };
      return;
    }
  }

  yield {
    type: 'error',
    ts: Date.now(),
    error: `Agent A exceeded ${MAX_STEPS} steps without calling finish.`,
  };
}

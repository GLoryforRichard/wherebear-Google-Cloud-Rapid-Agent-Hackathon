import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import sharp from 'sharp';
import { UsageTotals, EMPTY_USAGE, addUsage, extractGeminiUsage } from '@/lib/cost';

// ── LLM provider selection ───────────────────────────────────────────────
// Default is Vertex AI (Google Cloud). If GEMINI_API_KEY is set we use the
// Gemini Developer API (AI Studio) instead — same models & SDK, but a free-tier
// key with NO Cloud billing. Fallback for when the GCP project's billing is
// unavailable; set GEMINI_API_KEY in .env.local to switch.
const apiKey = process.env.GEMINI_API_KEY;
const project = process.env.GOOGLE_CLOUD_PROJECT;
// Gemini 3.x models are ONLY served from the "global" location on Vertex as of
// 2026-05. Hardcoded so a regional GOOGLE_CLOUD_LOCATION can't break resolution.
const location = 'global';

if (!apiKey && !project) {
  throw new Error('Set GEMINI_API_KEY (AI Studio) or GOOGLE_CLOUD_PROJECT (Vertex) in .env.local');
}

export const genai = apiKey
  ? new GoogleGenAI({ apiKey })                              // AI Studio (free tier, no billing)
  : new GoogleGenAI({ vertexai: true, project, location });  // Vertex AI (Google Cloud)

// Overridable: the Vertex and Developer APIs don't always expose identical model
// ids, so GEMINI_MODEL lets the AI Studio path pick a different one if needed.
export const VISION_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

/**
 * Wrapper around `genai.models.generateContent` that automatically retries on
 * transient Vertex AI errors:
 *  - 429 RESOURCE_EXHAUSTED (per-minute quota burst)
 *  - 503 UNAVAILABLE
 *  - 500 INTERNAL
 *
 * Backoff: 1s → 2s → 4s → 8s (with jitter), max 5 attempts.
 *
 * Field-test trigger: photos with 25+ detected products fan into 3 batches of
 * Agent A loops (~15 generateContent calls each) and the last batch consistently
 * hit a 429 on the demo project's default 60 RPM quota.
 */
/**
 * Global Gemini concurrency gate. The demo project's Vertex quota is small —
 * an unthrottled vision request (5-6 parallel Stage-2 batches, times up to 5
 * photos in flight) triggered sustained 429 storms where every call burned
 * 15+ s in exponential backoff. Capping in-flight calls process-wide keeps us
 * under the burst limit, so calls run back-to-back instead of being punished.
 */
const MAX_CONCURRENT_GEMINI = 4;
let geminiInFlight = 0;
const geminiWaiters: Array<() => void> = [];

async function acquireGeminiSlot(): Promise<void> {
  while (geminiInFlight >= MAX_CONCURRENT_GEMINI) {
    await new Promise<void>(r => geminiWaiters.push(r));
  }
  geminiInFlight++;
}

function releaseGeminiSlot(): void {
  geminiInFlight--;
  geminiWaiters.shift()?.();
}

export async function generateContentWithRetry(
  params: Parameters<typeof genai.models.generateContent>[0]
): Promise<Awaited<ReturnType<typeof genai.models.generateContent>>> {
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await acquireGeminiSlot();
      try {
        return await genai.models.generateContent(params);
      } finally {
        releaseGeminiSlot();
      }
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        (err as { status?: number })?.status ??
        (err as { code?: number })?.code;

      const is429 =
        status === 429 ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('Resource exhausted') ||
        msg.toLowerCase().includes('quota');

      const is5xx =
        status === 500 ||
        status === 503 ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('INTERNAL');

      if (!is429 && !is5xx) throw err;
      if (attempt === MAX_ATTEMPTS - 1) throw err;

      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(
        `[gemini] ${is429 ? '429' : '5xx'} on attempt ${attempt + 1}/${MAX_ATTEMPTS}, ` +
        `retrying in ${Math.round(delay)}ms — ${msg.slice(0, 120)}`
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

/**
 * Tail-latency hedge for SMALL text-only calls: DSQ occasionally parks a
 * request for 30-60 s without a 429. If the first attempt hasn't answered
 * within `hedgeAfterMs`, fire a duplicate and take whichever lands first.
 * Only use on cheap calls — it can double the token spend of that call.
 */
export async function generateContentWithHedge(
  params: Parameters<typeof genai.models.generateContent>[0],
  hedgeAfterMs = 6000
): Promise<Awaited<ReturnType<typeof genai.models.generateContent>>> {
  const first = generateContentWithRetry(params);
  const timedOut = Symbol('hedge');
  const raced = await Promise.race([
    first,
    new Promise<typeof timedOut>(r => setTimeout(() => r(timedOut), hedgeAfterMs)),
  ]);
  if (raced !== timedOut) return raced;
  console.warn(`[gemini] call still pending after ${hedgeAfterMs}ms — firing hedge request`);
  const second = generateContentWithRetry(params);
  // Whichever resolves first wins; silence the loser's eventual rejection.
  first.catch(() => {});
  second.catch(() => {});
  return Promise.race([first, second]);
}

export interface DetectedProduct {
  name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** Normalized [y_min, x_min, y_max, x_max] in 0–1000 coordinates from Gemini. */
  box_2d?: [number, number, number, number];
  /** Client-cropped thumbnail (data URL). Filled in after vision returns. */
  thumbnail?: string;
}

const BASE_VISION_PROMPT = `You are looking at a grocery store shelf photo from an Asian / international supermarket.

Identify every distinct product visible on the shelf. The shelf may contain items with packaging in English, Chinese, Korean, Japanese, or other languages.

IMPORTANT — what counts as a product:
- Only retail packages physically placed on the shelf for customers to buy.
- Skip labels printed on cardboard SHIPPING BOXES at the very top of the shelf (those boxes are storage, not stock).
- Skip price tags and shelf talkers.
- If you see N identical packages stacked, return ONE entry with a single bounding box covering the cluster.

CRITICAL — name the SPECIFIC product, never a category fallback:

Forbidden generic names (these are categories, not products):
  "Dried beans", "Sauce", "Snack", "Drink", "Noodle", "Spice", "Candy",
  "Cookies", "Canned food", "Chips", "Instant noodle", "Tea", "Oil",
  "Vinegar", "Frozen food".

How to name correctly — ALWAYS use the most specific identifier you can find,
ranked by reliability:

1. PACKAGING LABEL — Read every word printed on the package, in any language
   (English, 中文, 한국어, 日本語, हिन्दी, Tagalog, Spanish). The exact product
   name is almost always written there. Combine the brand + variety when both
   are visible, e.g. "Samyang Buldak Ramen", "Kewpie Mayonnaise", "Lao Gan Ma
   Chili Crisp", "Heinz Tomato Ketchup", "Pocky Strawberry".

2. VARIETY CUES — If only a generic name is printed (e.g. "BEANS"), look at:
   - Color / shape of contents through transparent packaging
   - Country-of-origin flag or text
   - Cooking-instructions illustration on the back
   - Net weight + packaging style typical of a known variety
   Then name the specific variety: "Mung Beans" / "Kidney Beans" / "Sichuan
   Peppercorn" / "Star Anise" / "Sushi Nori" / "Rice Vermicelli" / "Yuzu Tea".

3. SHELF HINT — Use the worker-provided shelf hint to disambiguate between
   plausible varieties, but never override clear visual or textual evidence.

4. UNCERTAIN — If after all of the above you still cannot identify the
   specific product, set confidence="low" AND write a SHORT descriptor that
   includes color/shape/packaging clues, e.g. "Unidentified red bottle sauce
   (no visible label)", NOT "Sauce". Never regress to a category-only label.

Return ONLY a JSON array of objects, no prose, no markdown code fence. Each
object has:
- "name": short SPECIFIC canonical English name. Title Case. No trailing
  category in parens. Brand prefix only when clearly visible and helpful.
- "category": one of "sauce", "noodle", "snack", "frozen", "drink", "dry-good",
  "fresh", "other"
- "confidence": "high" | "medium" | "low"
- "box_2d": [y_min, x_min, y_max, x_max] tight rectangle around the actual
  package, normalized to 0–1000 (Gemini's standard bounding-box format)

If the shelf is empty or unreadable, return [].

Examples across categories (showing the level of specificity expected):
[
  {"name":"Lao Gan Ma Chili Crisp","category":"sauce","confidence":"high","box_2d":[120,80,420,340]},
  {"name":"Kewpie Mayonnaise","category":"sauce","confidence":"high","box_2d":[100,360,400,560]},
  {"name":"Samyang Buldak Ramen","category":"noodle","confidence":"high","box_2d":[440,120,720,360]},
  {"name":"Pocky Strawberry","category":"snack","confidence":"high","box_2d":[120,580,360,760]},
  {"name":"Coca-Cola 330ml Can","category":"drink","confidence":"high","box_2d":[460,420,720,600]},
  {"name":"Mung Beans","category":"dry-good","confidence":"high","box_2d":[40,640,260,860]},
  {"name":"Sichuan Peppercorn","category":"dry-good","confidence":"medium","box_2d":[60,40,260,220]}
]`;

const TRANSCRIBE_PROMPT = `You are the speech-understanding step of a grocery-store "find a product" assistant.

The audio is a SHORT spoken request from a customer or store worker who wants to LOCATE a product. The speaker may have ANY accent (South Asian, East/Southeast Asian, Filipino, Hispanic, Middle Eastern, African, etc.) and may speak English, Chinese, or mix in a product name from another language. Background grocery-store noise is common.

Output the product / search phrase they are asking for, as a short clean search query:
- Transcribe what they actually want to find. Use common grocery product knowledge to fix obvious accent-driven mishearings (e.g. something that sounds like "black paper for sushi" → "sushi nori"; "low gun ma" → "Lao Gan Ma").
- Keep brand and product names as spoken. Do NOT translate — if they spoke Chinese, answer in Chinese; if English, answer in English.
- Output ONLY the search phrase. No quotes, no surrounding punctuation, no explanation.
- If the audio is silent or truly unintelligible, output exactly: (unclear)`;

/**
 * Transcribe a short spoken product request to a clean search phrase using
 * Gemini audio understanding. Far more robust to accents / multilingual input
 * than the browser Web Speech API, and it can lean on store context to repair
 * mishearings. `langHint` ('en' | 'zh') nudges the expected language.
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  langHint?: string,
): Promise<{ text: string; text_en?: string; usage: Partial<UsageTotals> }> {
  const hint =
    langHint === 'zh'
      ? '\n\nThe app UI is set to Chinese — the speaker likely speaks Chinese or accented English.'
      : langHint === 'en'
        ? '\n\nThe app UI is set to English — the speaker likely speaks English (often accented) or may name a product in another language. If the search phrase you output is NOT already English, append its English translation after a "|||" separator, like: <phrase> ||| <english>.'
        : '';

  // Hedged + thinking off: transcription is the most latency-sensitive call
  // in the app (a customer is standing there waiting). Without an explicit
  // thinkingLevel, Gemini 3.x runs dynamic thinking on every clip.
  const result = await generateContentWithHedge({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: TRANSCRIBE_PROMPT + hint },
          { inlineData: { data: audioBase64, mimeType } },
        ],
      },
    ],
    config: {
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  }, 4000);

  const usage = extractGeminiUsage(result, 1);
  let raw = (result.text || '').trim();
  const strip = (s: string) => s.replace(/^["'“”「」[(]+|["'“”「」)\]]+$/g, '').trim();
  // EN mode may append an English translation after a "|||" separator.
  let text_en: string | undefined;
  const parts = raw.split('|||');
  if (parts.length >= 2) { raw = parts[0]; text_en = strip(parts[1]) || undefined; }
  let text = strip(raw);
  if (/^\(?unclear\)?$/i.test(text)) text = '';
  return { text, text_en, usage };
}

const IDENTIFY_PRODUCT_PROMPT = `The user is trying to FIND a product in a grocery store and took a photo of the item they're looking for — the product itself, its packaging, or even a picture of it on another screen.

Identify the SPECIFIC product so we can search the store for where it's stocked:
- Read any packaging text in any language (English, 中文, 한국어, 日本語, हिन्दी, etc.). Output brand + variety when visible, e.g. "Lao Gan Ma Chili Crisp", "Samyang Buldak Ramen", "Kewpie Mayonnaise".
- If text is unreadable, name the specific item type from its appearance, e.g. "Sushi Nori", "Mung Beans", "Rice Vermicelli".
- The photo may contain several items — pick the single most prominent / centered product.
- Output ONLY the product name as a short search phrase. No explanation, no quotes.
- If there is no identifiable grocery product, output exactly: (unclear)`;

/**
 * Identify the single product in a "find by photo" shot and return a clean
 * search phrase. Reuses the same Gemini vision model as the shelf pipeline,
 * but single-product (no boxes / crops). `langHint` nudges the output language.
 */
export async function identifyProductFromPhoto(
  imageBuffer: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mimeType: string = 'image/jpeg',
  langHint?: string,
): Promise<{ text: string; text_en?: string; usage: Partial<UsageTotals> }> {
  // Downsize the phone photo so we don't ship multiple MB to Gemini — 1024px
  // is plenty to read a label — and rotate() bakes in EXIF orientation.
  let jpeg: Buffer;
  try {
    jpeg = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    throw new Error(
      `image decode failed (corrupt or unsupported image): ` +
      (err instanceof Error ? err.message : String(err))
    );
  }

  const hint =
    langHint === 'zh'
      ? '\n\nIf the product name is Chinese, answer in Chinese.'
      : langHint === 'en'
        ? '\n\nIf the product name you output is NOT already English, append its English translation after a "|||" separator, like: <name> ||| <english>.'
        : '';

  // Hedged + thinking off — same latency posture as voice transcription:
  // someone is standing at the counter waiting for this.
  const result = await generateContentWithHedge({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: IDENTIFY_PRODUCT_PROMPT + hint },
          { inlineData: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' } },
        ],
      },
    ],
    config: {
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  }, 5000);

  const usage = extractGeminiUsage(result, 1);
  let raw = (result.text || '').trim();
  const strip = (s: string) => s.replace(/^["'“”「」[(]+|["'“”「」)\]]+$/g, '').trim();
  let text_en: string | undefined;
  const parts = raw.split('|||');
  if (parts.length >= 2) { raw = parts[0]; text_en = strip(parts[1]) || undefined; }
  let text = strip(raw);
  if (/^\(?unclear\)?$/i.test(text)) text = '';
  return { text, text_en, usage };
}

export async function detectProductsFromImage(
  imageBase64: string,
  mimeType: string = 'image/jpeg',
  /** Optional shelf context string (e.g. "B6 — Instant Noodles. Likely products: ...") */
  shelfContext?: string
): Promise<DetectedProduct[]> {
  const prompt = shelfContext
    ? `${BASE_VISION_PROMPT}\n\nShelf hint (the worker told us which shelf this photo is from): ${shelfContext}\nUse this hint to disambiguate items, but only report what you actually see.`
    : BASE_VISION_PROMPT;

  const result = await generateContentWithRetry({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { data: imageBase64, mimeType } },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  const text = result.text;
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed as DetectedProduct[];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-stage vision pipeline (Approach C)
//
// Stage 1: send full shelf photo, ask only for bounding boxes + a 1–3 word
//          visual hint per box. No product names yet.
// Crop:    server-side `sharp` cuts each box out of the original image, with
//          ~4% padding. Output is JPEG ≤ 600px on the long edge to keep the
//          Stage 2 payload reasonable.
// Stage 2: send ALL crops as multi-image parts in ONE generateContent call,
//          ask Gemini to give a SPECIFIC name + category + confidence for
//          each crop in array order.
//
// Net cost: 2 Gemini calls (vs. 1 single-shot), but per-product accuracy goes
// way up because Gemini focuses on one package at a time instead of competing
// against 20 packages in the same field of view.
// ─────────────────────────────────────────────────────────────────────────────

const STAGE1_DETECTION_PROMPT = `You are looking at a grocery store shelf photo from an Asian / international supermarket.

Locate every DISTINCT retail product SKU physically placed on the shelf. Do NOT name the products yet — Stage 2 will identify each one from a close-up crop.

🚨 CRITICAL — ONE BOX PER UNIQUE SKU, NOT PER PACKAGE 🚨

Grocery shelves stock 3–15 identical copies of every SKU. You MUST return ONE box per unique SKU, not one box per physical package. Examples of when to merge:

- "12 boxes of Kellogg's Vector Cereal arranged in a 4×3 grid" → ONE box covering the whole grid.
- "5 cans of Coca-Cola lined up left-to-right on a shelf" → ONE box covering the whole row.
- "A column of 4 stacked Pocky boxes" → ONE box covering the whole column.
- "Same Maggi noodle on the top AND bottom shelf" → ONE box covering BOTH cluster regions (or two boxes if the visual gap is huge — fine either way, dedup happens downstream).

How to tell two adjacent packages are the SAME SKU vs different SKUs:
- Identical front art, identical color scheme, identical brand logo → SAME SKU → merge.
- Different flavor variant (e.g. strawberry Pocky vs chocolate Pocky) → DIFFERENT SKUs → separate boxes even if same brand.
- Different size (large box vs small box of the same product) → DIFFERENT SKUs → separate boxes.

A typical full shelf photo should yield 8–20 SKU boxes, NOT 50+.

Also skip:
- Cardboard SHIPPING BOXES at the very top of the shelf (those are storage).
- Price tags and shelf talkers.
- Anything that's not actually for sale.

For each unique SKU return ONLY:
- "box_2d": [y_min, x_min, y_max, x_max] normalized to 0–1000 covering the WHOLE cluster of identical packages.

No other fields — identification happens in Stage 2. (Keeping the output to
bare coordinates roughly halves response time on dense shelves.)

Return ONLY a JSON array. If the shelf is empty or unreadable, return [].

Example for a shelf with 3 distinct SKUs (each stocked 4–6 times):
[
  {"box_2d":[120,40,420,580]},
  {"box_2d":[440,60,720,520]},
  {"box_2d":[740,80,980,560]}
]`;

const STAGE2_IDENTIFY_PROMPT = `You will receive several cropped photos of SINGLE grocery products from an Asian / international supermarket, in order.

For EACH crop in order, identify the SPECIFIC product by reading every visible word on the packaging in any language (English, 中文, 한국어, 日本語, हिन्दी, Tagalog, Spanish).

CRITICAL — name the SPECIFIC product, never a category fallback:

Forbidden generic names: "Sauce", "Noodle", "Beans", "Snack", "Drink", "Tea", "Oil", "Vinegar", "Spice", "Candy", "Cookies", "Canned food", "Chips", "Instant noodle", "Frozen food".

Naming priority:
1. PACKAGING LABEL — Combine brand + variety when both visible: "Samyang Buldak Ramen", "Kewpie Mayonnaise", "Lao Gan Ma Chili Crisp", "Heinz Tomato Ketchup", "Pocky Strawberry".
2. VARIETY CUES — If only a generic name is printed, use color/shape/origin/instructions to name the specific variety: "Mung Beans", "Kidney Beans", "Sichuan Peppercorn", "Sushi Nori", "Rice Vermicelli".
3. UNREADABLE — Set confidence="low" AND write a short visual descriptor with color/shape clues: "Unidentified red bottle sauce". Never regress to a category-only label.

Return ONLY a JSON array with EXACTLY one object per crop, in the SAME ORDER as the crops were sent. Each object has:
- "name": SPECIFIC product name in Title Case English. No parenthetical category suffix.
- "category": one of "sauce", "noodle", "snack", "frozen", "drink", "dry-good", "fresh", "other".
- "confidence": "high" | "medium" | "low".

Example for 3 crops:
[
  {"name":"Lao Gan Ma Chili Crisp","category":"sauce","confidence":"high"},
  {"name":"Kewpie Mayonnaise","category":"sauce","confidence":"high"},
  {"name":"Samyang Buldak Ramen","category":"noodle","confidence":"high"}
]`;

interface DetectedBox {
  box_2d: [number, number, number, number];
  label?: string;
}

interface IdentifiedCrop {
  name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
}

async function stage1DetectBoxes(
  imageBase64: string,
  mimeType: string,
  shelfContext?: string,
  extraNudge?: string
): Promise<{ boxes: DetectedBox[]; usage: Partial<UsageTotals> }> {
  const base = shelfContext
    ? `${STAGE1_DETECTION_PROMPT}\n\nShelf hint: ${shelfContext}\nUse the hint to skip clearly off-category items, but only report what you actually see.`
    : STAGE1_DETECTION_PROMPT;
  const prompt = extraNudge ? `${base}\n\n${extraNudge}` : base;

  // Hedged: DSQ sometimes parks a call for 60+ s with no 429 — a duplicate
  // fired at 15 s routinely lands in normal time (~12 s).
  const result = await generateContentWithHedge({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { data: imageBase64, mimeType } },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      // Stage 1 is pure perception (locate boxes) — no reasoning needed.
      // Disabling thinking shaves seconds off every detect call.
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  }, 15000);
  const usage = extractGeminiUsage(result, 1);

  const text = result.text;
  if (!text) return { boxes: [], usage };

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { boxes: [], usage };
    const boxes = parsed
      .map((b: unknown): DetectedBox | null => {
        const box = (b as DetectedBox)?.box_2d;
        if (!Array.isArray(box) || box.length !== 4) return null;
        const [y0, x0, y1, x1] = box;
        if (![y0, x0, y1, x1].every(n => typeof n === 'number' && isFinite(n))) return null;
        if (y1 <= y0 || x1 <= x0) return null;
        return { box_2d: [y0, x0, y1, x1], label: (b as DetectedBox).label };
      })
      .filter((b): b is DetectedBox => !!b);
    return { boxes, usage };
  } catch {
    return { boxes: [], usage };
  }
}

interface CropResult {
  /** 600px-long-edge JPEG, base64, fed to Stage 2 identification. */
  visionBase64: string;
  /** 240px-long-edge JPEG data URL, used directly as the client thumbnail. */
  thumbDataUrl: string;
  /** Higher = sharper/better lit. Used to pick a representative crop among
   *  duplicate SKUs. Computed from contrast (stdev) × mid-brightness weight. */
  qualityScore: number;
  /** Raw pixel area (in original-image pixels) for tie-breaking. */
  pixelArea: number;
}

/** Pre-decoded pixel buffer so N crops don't re-decode the full JPEG N times.
 *  On the 2-vCPU VM, decoding a ~12 MP shelf photo costs ~200-400 ms — doing
 *  it once instead of once PER BOX shaves seconds off dense shelves. */
interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

/** Crop one bounding box out of the pre-decoded image and score its quality. */
async function cropBox(
  raw: RawImage,
  imgWidth: number,
  imgHeight: number,
  box: [number, number, number, number]
): Promise<CropResult | null> {
  const [y0, x0, y1, x1] = box;
  // Normalize to 0–1 and add 4% padding so we don't shave the package edges.
  // Clamp BOTH ends to [0,1]: Gemini occasionally emits coords >1000, and with
  // only a lower-bound clamp `left`/`top` could land past the bitmap, making
  // sharp.extract throw "extract_area: bad extract area".
  const PAD = 0.04;
  const ny0 = Math.min(1, Math.max(0, y0 / 1000 - PAD));
  const nx0 = Math.min(1, Math.max(0, x0 / 1000 - PAD));
  const ny1 = Math.min(1, Math.max(0, y1 / 1000 + PAD));
  const nx1 = Math.min(1, Math.max(0, x1 / 1000 + PAD));

  // Build a pixel rect GUARANTEED to sit fully inside the image: clamp the
  // origin into bounds, then cap width/height to the space remaining to the
  // right/bottom edge so left+width never exceeds imgWidth.
  const left = Math.min(imgWidth - 1, Math.max(0, Math.round(nx0 * imgWidth)));
  const top = Math.min(imgHeight - 1, Math.max(0, Math.round(ny0 * imgHeight)));
  const width = Math.max(1, Math.min(imgWidth - left, Math.round((nx1 - nx0) * imgWidth)));
  const height = Math.max(1, Math.min(imgHeight - top, Math.round((ny1 - ny0) * imgHeight)));

  // A box that collapsed to a sliver (or sat entirely off-frame) isn't worth a
  // Stage-2 call — skip it, but log the numbers so the cause is visible.
  if (width < 8 || height < 8) {
    console.warn(
      `[vision] skipping degenerate crop: box=${JSON.stringify(box)} ` +
      `rect=${left},${top},${width}x${height} img=${imgWidth}x${imgHeight}`
    );
    return null;
  }

  try {
    // Extract from the pre-decoded pixel buffer — no JPEG decode per crop.
    const fromRaw = () =>
      sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
        .extract({ left, top, width, height });

    // 384px long edge keeps each crop a single Gemini image tile — on dense
    // shelves (70+ crops) this is the difference between Stage 2 finishing in
    // seconds vs minutes. (Contrast-based qualityScore was dropped with the
    // stats() pass: 1/3 of the sharp work for a tie-breaker that pixelArea +
    // confidence already cover.)
    const [visionJpeg, thumbJpeg] = await Promise.all([
      fromRaw()
        .resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 76 })
        .toBuffer(),
      fromRaw()
        .resize({ width: 240, height: 240, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer(),
    ]);

    return {
      visionBase64: visionJpeg.toString('base64'),
      thumbDataUrl: `data:image/jpeg;base64,${thumbJpeg.toString('base64')}`,
      qualityScore: 0, // dedupe falls through to confidence + pixelArea
      pixelArea: width * height,
    };
  } catch (err) {
    console.warn(
      `[vision] sharp crop failed: box=${JSON.stringify(box)} ` +
      `rect=${left},${top},${width}x${height} img=${imgWidth}x${imgHeight} — ` +
      (err instanceof Error ? err.message : String(err))
    );
    return null;
  }
}

// The demo project runs on Vertex Dynamic Shared Quota at the lowest tier,
// and DSQ throttles REQUEST RATE much harder than token volume: 4-6 parallel
// sub-batches degraded into "one success per backoff window" (Stage 2 took
// 140+ s in 429 retries). So the strategy is inverted from the usual fan-out:
// pack all crops into as FEW requests as possible — one call up to 40 crops,
// two calls beyond that.
const STAGE2_MAX_CROPS_PER_CALL = 40;

async function stage2IdentifyBatch(
  cropsBase64: string[],
  shelfContext: string | undefined,
  globalOffset: number,
  totalCrops: number
): Promise<{ identified: IdentifiedCrop[]; usage: Partial<UsageTotals> }> {
  if (cropsBase64.length === 0) return { identified: [], usage: {} };

  const prompt = shelfContext
    ? `${STAGE2_IDENTIFY_PROMPT}\n\nShelf hint: ${shelfContext}\nUse the hint to disambiguate between plausible varieties, but never override clear visual or textual evidence.\n\nIdentify these ${cropsBase64.length} products (out of ${totalCrops} total from this shelf, batch starting at crop ${globalOffset + 1}), one per crop, in order:`
    : `${STAGE2_IDENTIFY_PROMPT}\n\nIdentify these ${cropsBase64.length} products, one per crop, in order:`;

  const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [
    { text: prompt },
  ];
  cropsBase64.forEach((data, i) => {
    parts.push({ text: `Crop ${globalOffset + i + 1}:` });
    parts.push({ inlineData: { data, mimeType: 'image/jpeg' } });
  });

  // Hedged like Stage 1 — a parked batch call was turning 10-s Stage 2 runs
  // into 2-minute ones. The duplicate only fires on the pathological tail.
  const result = await generateContentWithHedge({
    model: VISION_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      // Stage 2 is visual recognition from close-up crops, not reasoning —
      // thinking adds latency without helping. Off for speed.
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  }, 15000);
  const usage = extractGeminiUsage(result, cropsBase64.length);

  const text = result.text;
  if (!text) return { identified: [], usage };

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { identified: [], usage };
    return { identified: parsed as IdentifiedCrop[], usage };
  } catch {
    return { identified: [], usage };
  }
}

async function stage2IdentifyCrops(
  cropsBase64: string[],
  shelfContext?: string
): Promise<{ identified: IdentifiedCrop[]; usage: UsageTotals }> {
  if (cropsBase64.length === 0) return { identified: [], usage: { ...EMPTY_USAGE } };

  // Single batch — no point spinning up the parallel machinery.
  if (cropsBase64.length <= STAGE2_MAX_CROPS_PER_CALL) {
    const single = await stage2IdentifyBatch(cropsBase64, shelfContext, 0, cropsBase64.length);
    return {
      identified: single.identified,
      usage: addUsage({ ...EMPTY_USAGE }, single.usage),
    };
  }

  // Minimal number of evenly-sized batches (see DSQ note above). Each batch
  // knows its global offset so the prompt makes sense ("batch starting at
  // crop 41 of 56") and so we can stitch results back in order.
  const nBatches = Math.ceil(cropsBase64.length / STAGE2_MAX_CROPS_PER_CALL);
  const per = Math.ceil(cropsBase64.length / nBatches);
  const batches: { offset: number; crops: string[] }[] = [];
  for (let i = 0; i < cropsBase64.length; i += per) {
    batches.push({ offset: i, crops: cropsBase64.slice(i, i + per) });
  }

  const settled = await Promise.allSettled(
    batches.map(b =>
      stage2IdentifyBatch(b.crops, shelfContext, b.offset, cropsBase64.length)
    )
  );

  const all: IdentifiedCrop[] = new Array(cropsBase64.length);
  let usage: UsageTotals = { ...EMPTY_USAGE };
  settled.forEach((res, bIdx) => {
    const { offset, crops } = batches[bIdx];
    if (res.status === 'fulfilled') {
      res.value.identified.forEach((id, j) => {
        all[offset + j] = id;
      });
      usage = addUsage(usage, res.value.usage);
    } else {
      console.warn(
        `[vision] stage 2 sub-batch ${bIdx} (offset ${offset}, ${crops.length} crops) failed:`,
        res.reason instanceof Error ? res.reason.message : res.reason
      );
    }
  });
  return { identified: all, usage };
}

/**
 * Two-stage detection+identification. Drop-in replacement for
 * `detectProductsFromImage` with better per-product accuracy.
 */
export async function detectAndIdentifyProducts(
  imageBuffer: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mimeType: string = 'image/jpeg',
  shelfContext?: string
): Promise<{ products: DetectedProduct[]; usage: UsageTotals }> {
  const usage: UsageTotals = { ...EMPTY_USAGE };
  // iPhone JPEGs store landscape pixels + an EXIF Orientation tag — viewers
  // (and Gemini) honor the tag and render the photo upright, but sharp's
  // default extract() works on the raw landscape buffer and ignores it. The
  // visual symptom is "the right product, rotated 90°" on the Find card.
  // Re-encoding once with .rotate() (no args) bakes the orientation into
  // the pixels and strips the EXIF tag, so every downstream op — Gemini
  // Stage 1, sharp.extract for crops, sharp.metadata for dimensions —
  // sees the same upright pixel grid the user originally captured.
  let buffer: Buffer;
  try {
    buffer = await sharp(imageBuffer)
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (err) {
    // Corrupt / truncated / unsupported upload. Surface a clear message so the
    // route logs something actionable instead of a raw sharp internal error.
    throw new Error(
      `image decode failed (corrupt or unsupported image): ` +
      (err instanceof Error ? err.message : String(err))
    );
  }

  // Stage 1 only needs to LOCATE products on the shelf — it doesn't need to
  // read the small text on each package. Downsizing the input to a 1280px
  // long edge cuts the inline-data size and Gemini's processing time in
  // half (≈12 s → ≈6 s on a typical shelf shot) without sacrificing box
  // accuracy. The full-res `buffer` is preserved for crop extraction so
  // Stage 2 still sees sharp, label-readable packaging.
  const stage1Buffer = await sharp(buffer)
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  // Stage 1 — detect boxes from downsized shelf photo.
  const t0 = Date.now();
  const stage1Base64 = stage1Buffer.toString('base64');
  const stage1Result = await stage1DetectBoxes(stage1Base64, 'image/jpeg', shelfContext);
  let boxes = stage1Result.boxes;
  Object.assign(usage, addUsage(usage, stage1Result.usage));

  // Gemini occasionally returns [] on perfectly good shelf shots — usually
  // when the JSON response gets clipped or it misreads the prompt. Retry
  // once with a slightly stronger nudge before we give up. Empirically
  // recovers ~80% of false-empty results.
  if (boxes.length === 0) {
    console.warn('[vision] Stage 1 returned 0 boxes — retrying once');
    const retry = await stage1DetectBoxes(
      stage1Base64,
      'image/jpeg',
      shelfContext,
      'There ARE products visible on this shelf — your previous answer was empty. Look again carefully. Return at least every clearly visible package.'
    );
    boxes = retry.boxes;
    Object.assign(usage, addUsage(usage, retry.usage));
    if (boxes.length === 0) {
      console.warn('[vision] Stage 1 returned 0 boxes on retry — giving up');
    } else {
      console.log(`[vision] Stage 1 retry recovered ${boxes.length} boxes`);
    }
  }

  if (boxes.length === 0) return { products: [], usage };

  // Mega-dense shelves can produce 70+ boxes; beyond ~56 the extras are mostly
  // tiny background packages that come back low-confidence anyway, while every
  // extra crop inflates the DSQ-throttled Stage-2 call. Keep the largest.
  const MAX_BOXES = 56;
  if (boxes.length > MAX_BOXES) {
    const area = (b: DetectedBox) =>
      Math.max(0, b.box_2d[2] - b.box_2d[0]) * Math.max(0, b.box_2d[3] - b.box_2d[1]);
    console.warn(`[vision] ${boxes.length} boxes detected — keeping the ${MAX_BOXES} largest`);
    boxes = [...boxes].sort((a, b) => area(b) - area(a)).slice(0, MAX_BOXES);
  }
  const tStage1 = Date.now();

  // Crop each box server-side — from the FULL-RES buffer, not the downsized one.
  const meta = await sharp(buffer).metadata();
  const imgWidth = meta.width ?? 0;
  const imgHeight = meta.height ?? 0;
  if (!imgWidth || !imgHeight) {
    console.warn('[vision] could not read image dimensions, falling back to Stage 1 labels only');
    const fallback = boxes.map(b => ({
      name: b.label && b.label.trim() ? toTitleCase(b.label) : 'Unidentified product',
      category: 'other',
      confidence: 'low' as const,
      box_2d: b.box_2d,
    }));
    return { products: fallback, usage };
  }

  // Decode the full-res photo ONCE; every crop extracts from these pixels.
  const { data: rawData, info: rawInfo } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawImage: RawImage = {
    data: rawData,
    width: rawInfo.width,
    height: rawInfo.height,
    channels: rawInfo.channels as 3 | 4,
  };

  const crops = await Promise.all(
    boxes.map(b => cropBox(rawImage, imgWidth, imgHeight, b.box_2d))
  );

  // Keep only boxes that successfully cropped.
  const indexedCrops: { box: DetectedBox; crop: CropResult }[] = [];
  crops.forEach((c, i) => {
    if (c) indexedCrops.push({ box: boxes[i], crop: c });
  });

  if (indexedCrops.length === 0) return { products: [], usage };
  const tCrops = Date.now();

  // Stage 2 — batch identify all crops in one call.
  const stage2Result = await stage2IdentifyCrops(
    indexedCrops.map(c => c.crop.visionBase64),
    shelfContext
  );
  const identified = stage2Result.identified;
  Object.assign(usage, addUsage(usage, stage2Result.usage));
  console.log(
    `[vision] timings: stage1=${tStage1 - t0}ms crops=${tCrops - tStage1}ms ` +
    `(${indexedCrops.length} boxes) stage2=${Date.now() - tCrops}ms total=${Date.now() - t0}ms`
  );

  // Merge by index. Carry the crop's quality data through so dedupe can pick
  // the sharpest / best-lit representative for each SKU.
  const merged: CandidateProduct[] = indexedCrops.map((c, i) => {
    const id = identified[i];
    const fallbackName =
      c.box.label && c.box.label.trim() ? toTitleCase(c.box.label) : 'Unidentified product';
    return {
      product: {
        name: id?.name?.trim() || fallbackName,
        category: id?.category || 'other',
        confidence: id?.confidence || 'low',
        box_2d: c.box.box_2d,
        thumbnail: c.crop.thumbDataUrl,
      },
      qualityScore: c.crop.qualityScore,
      pixelArea: c.crop.pixelArea,
    };
  });

  // Even with the strengthened Stage 1 prompt, the model sometimes returns
  // one box per physical package on a tall multi-row SKU. Collapse those —
  // and crucially, pick the crop with the best image quality (sharpness ×
  // brightness, with confidence + size as secondary signals) so the saved
  // thumbnail is the clearest representative of the SKU.
  const products = dedupeByName(merged);

  // Account for the thumbnails we'll persist downstream. Each 240px JPEG
  // is ~25 KB; sum the actual base64-decoded sizes so the storage line in
  // the cost panel reflects what was really written.
  const storageBytes = products.reduce((s, p) => {
    if (!p.thumbnail) return s;
    const b64 = p.thumbnail.split(',')[1] ?? '';
    // base64 → bytes ratio is 3/4
    return s + Math.floor(b64.length * 0.75);
  }, 0);
  usage.storageBytes += storageBytes;

  return { products, usage };
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

interface CandidateProduct {
  product: DetectedProduct;
  qualityScore: number;
  pixelArea: number;
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function normalizeNameForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge entries whose Stage-2 names normalize to the same string. Multi-row
 * SKUs collapse to one entry. Among duplicates, we pick the BEST CROP as the
 * representative thumbnail:
 *   1. highest Stage-2 confidence first
 *   2. then highest image-quality score (contrast × mid-brightness)
 *   3. then largest pixel area (more detail to look at)
 *
 * This way "12 boxes of Vector Cereal stocked across the shelf" collapse to
 * the single clearest, best-lit close-up — even if Gemini gave them all the
 * same confidence rating.
 */
function dedupeByName(candidates: CandidateProduct[]): DetectedProduct[] {
  const groups = new Map<string, CandidateProduct[]>();
  for (const c of candidates) {
    const key = normalizeNameForDedup(c.product.name);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  return Array.from(groups.values()).map(arr => {
    if (arr.length === 1) return arr[0].product;
    arr.sort((a, b) => {
      const ca = CONFIDENCE_RANK[a.product.confidence ?? 'low'] ?? 0;
      const cb = CONFIDENCE_RANK[b.product.confidence ?? 'low'] ?? 0;
      if (cb !== ca) return cb - ca;
      if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
      return b.pixelArea - a.pixelArea;
    });
    return arr[0].product;
  });
}

/**
 * The cost-lab scheme registry: which model serves each rows-hd stage.
 *
 * Stage roles (see lib/scan/run.ts):
 *  - rows    — 1 small call on the ≤2048px image; banding only. Robust to
 *              degradation (pipeline falls back to a single full band).
 *  - detect  — per-band HD box detection with full reasoning. QUALITY
 *              CRITICAL: the reasoning produces the one-box-per-identical-
 *              product-group semantics.
 *  - readout — grid name reading with reasoning off. Verbatim-reading task,
 *              prime candidate for cheap models.
 *
 * Models chosen from OpenRouter's 2026-08 catalog:
 *  - google/gemini-3.6-flash        $1.50/M in  $7.50/M out  (baseline)
 *  - google/gemini-3.6-flash:batch  $0.75/M in  $3.75/M out  (same weights,
 *    half price, queued at lower priority — fits the async intake queue)
 *  - google/gemini-2.5-flash-lite   $0.10/M in  $0.40/M out
 *  - qwen/qwen3-vl-8b-instruct      $0.117/M in $0.455/M out (Apache-2.0
 *    open weights — self-hostable later, hosted price today)
 *  - qwen/qwen3-vl-32b-instruct     $0.104/M in $0.416/M out (open weights)
 *  - qwen/qwen3.7-flash             $0.03/M in  $0.13/M out
 */

import type { StageSpec } from './transport-lab';

export interface LabScheme {
  id: string;
  title: string;
  titleZh: string;
  blurbZh: string;
  rows: StageSpec;
  detect: StageSpec;
  readout: StageSpec;
  bandConcurrency: number;
  gridConcurrency: number;
}

const G36 = 'google/gemini-3.6-flash';
const G36B = 'google/gemini-3.6-flash:batch';
const LITE = 'google/gemini-2.5-flash-lite';
const QWEN8 = 'qwen/qwen3-vl-8b-instruct';
const QWEN32 = 'qwen/qwen3-vl-32b-instruct';
const QWEN37F = 'qwen/qwen3.7-flash';

/** :batch calls may queue before generation; give them a wide window. */
const BATCH_TIMEOUT = 420_000;

const or = (modelId: string, minTimeoutMs?: number): StageSpec => ({
  modelId,
  transport: 'openrouter',
  minTimeoutMs,
});

/**
 * The gemini-3.6-flash stages: on the production VM set COSTLAB_G36_VERTEX=1
 * so they run on Vertex via the attached-SA ADC — the EXACT production
 * transport (lib/scan/intake.ts), billed to the free-trial credits, cost
 * estimated from the same list price OpenRouter charges. Locally (no VM
 * metadata ADC) they default to OpenRouter with actual billing.
 */
const G36_SPEC: StageSpec =
  process.env.COSTLAB_G36_VERTEX === '1'
    ? { modelId: 'gemini-3.6-flash', transport: 'vertex' }
    : { modelId: G36, transport: 'openrouter' };
const g36 = (): StageSpec => ({ ...G36_SPEC });

function scheme(
  id: string,
  title: string,
  titleZh: string,
  blurbZh: string,
  rows: StageSpec,
  detect: StageSpec,
  readout: StageSpec
): LabScheme {
  return {
    id,
    title,
    titleZh,
    blurbZh,
    rows,
    detect,
    readout,
    bandConcurrency: 8,
    gridConcurrency: 16,
  };
}

export const SCHEMES: LabScheme[] = [
  scheme(
    'baseline',
    'All gemini-3.6-flash',
    '基准：全程 3.6-flash',
    '生产现行配置，三个环节都是 gemini-3.6-flash。跑两次取自身一致度作为“噪声底线”。',
    g36(),
    g36(),
    g36()
  ),
  scheme(
    'batch-all',
    'Same model, batch pricing',
    '同模型 batch 半价',
    '三个环节仍是 gemini-3.6-flash，但走 :batch 半价档（低优先级排队）。权重相同、输出分布相同，纯价格杠杆，适合本来就异步的录入队列。',
    or(G36B, BATCH_TIMEOUT),
    or(G36B, BATCH_TIMEOUT),
    or(G36B, BATCH_TIMEOUT)
  ),
  scheme(
    'lite-readout',
    'Keep detect, lite rows+readout',
    '混合：框选保真，读名换 lite',
    '质量关键的条带框选仍用 3.6-flash 全推理；行检测和网格读名换 gemini-2.5-flash-lite（≈15 倍便宜）。',
    or(LITE),
    g36(),
    or(LITE)
  ),
  scheme(
    'lite-readout2',
    'Lite readout only (rows stay G36)',
    '推荐混合：只换读名(lite)',
    '实测教训：行检测换廉价模型会切出更多条带、反把框选成本放大。行检测+框选都留 3.6-flash，只把读名换成 flash-lite。',
    g36(),
    g36(),
    or(LITE)
  ),
  scheme(
    'qwen-readout2',
    'Open-weights readout only (rows stay G36)',
    '开源读名(修正)：Qwen3-VL-8B',
    '行检测+框选留 3.6-flash，读名换开放权重 Qwen3-VL-8B（Apache 2.0，可自托管）。',
    g36(),
    g36(),
    or(QWEN8)
  ),
  scheme(
    'lite-readout-batch',
    'Batch detect + lite rows/readout',
    '混合＋batch：框选半价，其余 lite',
    '在“混合”方案之上，把唯一保留的 3.6-flash 框选环节也切到 :batch 半价档。',
    or(LITE),
    or(G36B, BATCH_TIMEOUT),
    or(LITE)
  ),
  scheme(
    'qwen-readout',
    'Open-weights readout (Qwen3-VL-8B)',
    '开源读名：Qwen3-VL-8B',
    '框选保真（3.6-flash），读名换开放权重 Qwen3-VL-8B（Apache 2.0，可自托管；现用托管价）。',
    or(LITE),
    g36(),
    or(QWEN8)
  ),
  scheme(
    'all-lite',
    'Everything on 2.5-flash-lite',
    '全廉价：全程 flash-lite',
    '三个环节全部 gemini-2.5-flash-lite。最激进的谷歌系降本，考验框选分组质量。',
    or(LITE),
    or(LITE),
    or(LITE)
  ),
  scheme(
    'all-qwen',
    'Everything on open-weights Qwen3-VL-32B',
    '全开源：全程 Qwen3-VL-32B',
    '端到端开放权重模型（Apache 2.0）。验证“纯开源栈”能否达到基准效果，未来可自托管到自有 GPU。框选环节带坐标适配层（Qwen 习惯 x-first，首轮实测框全部转置）。',
    { ...or(QWEN32), swapBoxOrder: true },
    { ...or(QWEN32), swapBoxOrder: true },
    or(QWEN32)
  ),
  scheme(
    'qwen37-readout',
    'Cheapest readout (qwen3.7-flash)',
    '极限读名：qwen3.7-flash',
    '框选保真（3.6-flash），行检测+读名用目前最便宜的可用视觉模型 qwen3.7-flash（$0.03/M 输入）。',
    or(QWEN37F),
    g36(),
    or(QWEN37F)
  ),
];

export function getScheme(id: string): LabScheme | undefined {
  return SCHEMES.find((s) => s.id === id);
}

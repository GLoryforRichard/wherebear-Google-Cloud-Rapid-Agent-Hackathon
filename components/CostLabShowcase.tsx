'use client';

/**
 * CostLabShowcase — 拍照识别管线降本对比的展示组件。
 *
 * 被两处使用:
 *  - /cost-lab           独立页(本地实验用)
 *  - /compare 页面底部    生产站展示(embedded)
 *
 * 只读展示:静态拉取 /cost-lab-results/ 下的 JSON 工件,本组件不触发任何
 * 模型调用。工件由 POST /api/cost-lab 在部署机上生成(服务器实测)。
 */

import { useEffect, useMemo, useState } from 'react';


type StageName = 'rows' | 'detect' | 'readout';

interface StageCost {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface SchemeMetrics {
  boxRecall: number;
  boxPrecision: number;
  nameAgreement: number;
  entryJaccard: number;
  matchedBoxes: number;
  baseBoxes: number;
  schemeBoxes: number;
  missedNames: string[];
  extraNames: string[];
}

interface IndexScheme {
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
  metrics: SchemeMetrics | null;
}

interface IndexPhoto {
  photo: string;
  preview: string;
  imageWidth: number;
  imageHeight: number;
  noiseFloor: SchemeMetrics | null;
  schemes: IndexScheme[];
}

interface LabIndex {
  generatedAt: string;
  photos: IndexPhoto[];
}

interface LabEntry {
  name: string;
  count: number;
  box_2d: [number, number, number, number];
  boxes_2d: [number, number, number, number][];
  thumbnail?: string;
}

interface LabRunArtifact extends Omit<IndexScheme, 'file' | 'metrics'> {
  entries: LabEntry[];
}

/** 展示顺序 + 中文标题(与 lib/costlab/schemes.ts 对齐)。 */
const SCHEME_META: Record<
  string,
  { titleZh: string; sub: string; color: string; derived?: boolean }
> = {
  baseline: { titleZh: '基准 · 全程 3.6-flash', sub: '生产现行配置', color: '#3b82f6' },
  'baseline-alt': { titleZh: '基准第二次运行(噪声底线)', sub: '同配置重跑', color: '#93c5fd' },
  'lite-readout2': {
    titleZh: '推荐混合 · 只换读名(lite)',
    sub: '行检测+框选留 3.6-flash,读名 → 2.5-flash-lite',
    color: '#10b981',
  },
  'qwen-readout2': {
    titleZh: '开源读名 · Qwen3-VL-8B',
    sub: '读名 → 开放权重 Qwen(可自托管)',
    color: '#8b5cf6',
  },
  'lite-readout': {
    titleZh: '反例 · 行检测也换 lite',
    sub: '教训:廉价行检测多切条带,反而放大框选成本',
    color: '#64748b',
  },
  'qwen-readout': {
    titleZh: '反例 · lite行检测 + Qwen读名',
    sub: '同上,行检测换廉价模型是负优化',
    color: '#94a3b8',
  },
  'qwen37-readout': {
    titleZh: '极限读名 · qwen3.7-flash',
    sub: '行检测+读名 → 最便宜视觉模型',
    color: '#f59e0b',
  },
  'all-lite': { titleZh: '全廉价 · 全程 flash-lite', sub: '三环节全换', color: '#ef4444' },
  'all-qwen': {
    titleZh: '全开源 · 全程 Qwen3-VL-32B',
    sub: '端到端开放权重 + 坐标适配层(Qwen 惯用 x-first)',
    color: '#ec4899',
  },
};

const ORDER = [
  'baseline',
  'baseline-alt',
  'lite-readout2',
  'qwen-readout2',
  'qwen37-readout',
  'all-qwen',
  'all-lite',
  'lite-readout',
  'qwen-readout',
];

const PHOTO_LABEL: Record<string, string> = {
  'test-shelf': '基准货架照 (test-shelf)',
  'sample-shelf': '样例货架照 (sample-shelf)',
};

/** 跑失败的方案 — 同样是结论,如实展示。 */
const FAILED_SCHEMES: { titleZh: string; models: string; reason: string }[] = [
  {
    titleZh: '全廉价 · 全程 flash-lite',
    models: 'g2.5-flash-lite ×3',
    reason:
      '条带框选环节两次运行均有条带输出无法解析(重试后仍失败,覆盖不完整)。flash-lite 不能胜任框选;读名环节它是合格的(见「推荐混合」)。',
  },
  {
    titleZh: '同模型 :batch 半价(实测)',
    models: 'g3.6-flash:batch ×3',
    reason:
      'OpenRouter 的 :batch 模型只开放异步 Batch API(/api/beta/batches),同步接口返回 404。降本逻辑成立(同权重半价),需要单独接批量接口,见上方推算行。',
  },
];

function fmtUsd(v: number): string {
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortModel(id: string): string {
  return id
    .replace('google/', '')
    .replace('qwen/', '')
    .replace('gemini-', 'g')
    .replace('-instruct', '');
}

type Verdict = { label: string; bg: string; fg: string };

/** 与噪声底线比较:方案两次运行间的差异 ≤ 基准自身两次运行的差异 → 同效。 */
function verdictOf(m: SchemeMetrics | null, floor: SchemeMetrics | null): Verdict {
  if (!m) return { label: '基准参照', bg: '#eff6ff', fg: '#1d4ed8' };
  if (!floor) return { label: '待评估', bg: '#f4f4f5', fg: '#52525b' };
  const dRecall = m.boxRecall - floor.boxRecall;
  const dName = m.nameAgreement - floor.nameAgreement;
  const dJac = m.entryJaccard - floor.entryJaccard;
  if (dRecall >= -0.03 && dName >= -0.03 && dJac >= -0.05)
    return { label: '≈ 同效', bg: '#d1fae5', fg: '#047857' };
  if (dRecall >= -0.1 && dName >= -0.1 && dJac >= -0.12)
    return { label: '接近', bg: '#fef3c7', fg: '#b45309' };
  return { label: '有差距', bg: '#fee2e2', fg: '#b91c1c' };
}

function boxStyle(box: [number, number, number, number]): React.CSSProperties {
  const [y0, x0, y1, x1] = box;
  return {
    position: 'absolute',
    top: `${y0 / 10}%`,
    left: `${x0 / 10}%`,
    width: `${(x1 - x0) / 10}%`,
    height: `${(y1 - y0) / 10}%`,
  };
}

function Chip({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span
      style={{
        background: strong ? '#111' : '#f4f4f5',
        color: strong ? '#fff' : undefined,
        borderRadius: 4,
        padding: '3px 8px',
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: strong ? '#d4d4d8' : '#71717a' }}>{label} </span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </span>
  );
}

function SchemeCard({
  scheme,
  meta,
  preview,
  floor,
  baselineCost,
  artifact,
}: {
  scheme: IndexScheme;
  meta: { titleZh: string; sub: string; color: string };
  preview: string;
  floor: SchemeMetrics | null;
  baselineCost: number | null;
  artifact: LabRunArtifact | null;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const v = verdictOf(scheme.metrics, floor);
  const saving =
    baselineCost && baselineCost > 0 ? 1 - scheme.totalCostUsd / baselineCost : null;

  return (
    <div
      style={{
        border: '1px solid #e4e4e7',
        borderTop: `3px solid ${meta.color}`,
        borderRadius: 10,
        padding: 12,
        minWidth: 0,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: meta.color }}>{meta.titleZh}</div>
        <span
          style={{
            background: v.bg,
            color: v.fg,
            borderRadius: 999,
            padding: '2px 10px',
            fontSize: 11,
            fontWeight: 700,
            whiteSpace: 'nowrap',
            alignSelf: 'flex-start',
          }}
        >
          {v.label}
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#71717a', marginBottom: 8 }}>{meta.sub}</div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
        <Chip label="成本/张" value={fmtUsd(scheme.totalCostUsd)} strong />
        {saving !== null && saving > 0.001 && (
          <Chip label="省" value={`-${(saving * 100).toFixed(0)}%`} />
        )}
        <Chip label="商品" value={String(scheme.count)} />
        <Chip label="用时" value={fmtS(scheme.elapsedMs)} />
      </div>

      {scheme.metrics && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
          <Chip label="框覆盖" value={pct(scheme.metrics.boxRecall)} />
          <Chip label="名称一致" value={pct(scheme.metrics.nameAgreement)} />
          <Chip label="清单Jaccard" value={pct(scheme.metrics.entryJaccard)} />
        </div>
      )}

      {/* 三环节模型 + 分环节成本 */}
      <div
        style={{
          fontSize: 10.5,
          fontFamily: 'ui-monospace, Menlo, monospace',
          color: '#52525b',
          background: '#fafafa',
          borderRadius: 6,
          padding: '6px 8px',
          marginBottom: 10,
          lineHeight: 1.7,
        }}
      >
        {(['rows', 'detect', 'readout'] as StageName[]).map((st) => (
          <div key={st} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>
              {st === 'rows' ? '① 行检测' : st === 'detect' ? '② 条带框选' : '③ 网格读名'}{' '}
              <b>{shortModel(scheme.models[st])}</b>
            </span>
            <span>{fmtUsd(scheme.perStage[st].costUsd)}</span>
          </div>
        ))}
      </div>

      {/* 带框结果图 */}
      <div
        style={{ position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden', marginBottom: 10 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview} alt="shelf" style={{ width: '100%', display: 'block' }} />
        {artifact?.entries.flatMap((e, i) =>
          (e.boxes_2d?.length ? e.boxes_2d : [e.box_2d]).map((box, j) => (
            <div
              key={`${i}-${j}`}
              style={{
                ...boxStyle(box),
                border: `1.5px solid ${meta.color}`,
                background:
                  hovered === i ? 'rgba(255,255,255,0.35)' : 'transparent',
                zIndex: hovered === i ? 10 : 1,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  background: meta.color,
                  color: '#fff',
                  fontSize: 9,
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  padding: '0 3px',
                  lineHeight: '13px',
                }}
              >
                {i}
              </span>
            </div>
          ))
        )}
        {!artifact && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(255,255,255,0.6)',
              fontSize: 12,
              color: '#71717a',
            }}
          >
            清单加载中…
          </div>
        )}
      </div>

      {/* 差异摘要 */}
      {scheme.metrics &&
        (scheme.metrics.missedNames.length > 0 || scheme.metrics.extraNames.length > 0) && (
          <div style={{ marginBottom: 8 }}>
            <button
              onClick={() => setShowDiff((s) => !s)}
              style={{
                border: '1px solid #e4e4e7',
                background: '#fff',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 11,
                cursor: 'pointer',
                color: '#52525b',
              }}
            >
              {showDiff ? '收起' : '展开'}与基准清单的差异 (漏{scheme.metrics.missedNames.length} 多
              {scheme.metrics.extraNames.length})
            </button>
            {showDiff && (
              <div style={{ fontSize: 11, color: '#52525b', marginTop: 6, lineHeight: 1.6 }}>
                {scheme.metrics.missedNames.length > 0 && (
                  <div>
                    <b style={{ color: '#b91c1c' }}>基准有而本方案没有:</b>{' '}
                    {scheme.metrics.missedNames.join('、')}
                  </div>
                )}
                {scheme.metrics.extraNames.length > 0 && (
                  <div>
                    <b style={{ color: '#b45309' }}>本方案多出:</b>{' '}
                    {scheme.metrics.extraNames.join('、')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      {/* 商品清单 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 380, overflowY: 'auto' }}>
        {artifact?.entries.map((e, i) => (
          <div
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '4px 6px',
              border: hovered === i ? `2px solid ${meta.color}` : '1px solid #f0f0f1',
              borderRadius: 8,
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: '#a1a1aa',
                fontFamily: 'ui-monospace, Menlo, monospace',
                minWidth: 16,
              }}
            >
              #{i}
            </span>
            {e.thumbnail && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={e.thumbnail}
                alt={e.name}
                style={{
                  width: 40,
                  height: 40,
                  objectFit: 'contain',
                  borderRadius: 4,
                  background: '#f4f4f5',
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25, minWidth: 0 }}>
              {e.name}
              {e.count > 1 && (
                <span
                  style={{
                    marginLeft: 6,
                    background: '#f4f4f5',
                    color: '#52525b',
                    borderRadius: 4,
                    padding: '0 5px',
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  ×{e.count}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CostLabShowcase({ embedded = false }: { embedded?: boolean }) {
  const [index, setIndex] = useState<LabIndex | null>(null);
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, LabRunArtifact>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Cache-buster: Next's production server negative-caches a static path
    // that was requested before the file existed (measured on the VM:
    // index.json 404'd from cache while sibling artifacts served 200). A
    // unique query string sidesteps the poisoned entry.
    fetch(`/cost-lab-results/index.json?t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`index.json HTTP ${r.status} — 先跑 GET /api/cost-lab 生成`);
        return r.json();
      })
      .then((d: LabIndex) => {
        setIndex(d);
        setPhotoKey(d.photos[0]?.photo ?? null);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  const photo = useMemo(
    () => index?.photos.find((p) => p.photo === photoKey) ?? null,
    [index, photoKey]
  );

  useEffect(() => {
    if (!photo) return;
    for (const s of photo.schemes) {
      if (artifacts[s.file]) continue;
      fetch(s.file)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: LabRunArtifact | null) => {
          if (d) setArtifacts((a) => ({ ...a, [s.file]: d }));
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo]);

  const ordered = useMemo(() => {
    if (!photo) return [];
    const key = (s: IndexScheme) =>
      s.runTag === 'alt' ? `${s.schemeId}-alt` : s.schemeId;
    return [...photo.schemes].sort(
      (a, b) => ORDER.indexOf(key(a)) - ORDER.indexOf(key(b))
    );
  }, [photo]);

  const baseline = ordered.find((s) => s.schemeId === 'baseline' && s.runTag === 'main') ?? null;
  const floor = photo?.noiseFloor ?? null;

  return (
    <div
      style={{
        padding: embedded ? 0 : '20px 16px 60px',
        background: '#fff',
        color: '#111',
        minHeight: embedded ? undefined : '100vh',
        maxWidth: 1500,
        margin: '0 auto',
      }}
    >
      {!embedded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <a href="/" style={{ color: '#06f', textDecoration: 'underline', fontSize: 14 }}>
            ← home
          </a>
          <a href="/compare" style={{ color: '#06f', textDecoration: 'underline', fontSize: 14 }}>
            /compare
          </a>
        </div>
      )}

      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>
        成本实验室 · 按环节换模型的降本对比
      </h1>
      <p style={{ fontSize: 13, color: '#555', margin: '0 0 10px', maxWidth: 980, lineHeight: 1.7 }}>
        生产管线(rows-hd)拆成三个模型环节:<b>① 行检测</b>(1 次小图调用,找货架层) →{' '}
        <b>② 条带框选</b>(逐条带高清检测,全推理,「一组相同商品一个框」的语义来自这里) →{' '}
        <b>③ 网格读名</b>(6 格拼图读商品名,无推理) → ④ 去重出清单(纯代码,免费)。
        下面每个方案把部分环节换到便宜模型上,与全程 gemini-3.6-flash 基准比最终输出。
        成本口径:廉价环节为 OpenRouter <b>实际计费</b>;3.6-flash 环节在服务器上走生产同款
        Vertex 通道,按官方价目估算(与 OpenRouter 转售价一致)。判定标准=与「基准自己重跑一次」
        的差异(噪声底线)相当,即 ≈ 同效。
      </p>

      {err && (
        <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 8, padding: 12, fontSize: 13 }}>
          {err}
        </div>
      )}

      {index && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {index.photos.map((p) => (
            <button
              key={p.photo}
              onClick={() => setPhotoKey(p.photo)}
              style={{
                border: '1px solid ' + (photoKey === p.photo ? '#111' : '#e4e4e7'),
                background: photoKey === p.photo ? '#111' : '#fff',
                color: photoKey === p.photo ? '#fff' : '#52525b',
                padding: '5px 14px',
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {PHOTO_LABEL[p.photo] ?? p.photo}
            </button>
          ))}
        </div>
      )}

      {/* 汇总表 */}
      {photo && baseline && (
        <div style={{ overflowX: 'auto', marginBottom: 8 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 900 }}>
            <thead>
              <tr>
                {[
                  '方案',
                  '① 行检测',
                  '② 条带框选',
                  '③ 网格读名',
                  '商品数',
                  '实测成本/张',
                  'vs 基准',
                  '每千张',
                  '框覆盖',
                  '名称一致',
                  '判定',
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: '6px 10px',
                      borderBottom: '2px solid #e4e4e7',
                      color: '#71717a',
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordered.map((s) => {
                const key = s.runTag === 'alt' ? `${s.schemeId}-alt` : s.schemeId;
                const meta = SCHEME_META[key] ?? {
                  titleZh: s.schemeId,
                  sub: '',
                  color: '#52525b',
                };
                const v = verdictOf(s.metrics, floor);
                const saving =
                  baseline.totalCostUsd > 0 ? 1 - s.totalCostUsd / baseline.totalCostUsd : 0;
                return (
                  <tr key={key}>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700, color: meta.color, whiteSpace: 'nowrap' }}>
                      {meta.titleZh}
                    </td>
                    {(['rows', 'detect', 'readout'] as StageName[]).map((st) => (
                      <td key={st} style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {shortModel(s.models[st])}
                      </td>
                    ))}
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700 }}>
                      {s.count}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fmtUsd(s.totalCostUsd)}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', color: saving > 0.01 ? '#047857' : '#71717a', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {saving > 0.01 ? `-${(saving * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', whiteSpace: 'nowrap' }}>
                      ${(s.totalCostUsd * 1000).toFixed(0)}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                      {s.metrics ? pct(s.metrics.boxRecall) : '—'}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                      {s.metrics ? pct(s.metrics.nameAgreement) : '—'}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                      <span style={{ background: v.bg, color: v.fg, borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {v.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {/* 推算行:batch 半价(同权重,输出与基准一致,需接异步 Batch API) */}
              <tr>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700, color: '#0891b2', whiteSpace: 'nowrap' }}>
                  基准 + :batch 半价 <span style={{ fontWeight: 400, fontSize: 10, color: '#71717a' }}>(推算)</span>
                </td>
                <td colSpan={3} style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontSize: 11, color: '#52525b' }}>
                  同 3.6-flash 权重走 Batch API(输出分布与基准相同;延迟分钟~小时级,适合录入队列)
                </td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>{baseline.count}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {fmtUsd(baseline.totalCostUsd / 2)}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', color: '#047857', fontWeight: 600 }}>-50%</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                  ${((baseline.totalCostUsd / 2) * 1000).toFixed(0)}
                </td>
                <td colSpan={2} style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', color: '#71717a', fontSize: 11 }}>
                  与基准同分布(未实测)
                </td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                  <span style={{ background: '#cffafe', color: '#0e7490', borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>
                    定义同效
                  </span>
                </td>
              </tr>
              {(() => {
                const lr = ordered.find((s) => s.schemeId === 'lite-readout2');
                if (!lr) return null;
                const cost =
                  lr.perStage.rows.costUsd + lr.perStage.detect.costUsd / 2 + lr.perStage.readout.costUsd;
                const v = verdictOf(lr.metrics, floor);
                return (
                  <tr>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700, color: '#0891b2', whiteSpace: 'nowrap' }}>
                      混合 + 框选:batch <span style={{ fontWeight: 400, fontSize: 10, color: '#71717a' }}>(推算)</span>
                    </td>
                    <td colSpan={3} style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontSize: 11, color: '#52525b' }}>
                      「混合」方案的框选环节改走 Batch API 半价,读名/行检测已是 lite
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>{lr.count}</td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fmtUsd(cost)}
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', color: '#047857', fontWeight: 600 }}>
                      -{((1 - cost / baseline.totalCostUsd) * 100).toFixed(0)}%
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                      ${(cost * 1000).toFixed(0)}
                    </td>
                    <td colSpan={2} style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5', color: '#71717a', fontSize: 11 }}>
                      质量同「混合」方案实测
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid #f4f4f5' }}>
                      <span style={{ background: v.bg, color: v.fg, borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>
                        {v.label}
                      </span>
                    </td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}

      {photo && FAILED_SCHEMES.length > 0 && (
        <div style={{ margin: '0 0 12px', maxWidth: 980 }}>
          {FAILED_SCHEMES.map((f) => (
            <div
              key={f.titleZh}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
                fontSize: 11.5,
                color: '#52525b',
                lineHeight: 1.6,
              }}
            >
              <span style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '1px 8px', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                未跑通
              </span>
              <span>
                <b>{f.titleZh}</b>{' '}
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 10.5 }}>({f.models})</span>{' '}
                — {f.reason}
              </span>
            </div>
          ))}
        </div>
      )}

      {floor && (
        <p style={{ fontSize: 11.5, color: '#71717a', margin: '0 0 18px', maxWidth: 980, lineHeight: 1.6 }}>
          噪声底线(基准重跑 vs 基准):框覆盖 {pct(floor.boxRecall)} · 名称一致{' '}
          {pct(floor.nameAgreement)} · 清单 Jaccard {pct(floor.entryJaccard)}。3.6-flash
          自身带思考采样,两次运行也到不了 100% — 方案指标落在这个区间内即视为「同效」。
          判定阈值:框覆盖/名称一致 ≥ 底线-3pt 且 Jaccard ≥ 底线-5pt。
        </p>
      )}

      {/* 方案卡片 */}
      {photo && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
            gap: 14,
          }}
        >
          {ordered.map((s) => {
            const key = s.runTag === 'alt' ? `${s.schemeId}-alt` : s.schemeId;
            const meta = SCHEME_META[key] ?? { titleZh: s.schemeId, sub: '', color: '#52525b' };
            return (
              <SchemeCard
                key={key}
                scheme={s}
                meta={meta}
                preview={photo.preview}
                floor={floor}
                baselineCost={baseline?.totalCostUsd ?? null}
                artifact={artifacts[s.file] ?? null}
              />
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 26, fontSize: 12, color: '#71717a', maxWidth: 980, lineHeight: 1.8 }}>
        <b>方法说明</b> · 所有方案共用同一套生产代码路径(prompts/切带/网格拼图/解析/去重逐字节一致),只换各环节背后的模型;
        输入图片切片完全相同,差异只来自模型本身。
        匹配算法:两组框做 IoU≥0.45 贪心匹配 → 匹配对上做模糊名称比对(小写、去音调、分词 Jaccard≥0.34 或包含关系);
        清单层面同法算 Jaccard。
        「开源」方案使用开放权重模型(Qwen3-VL 系列,Apache 2.0):现在按 OpenRouter 托管价计费,
        将来量大可自托管到自有 GPU,把边际成本压到纯算力。
        实测发现 Qwen 系在框选环节惯用 [xmin,ymin,xmax,ymax] 顺序(无视提示词的 y-first 约定,
        首轮全开源方案的框整体转置成横条),加一层纯代码坐标适配后恢复正常 — 换开源模型时这层适配必不可少。
        评估过的本地开源检测器(YOLO-SKU110K / Grounding DINO):只能框「单个商品」,
        无法复现「一组相同商品一个框」的分组语义,与基准输出结构不兼容,故未纳入;
        开源 OCR(PaddleOCR)无法为不可读标签生成兜底描述,亦不满足「同效」要求。
        :batch 半价档是同一模型权重的异步批量接口(OpenRouter /api/beta/batches 或 Google 官方 Batch API),
        输出分布与基准一致,本轮未实测接入,表中为推算行。
      </div>
    </div>
  );
}

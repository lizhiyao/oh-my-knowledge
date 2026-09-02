/**
 * 多采样共识合并 —— self-consistency 抹平单次采样方差。
 *
 * composer 串行跑 N 次 LLM,各次产出独立的 HealthParseResult。本模块把这 N 份
 * 结果**按维度取并集**:同根因 finding 跨采样合并成一条,标注支持度 `k/n`
 * (该维度被评估的 n 次里,有 k 次报了这条)。**默认不过滤** —— 召回优先,
 * 低支持度的也保留并如实标注,让重复体检看到的是"并集",而不是每次抖动的子集。
 *
 * 两种归并实现,共用 assembleDimResult 出维度结果:
 *   - mergeHealthSamples(string,默认):按 findingKey(反引号锚点 / 归一化描述前缀)
 *     聚类。便宜、无额外 LLM 调用;缺点是同根因不同措辞可能漏并(拆成多条低支持度)。
 *   - mergeHealthSamplesLlm(option C):用一次 LLM 聚类(skill-health-merge prompt)的
 *     结果分组,跨措辞归并最准;composer 在 healthMerge='llm' 时调用,失败回退 string。
 */

import type {
  HealthDimensionLevel,
  HealthDimensionResult,
  HealthDimensionSpec,
  HealthFinding,
  HealthFindingLevel,
} from './dimension-spec.js';
import type { HealthParseResult } from './parser.js';
import { deriveOverallHealth } from './parser.js';

const FINDING_SEVERITY: Record<HealthFindingLevel, number> = { 错误: 3, 警告: 2, 建议: 1 };

function isFindingLevel(s: unknown): s is HealthFindingLevel {
  return s === '错误' || s === '警告' || s === '建议';
}

function deriveDimLevel(findings: HealthFinding[]): HealthDimensionLevel {
  if (findings.some((f) => f.level === '错误')) return '不健康';
  if (findings.length > 0) return '亚健康';
  return '健康';
}

/**
 * 同根因合并键。锚点优先(跨采样最稳),退回归一化描述前缀。
 * 不含 level:同一问题不同采样 level 可能不同,合并时单独取最严重。
 */
export function findingKey(f: HealthFinding): string {
  const text = `${f.description ?? ''} ${f.suggestion ?? ''}`;
  const anchors = [...text.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (anchors.length > 0) {
    return `a:${[...new Set(anchors)].sort().join(',')}`;
  }
  // 去掉空白 / 标点 / 符号后取前缀(中文字符保留)
  const norm = (f.description ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return `d:${norm.slice(0, 48)}`;
}

// ---------------------------------------------------------------------------
// 维度结果组装(string / llm 两条路共用)
// ---------------------------------------------------------------------------

/** 一组同根因 finding(跨采样)。sampleIdxs 用于算 support.k(去重的采样下标)。 */
interface FindingGroup {
  members: HealthFinding[];
  sampleIdxs: Set<number>;
  /** LLM 归并给出的合并后文案 / level;string 归并不设。 */
  override?: { description?: string; suggestion?: string; level?: HealthFindingLevel };
}

/** 由分组好的 FindingGroup 组装一个维度结果(support、排序、维度 level 派生)。 */
function assembleDimResult(
  presentLevels: HealthDimensionLevel[],
  n: number,
  groups: FindingGroup[],
  suggestions: string[],
): HealthDimensionResult {
  const findings: HealthFinding[] = groups.map((g) => {
    // representative 取描述更详尽的一条;level 取组内最严重(除非 LLM 显式给了)。
    const rep = [...g.members].sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))[0];
    const worst = g.members.reduce<HealthFindingLevel>(
      (acc, f) => (FINDING_SEVERITY[f.level] > FINDING_SEVERITY[acc] ? f.level : acc),
      '建议',
    );
    return {
      ...rep,
      // override.level 只能"升"不能"降":worst(组内最严重)是下限,LLM 聚类觉得更严重才采纳。
      // 否则一次归并能把真 错误 降成 警告(维度 不健康→亚健康),把真问题藏掉。
      level: g.override?.level && FINDING_SEVERITY[g.override.level] > FINDING_SEVERITY[worst]
        ? g.override.level
        : worst,
      description: g.override?.description ?? rep.description,
      suggestion: g.override?.suggestion ?? rep.suggestion,
      support: { k: g.sampleIdxs.size, n },
    };
  });
  // 排序:支持度高在前,其次错误优先 —— 最可信、最严重的排最前。
  findings.sort((x, y) => {
    const sk = (y.support?.k ?? 0) - (x.support?.k ?? 0);
    if (sk !== 0) return sk;
    return FINDING_SEVERITY[y.level] - FINDING_SEVERITY[x.level];
  });
  // 零 finding 时:只有所有采样都判不适用才算不适用(任一判健康 = 适用且健康)。
  const level: HealthDimensionLevel = findings.length > 0
    ? deriveDimLevel(findings)
    : presentLevels.every((l) => l === '不适用') ? '不适用' : '健康';
  return { level, findings, suggestions };
}

/** 该维度被"实际评估"过的采样(present 且非 _missing;健康=0 finding 也算评估过)。 */
function presentSamplesFor(samples: HealthParseResult[], dimId: string): Array<{ idx: number; r: HealthDimensionResult }> {
  const out: Array<{ idx: number; r: HealthDimensionResult }> = [];
  samples.forEach((s, idx) => {
    const r = s.byDimId.get(dimId);
    if (r != null && !r._missing) out.push({ idx, r });
  });
  return out;
}

function finalize(byDimId: Map<string, HealthDimensionResult>, samples: HealthParseResult[]): HealthParseResult {
  const topSet = new Set<string>();
  for (const s of samples) for (const t of s.topSuggestions) topSet.add(t);
  const featurePoints = samples.find((s) => s.featurePoints.length > 0)?.featurePoints ?? [];
  return { byDimId, overall: deriveOverallHealth(byDimId), topSuggestions: [...topSet], featurePoints };
}

// ---------------------------------------------------------------------------
// string 归并(默认,findingKey 聚类)
// ---------------------------------------------------------------------------

export function mergeHealthSamples(
  samples: HealthParseResult[],
  dims: HealthDimensionSpec[],
): HealthParseResult {
  const byDimId = new Map<string, HealthDimensionResult>();
  for (const dim of dims) {
    const present = presentSamplesFor(samples, dim.id);
    if (present.length === 0) {
      byDimId.set(dim.id, { level: '不适用', findings: [], suggestions: [], _missing: true });
      continue;
    }
    const suggestionsSet = new Set<string>();
    const groupMap = new Map<string, FindingGroup>();
    for (const { idx, r } of present) {
      for (const sug of r.suggestions) suggestionsSet.add(sug);
      for (const f of r.findings) {
        const key = findingKey(f);
        let g = groupMap.get(key);
        if (!g) { g = { members: [], sampleIdxs: new Set() }; groupMap.set(key, g); }
        g.members.push(f);
        g.sampleIdxs.add(idx);
      }
    }
    // n(支持度分母)= 已评估且适用的采样数;不适用采样不算"评估过这条 finding"。
    const assessedN = present.filter((p) => p.r.level !== '不适用').length;
    byDimId.set(dim.id, assembleDimResult(
      present.map((p) => p.r.level), assessedN, [...groupMap.values()], [...suggestionsSet],
    ));
  }
  return finalize(byDimId, samples);
}

// ---------------------------------------------------------------------------
// LLM 归并(option C,跨措辞同根因聚类)
// ---------------------------------------------------------------------------

/** 带稳定 id 的采样 finding(喂给 merge prompt + 回填分组)。 */
export interface TaggedFinding {
  id: string;
  sampleIdx: number;
  dimId: string;
  finding: HealthFinding;
}

/** 枚举所有采样里所有维度的 finding,赋稳定 id(f0, f1, …),供 LLM 聚类引用。 */
export function enumerateFindingsForMerge(
  samples: HealthParseResult[],
  dims: HealthDimensionSpec[],
): TaggedFinding[] {
  const out: TaggedFinding[] = [];
  let counter = 0;
  samples.forEach((s, sampleIdx) => {
    for (const dim of dims) {
      const r = s.byDimId.get(dim.id);
      if (!r || r._missing) continue;
      for (const f of r.findings) {
        out.push({ id: `f${counter}`, sampleIdx, dimId: dim.id, finding: f });
        counter += 1;
      }
    }
  });
  return out;
}

/** merge LLM 输出的一个聚类。 */
export interface MergeCluster {
  dimId: string;
  findingIds: string[];
  level?: HealthFindingLevel;
  description?: string;
  suggestion?: string;
}

/** 解析 merge LLM 的 clusters JSON(已 extractJson)。非法返回 null → composer 回退 string。 */
export function parseMergeClusters(jsonText: string): MergeCluster[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed as Record<string, unknown>).clusters;
  if (!Array.isArray(raw)) return null;
  const out: MergeCluster[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.dim_id !== 'string') continue;
    if (!Array.isArray(c.finding_ids)) continue;
    const ids = c.finding_ids.filter((x): x is string => typeof x === 'string');
    if (ids.length === 0) continue;
    out.push({
      dimId: c.dim_id,
      findingIds: ids,
      level: isFindingLevel(c.level) ? c.level : undefined,
      description: typeof c.description === 'string' && c.description.trim() ? c.description : undefined,
      suggestion: typeof c.suggestion === 'string' && c.suggestion.trim() ? c.suggestion : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

/** 按 LLM 聚类结果合并。未被任何 cluster 覆盖的 finding 兜底自成一组(绝不丢)。 */
export function mergeHealthSamplesLlm(
  samples: HealthParseResult[],
  dims: HealthDimensionSpec[],
  tagged: TaggedFinding[],
  clusters: MergeCluster[],
): HealthParseResult {
  const byId = new Map(tagged.map((t) => [t.id, t]));
  const covered = new Set<string>();
  const groupsByDim = new Map<string, FindingGroup[]>();
  const addGroup = (dimId: string, g: FindingGroup): void => {
    if (!groupsByDim.has(dimId)) groupsByDim.set(dimId, []);
    groupsByDim.get(dimId)!.push(g);
  };

  for (const c of clusters) {
    const members = c.findingIds
      .map((id) => byId.get(id))
      .filter((t): t is TaggedFinding => t != null && t.dimId === c.dimId && !covered.has(t.id));
    if (members.length === 0) continue;
    for (const m of members) covered.add(m.id);
    addGroup(c.dimId, {
      members: members.map((m) => m.finding),
      sampleIdxs: new Set(members.map((m) => m.sampleIdx)),
      override: { description: c.description, suggestion: c.suggestion, level: c.level },
    });
  }
  // 兜底:LLM 漏分配的 finding 自成一组,绝不丢。
  for (const t of tagged) {
    if (covered.has(t.id)) continue;
    covered.add(t.id);
    addGroup(t.dimId, { members: [t.finding], sampleIdxs: new Set([t.sampleIdx]) });
  }

  const byDimId = new Map<string, HealthDimensionResult>();
  for (const dim of dims) {
    const present = presentSamplesFor(samples, dim.id);
    if (present.length === 0) {
      byDimId.set(dim.id, { level: '不适用', findings: [], suggestions: [], _missing: true });
      continue;
    }
    const suggestionsSet = new Set<string>();
    for (const { r } of present) for (const sug of r.suggestions) suggestionsSet.add(sug);
    const assessedN = present.filter((p) => p.r.level !== '不适用').length;
    byDimId.set(dim.id, assembleDimResult(
      present.map((p) => p.r.level), assessedN, groupsByDim.get(dim.id) ?? [], [...suggestionsSet],
    ));
  }
  return finalize(byDimId, samples);
}

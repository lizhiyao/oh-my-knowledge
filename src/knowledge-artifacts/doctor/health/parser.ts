/**
 * LLM 输出解析:JSON 提取 + dim_id 派发 + 容错。
 *
 * 流程:
 *   1. extractJson 从 LLM 文本(可能带寒暄/code fence)抽出顶层 JSON。
 *   2. 按 dim_id 把 checklist 项派发到 Map<dimId, HealthDimensionResult>。
 *   3. 缺失维度(LLM 漏报)塞 _missing=true 的 placeholder,composer 据此 status=skipped。
 *   4. 不合法 dim_id(LLM 编了 registry 之外的)直接丢弃。
 *
 * dimension_level_count / finding_count_by_level 由调用方 / renderer 自己算
 * (LLM 算术不可靠,prompt 已声明不输出这两字段)。
 */

import type {
  HealthDimensionResult,
  HealthDimensionSpec,
  HealthFinding,
  HealthFindingLevel,
  HealthDimensionLevel,
} from './dimension-spec.js';

const REQUIRED_TOP_KEYS = new Set(['skill_name', 'checklist', 'summary']);

interface ExtractedCandidate {
  text: string;
  obj: Record<string, unknown>;
}

/** 深度跟踪 brace,在 LLM 文本里找出顶层 JSON。多个候选时优先选含 ≥2 required key 的。 */
function repairUnescapedQuotes(json: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (escape) { escape = false; result += c; continue; }
    if (c === '\\') { escape = true; result += c; continue; }
    if (c === '"') {
      if (!inString) { inString = true; result += c; continue; }
      const after = json.slice(i + 1).trimStart();
      if (!after.length || after[0] === ',' || after[0] === '}' || after[0] === ']' || after[0] === ':') {
        inString = false;
        result += c;
      } else {
        result += '\\"';
      }
      continue;
    }
    result += c;
  }
  return result;
}

export function extractJson(text: string): string | null {
  if (!text) return null;
  text = repairUnescapedQuotes(text);
  const candidates: ExtractedCandidate[] = [];
  let pos = 0;
  while (true) {
    const start = text.indexOf('{', pos);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    const cand = text.slice(start, end + 1);
    try {
      const obj: unknown = JSON.parse(cand);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        candidates.push({ text: cand, obj: obj as Record<string, unknown> });
      }
    } catch {
      // skip non-parseable; brace inside string is the common reason
    }
    pos = start + 1;
  }
  if (candidates.length === 0) return null;
  const strong = candidates.filter((c) => {
    let hits = 0;
    for (const k of REQUIRED_TOP_KEYS) if (k in c.obj) hits += 1;
    return hits >= 2;
  });
  if (strong.length > 0) {
    strong.sort((a, b) => b.text.length - a.text.length);
    return strong[0].text;
  }
  const keyed = candidates.filter((c) => 'skill_name' in c.obj);
  const pool = keyed.length > 0 ? keyed : candidates;
  pool.sort((a, b) => b.text.length - a.text.length);
  return pool[0].text;
}

// ---------------------------------------------------------------------------
// Type guards & dispatch
// ---------------------------------------------------------------------------

function isDimLevel(s: unknown): s is HealthDimensionLevel {
  return s === '健康' || s === '亚健康' || s === '不健康' || s === '不适用';
}

function isFindingLevel(s: unknown): s is HealthFindingLevel {
  return s === '错误' || s === '警告' || s === '建议';
}

function asFinding(raw: unknown): HealthFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isFindingLevel(r.level)) return null;
  return {
    level: r.level,
    subtype: typeof r.subtype === 'string' ? r.subtype : '',
    evidence: typeof r.evidence === 'string' ? r.evidence : '',
    description: typeof r.description === 'string' ? r.description : '',
    suggestion: typeof r.suggestion === 'string' ? r.suggestion : undefined,
  };
}

export interface HealthParseResult {
  byDimId: Map<string, HealthDimensionResult>;
  /** LLM 给的 overall(框架视情况覆盖)。 */
  overall: '良好' | '部分缺陷' | '严重缺陷' | null;
  topSuggestions: string[];
  /** 原样保留 feature_points,塞进 composer 主结果 detail。 */
  featurePoints: unknown[];
}

/** 从 cleaned JSON 字串(extractJson 的输出)派发到各维度。 */
export function parseHealthOutput(
  jsonText: string,
  dims: HealthDimensionSpec[],
): HealthParseResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const validIds = new Set(dims.map((d) => d.id));
  const byDimId = new Map<string, HealthDimensionResult>();

  const checklist = Array.isArray(parsed.checklist) ? parsed.checklist : [];
  for (const itemRaw of checklist) {
    if (!itemRaw || typeof itemRaw !== 'object') continue;
    const item = itemRaw as Record<string, unknown>;
    const dimId = item.dim_id;
    if (typeof dimId !== 'string' || !validIds.has(dimId)) continue; // 容错:丢弃未注册 id
    if (byDimId.has(dimId)) continue;                                  // 容错:重复 id 取首条
    const findingsRaw = Array.isArray(item.findings) ? item.findings : [];
    const findings: HealthFinding[] = [];
    for (const fRaw of findingsRaw) {
      const f = asFinding(fRaw);
      if (f) findings.push(f);
    }
    const suggestions = Array.isArray(item.suggestions)
      ? (item.suggestions as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const level: HealthDimensionLevel = isDimLevel(item.level)
      ? item.level
      : deriveDimLevel(findings);
    byDimId.set(dimId, { level, findings, suggestions });
  }

  // 漏报维度填 placeholder
  for (const dim of dims) {
    if (!byDimId.has(dim.id)) {
      byDimId.set(dim.id, { level: '不适用', findings: [], suggestions: [], _missing: true });
    }
  }

  const summaryRaw = (parsed.summary && typeof parsed.summary === 'object'
    ? parsed.summary
    : {}) as Record<string, unknown>;
  const validOveralls = new Set(['良好', '部分缺陷', '严重缺陷'] as const);
  const overallRaw = summaryRaw.overall_health;
  const overall = typeof overallRaw === 'string' && validOveralls.has(overallRaw as never)
    ? (overallRaw as '良好' | '部分缺陷' | '严重缺陷')
    : null;
  const topSuggestions = Array.isArray(summaryRaw.top_suggestions)
    ? (summaryRaw.top_suggestions as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  const featurePoints = Array.isArray(parsed.feature_points) ? parsed.feature_points : [];

  return { byDimId, overall, topSuggestions, featurePoints };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function deriveDimLevel(findings: HealthFinding[]): HealthDimensionLevel {
  if (findings.some((f) => f.level === '错误')) return '不健康';
  if (findings.length > 0) return '亚健康';
  return '健康';
}

export function deriveOverallHealth(byDimId: Map<string, HealthDimensionResult>): '良好' | '部分缺陷' | '严重缺陷' {
  let hasUnhealthy = false;
  let hasSubhealthy = false;
  for (const r of byDimId.values()) {
    if (r._missing) continue; // 漏报不算
    if (r.level === '不健康') hasUnhealthy = true;
    else if (r.level === '亚健康') hasSubhealthy = true;
  }
  if (hasUnhealthy) return '严重缺陷';
  if (hasSubhealthy) return '部分缺陷';
  return '良好';
}

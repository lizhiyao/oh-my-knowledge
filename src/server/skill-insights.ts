/**
 * Insight detection — 把 4 类报告(doctor / eval-评分 / eval-功能 / observe)合并成
 * 一组结构化"问题",每个 Insight 自带多 perspective 的证据 + 改进建议。
 *
 * 设计原则:
 *   - 问题是一等公民,perspective 退化为证据来源
 *   - 显式记录"盲区"(blind):某 perspective 本应该看到这问题但没看到 → 改进信号
 *   - 多 perspective 共同证实(三角)的 insight 比单点信号更高 severity
 *
 * 6 类 detection:
 *   1. dependency-doc-issue:doctor 前置依赖 ⚠ + eval skill_doc_missing/unclear sample
 *   2. doctor-blindspot:eval 多个 sample 同 rootCause 但 doctor 没卡 → 应加 rule
 *   3. failure-mode-cluster:eval 多 sample 共享 failureMode(工作流跳步等)
 *   4. coverage-gap:observe.uncovered ∩ eval.coverage.uncovered
 *   5. production-instability:observe toolFailureRate >= 0.4
 *   6. skill-too-long:doctor skill_readable ⚠(skill 过长)
 *
 * detection 函数纯函数(无 I/O),好测。
 */
import type { EvaluationReport, VariantResult } from '../types/index.js';
import type { SkillIndexEntry, SkillDoctorSnapshot, SkillObserveSnapshot, SkillEvalSnapshot } from './skill-index.js';

export type InsightCategory =
  | 'dependency-doc-issue'
  | 'doctor-blindspot'
  | 'failure-mode-cluster'
  | 'coverage-gap'
  | 'production-instability'
  | 'skill-too-long'
  | 'other';

export type InsightSeverity = 'high' | 'medium' | 'low';

export type InsightPerspective = 'doctor' | 'eval-score' | 'eval-functional' | 'observe';

/** 单条证据。status 区分本 perspective 是"看到了"还是"应该看到但没看到"还是"看了不报"。 */
export interface InsightEvidence {
  perspective: InsightPerspective;
  /** flagged = 这个 perspective 报告了该问题(主要证据)
   *  blind   = 该 perspective 应该卡但没卡(盲区,改进信号)
   *  silent  = 该 perspective 检查过但无信号(否定证据,加深 / 减轻判断)
   *  na      = 该 perspective 未运行,无法判断 */
  status: 'flagged' | 'blind' | 'silent' | 'na';
  /** 简短说明,用户在 UI 一眼能看懂。 */
  message: string;
  /** 可选:跳到具体证据的锚点(如 sample id / rule id)。 */
  ref?: string;
}

export interface InsightRecommendation {
  action: string;
  priority: InsightSeverity;
}

export interface Insight {
  id: string;
  category: InsightCategory;
  title: string;
  severity: InsightSeverity;
  /** 影响样本数 / 段数 / 文件数(取决于 category)。 */
  affectedCount: number;
  evidence: InsightEvidence[];
  recommendations: InsightRecommendation[];
}

// ────────── helpers ──────────

interface FailedSample {
  sampleId: string;
  rootCause: string[];
  failureModes: string[];
  diagnosticSummary: string;
}

function getVariantName(report: EvaluationReport): string | null {
  return report.meta.variants?.find((v) => v !== 'baseline') ?? null;
}

function getFailedSamples(report: EvaluationReport, variant: string): FailedSample[] {
  const out: FailedSample[] = [];
  for (const r of report.results) {
    const v: VariantResult | undefined = r.variants?.[variant];
    if (!v) continue;
    const passed = (v.assertions?.details ?? []).every((d) => d.passed);
    if (passed) continue;
    const isTripwire = (v.diagnostic?.rootCause || []).includes('tripwire_intentional')
      || report.sampleSnapshots?.[r.sample_id]?.tripwire === true;
    if (isTripwire) continue;
    out.push({
      sampleId: r.sample_id,
      rootCause: (v.diagnostic?.rootCause ?? []) as string[],
      failureModes: (v.diagnostic?.failureModes ?? []) as string[],
      diagnosticSummary: v.diagnostic?.summary ?? '',
    });
  }
  return out;
}

function severityOfCount(n: number): InsightSeverity {
  if (n >= 3) return 'high';
  if (n >= 2) return 'medium';
  return 'low';
}

// ────────── 6 类 detection ──────────

function detectDependencyDocIssue(
  doctor: SkillDoctorSnapshot | null,
  evalReport: EvaluationReport | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  const depRule = doctor?.results.find((r) => r.ruleId === 'dependencies_present'
    && (r.status === 'warn' || r.status === 'fail'));
  if (!evalReport) {
    if (!depRule) return null;
    return {
      id: 'dep-doc-issue',
      category: 'dependency-doc-issue',
      title: 'skill 前置依赖未在 sample environment 中声明',
      severity: 'medium',
      affectedCount: 0,
      evidence: [
        { perspective: 'doctor', status: 'flagged', message: depRule.message },
        { perspective: 'eval-functional', status: 'na', message: '无 eval 报告,无法对照' },
        { perspective: 'observe', status: observe ? 'silent' : 'na', message: observe ? '生产未踩到' : '无 observe 报告' },
      ],
      recommendations: [
        { action: '在 sample.environment.files_available 加上 doctor 标的文件路径', priority: 'medium' },
      ],
    };
  }

  const variant = getVariantName(evalReport);
  if (!variant) return null;
  const failed = getFailedSamples(evalReport, variant);
  const failedWithDocIssue = failed.filter((f) =>
    f.rootCause.includes('skill_doc_missing') || f.rootCause.includes('skill_doc_unclear'),
  );

  if (!depRule && failedWithDocIssue.length === 0) return null;

  const affectedCount = failedWithDocIssue.length;
  const evidence: InsightEvidence[] = [];
  evidence.push(depRule
    ? { perspective: 'doctor', status: 'flagged', message: depRule.message, ref: depRule.ruleId }
    : { perspective: 'doctor', status: 'blind',
        message: `eval 失败 sample 标 skill_doc_missing/unclear,但 doctor 没警告 — 应加 rule 或调严现有 dependencies_present` });
  evidence.push(failedWithDocIssue.length > 0
    ? {
        perspective: 'eval-functional', status: 'flagged',
        message: `${affectedCount} 条失败 sample (${failedWithDocIssue.map((f) => f.sampleId).join(', ')}) rootCause = skill_doc_missing/unclear`,
        ref: failedWithDocIssue[0].sampleId,
      }
    : { perspective: 'eval-functional', status: 'silent', message: '本批 eval 没有命中 skill_doc 类失败' });
  evidence.push(observe
    ? observe.gapRate >= 0.2
      ? { perspective: 'observe', status: 'flagged',
          message: `生产里也有 ${(observe.gapRate * 100).toFixed(0)}% 段命中知识库 gap` }
      : { perspective: 'observe', status: 'silent', message: '生产里 gap 率不高,可能此问题在真实使用中较少触发' }
    : { perspective: 'observe', status: 'na', message: '无 observe 报告' });

  let severity = severityOfCount(affectedCount);
  if (depRule && affectedCount >= 1) severity = severityOfCount(affectedCount + 1);  // 双重证实加权
  if (depRule && affectedCount === 0) severity = 'low';

  const recs: InsightRecommendation[] = [];
  if (depRule) {
    recs.push({ action: 'sample.environment.files_available 加上 doctor 标的路径', priority: severity });
  }
  if (affectedCount >= 1) {
    recs.push({ action: 'skill 文档对应章节加显眼提示,确保 LLM 不漏读前置依赖', priority: severity });
  }

  return {
    id: 'dep-doc-issue',
    category: 'dependency-doc-issue',
    title: affectedCount > 0
      ? `skill 前置依赖未声明导致 ${affectedCount} 条 sample 失败`
      : 'skill 前置依赖未在 sample environment 中声明',
    severity,
    affectedCount,
    evidence,
    recommendations: recs,
  };
}

function detectDoctorBlindspot(
  doctor: SkillDoctorSnapshot | null,
  evalReport: EvaluationReport | null,
): Insight | null {
  if (!evalReport) return null;
  const variant = getVariantName(evalReport);
  if (!variant) return null;
  const failed = getFailedSamples(evalReport, variant);

  // 排除已被 detectDependencyDocIssue 覆盖的(skill_doc_missing/unclear)
  const candidates = failed.filter((f) => {
    const hasDocIssue = f.rootCause.includes('skill_doc_missing') || f.rootCause.includes('skill_doc_unclear');
    if (hasDocIssue) return false;
    return f.failureModes.includes('硬编码值')
      || f.failureModes.includes('幻觉输出')
      || f.failureModes.includes('误读约束');
  });
  if (candidates.length < 2) return null;

  // 看 doctor 是否对应 rule 卡了 — 如果没,确实是盲区
  const doctorWarnedAny = doctor?.results.some((r) => r.status === 'warn' || r.status === 'fail');
  // 即使 doctor 警告了别的事,只要这些 failureMode 类没对应规则也算盲区(omk 当前没有"硬编码 / 幻觉"专项 rule)
  const hasHardcoded = candidates.some((c) => c.failureModes.includes('硬编码值'));
  const hasHallucination = candidates.some((c) => c.failureModes.includes('幻觉输出'));

  const evidence: InsightEvidence[] = [
    {
      perspective: 'eval-functional', status: 'flagged',
      message: `${candidates.length} 条失败 sample 共享 failureMode(${[...new Set(candidates.flatMap((c) => c.failureModes))].join('/')}),非诱错`,
      ref: candidates[0].sampleId,
    },
    {
      perspective: 'doctor',
      status: doctor ? 'blind' : 'na',
      message: doctor
        ? `doctor 没规则卡 ${hasHardcoded ? '硬编码值' : ''}${hasHardcoded && hasHallucination ? ' / ' : ''}${hasHallucination ? '幻觉输出' : ''} 类反模式 — 应加 LLM-judge composer rule`
        : '无 doctor 报告对照',
    },
    {
      perspective: 'observe',
      status: 'na',
      message: '产线观测难以验证此类反模式(行为级问题需要 LLM 二次审)',
    },
  ];

  return {
    id: 'doctor-blindspot',
    category: 'doctor-blindspot',
    title: 'doctor 盲区:eval 抓到的反模式 doctor 没卡',
    severity: candidates.length >= 3 ? 'high' : 'medium',
    affectedCount: candidates.length,
    evidence,
    recommendations: [
      { action: 'doctor 加 composer rule 检测硬编码值 / 幻觉输出 / 误读约束 等行为反模式', priority: 'medium' },
      { action: '逐条复查失败 sample,确认是 skill 写法问题还是 LLM 自身问题', priority: 'high' },
      ...(doctorWarnedAny ? [] : [{ action: '触发一次 omk doctor --static-only 看是否还有静态问题', priority: 'low' as InsightSeverity }]),
    ],
  };
}

function detectFailureModeCluster(evalReport: EvaluationReport | null): Insight | null {
  if (!evalReport) return null;
  const variant = getVariantName(evalReport);
  if (!variant) return null;
  const failed = getFailedSamples(evalReport, variant);
  if (failed.length === 0) return null;

  const modeCounts: Record<string, FailedSample[]> = {};
  for (const f of failed) {
    for (const m of f.failureModes) {
      if (!modeCounts[m]) modeCounts[m] = [];
      modeCounts[m].push(f);
    }
  }
  const top = Object.entries(modeCounts).filter(([, fs]) => fs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  if (top.length === 0) return null;

  const [topMode, topSamples] = top[0];
  return {
    id: `failure-mode:${topMode}`,
    category: 'failure-mode-cluster',
    title: `${topMode} 模式在 ${topSamples.length} 条 sample 重复出现`,
    severity: severityOfCount(topSamples.length),
    affectedCount: topSamples.length,
    evidence: [
      {
        perspective: 'eval-functional', status: 'flagged',
        message: `sample ${topSamples.map((s) => s.sampleId).join(', ')} 都报 ${topMode}`,
        ref: topSamples[0].sampleId,
      },
      {
        perspective: 'doctor', status: 'blind',
        message: '同一 failureMode 在 ≥2 条 sample 反复 — skill 文档大概率有共同薄弱点',
      },
    ],
    recommendations: [
      { action: `定位 skill 中跟「${topMode}」相关的章节,集中修一段`, priority: severityOfCount(topSamples.length) },
      { action: '考虑加针对该模式的诱错样本,防止再退化', priority: 'low' },
    ],
  };
}

function detectCoverageGap(
  evalReport: EvaluationReport | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  if (!observe || observe.gapRate === 0) return null;
  // observe.uncoveredFiles 没存在 SkillObserveSnapshot,但 gapRate > 0 已是信号。
  // eval 端 coverage.uncoveredFiles 在 evalReport.analysis.coverage[variant].uncoveredFiles。
  let evalUncovered: string[] = [];
  if (evalReport?.analysis?.coverage) {
    const variant = getVariantName(evalReport);
    if (variant && evalReport.analysis.coverage[variant]) {
      evalUncovered = evalReport.analysis.coverage[variant].uncoveredFiles || [];
    }
  }

  const evidence: InsightEvidence[] = [
    { perspective: 'observe', status: 'flagged',
      message: `生产里 ${(observe.gapRate * 100).toFixed(0)}% 段命中知识库 gap(LLM 找不到该读哪段)` },
  ];
  if (evalUncovered.length > 0) {
    evidence.push({
      perspective: 'eval-functional', status: 'flagged',
      message: `eval 也没覆盖 ${evalUncovered.length} 个文件:${evalUncovered.slice(0, 3).join(', ')}${evalUncovered.length > 3 ? '...' : ''}`,
    });
  } else {
    evidence.push({ perspective: 'eval-functional', status: 'silent', message: 'eval coverage 信号 OK' });
  }

  const severity: InsightSeverity = observe.gapRate >= 0.4 ? 'high'
    : observe.gapRate >= 0.2 ? 'medium' : 'low';

  return {
    id: 'coverage-gap',
    category: 'coverage-gap',
    title: '生产 + 评测都没充分覆盖部分知识库文件',
    severity,
    affectedCount: Math.max(evalUncovered.length, Math.round(observe.segmentCount * observe.gapRate)),
    evidence,
    recommendations: [
      ...(evalUncovered.length > 0
        ? [{ action: `补 sample 覆盖未访问文件:${evalUncovered.slice(0, 2).join(', ')}`, priority: severity as InsightSeverity }]
        : []),
      { action: '检查 skill 是否引用了实际不存在 / 不该引用的文件,删除冗余引用', priority: 'low' as InsightSeverity },
    ],
  };
}

function detectProductionInstability(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  if (!observe || observe.failureRate < 0.4) return null;

  const depRule = doctor?.results.find((r) => r.ruleId === 'dependencies_present'
    && (r.status === 'warn' || r.status === 'fail'));

  return {
    id: 'production-instability',
    category: 'production-instability',
    title: `生产工具失败率 ${(observe.failureRate * 100).toFixed(0)}% — skill 在真实环境跑不稳`,
    severity: 'high',
    affectedCount: Math.round(observe.segmentCount * observe.failureRate),
    evidence: [
      { perspective: 'observe', status: 'flagged',
        message: `${observe.segmentCount} 段产线轨迹中工具失败率 ${(observe.failureRate * 100).toFixed(0)}%` },
      depRule
        ? { perspective: 'doctor', status: 'flagged', message: depRule.message }
        : { perspective: 'doctor', status: doctor ? 'silent' : 'na',
            message: doctor ? 'doctor 没警告依赖,但产线高失败率说明可能存在依赖之外的问题(凭证/网络/SLA)' : '无 doctor 报告对照' },
    ],
    recommendations: [
      { action: '排查 CLI / 凭证 / 网络 / 上游 API SLA', priority: 'high' },
      ...(depRule
        ? [{ action: '依据 doctor 警告补依赖声明', priority: 'high' as InsightSeverity }]
        : [{ action: '考虑给 doctor 加产线失败率联动 rule(依赖 + 高失败率 = red)', priority: 'low' as InsightSeverity }]),
    ],
  };
}

function detectSkillTooLong(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  const readableRule = doctor?.results.find((r) => r.ruleId === 'skill_readable' && r.status === 'warn');
  if (!readableRule) return null;

  const evidence: InsightEvidence[] = [
    { perspective: 'doctor', status: 'flagged', message: readableRule.message, ref: readableRule.ruleId },
  ];
  if (observe && observe.gapRate >= 0.2) {
    evidence.push({
      perspective: 'observe', status: 'flagged',
      message: `产线 gap ${(observe.gapRate * 100).toFixed(0)}% — 过长 skill 让 LLM 找不到段落,跟 doctor 警告印证`,
    });
  }
  return {
    id: 'skill-too-long',
    category: 'skill-too-long',
    title: 'skill 文档过长,LLM 阅读吞吐受影响',
    severity: observe && observe.gapRate >= 0.3 ? 'medium' : 'low',
    affectedCount: 1,
    evidence,
    recommendations: [
      { action: '把示例 / 长段移到 references/ 子文件,SKILL.md 主体保持精简', priority: 'medium' },
      { action: '考虑拆分多个子 skill,各自负责单一职责', priority: 'low' },
    ],
  };
}

// ────────── 入口 ──────────

const SEVERITY_RANK: Record<InsightSeverity, number> = { high: 3, medium: 2, low: 1 };

export function detectInsights(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
): Insight[] {
  const out: Insight[] = [];
  const detectors: Array<() => Insight | null> = [
    () => detectDependencyDocIssue(entry.doctor, evalReport, entry.observe),
    () => detectDoctorBlindspot(entry.doctor, evalReport),
    () => detectFailureModeCluster(evalReport),
    () => detectCoverageGap(evalReport, entry.observe),
    () => detectProductionInstability(entry.doctor, entry.observe),
    () => detectSkillTooLong(entry.doctor, entry.observe),
  ];
  for (const detect of detectors) {
    const ins = detect();
    if (ins) out.push(ins);
  }
  // 按 severity desc + affectedCount desc 排序
  out.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity];
    const sb = SEVERITY_RANK[b.severity];
    if (sa !== sb) return sb - sa;
    return b.affectedCount - a.affectedCount;
  });
  return out;
}

/** 把所有 insight 的 recommendations 拍平 + 去重(同 action 文案合并),按 priority 排。 */
export function flattenRecommendations(insights: Insight[]): InsightRecommendation[] {
  const seen = new Map<string, InsightRecommendation>();
  for (const ins of insights) {
    for (const rec of ins.recommendations) {
      const prev = seen.get(rec.action);
      if (!prev || SEVERITY_RANK[rec.priority] > SEVERITY_RANK[prev.priority]) {
        seen.set(rec.action, rec);
      }
    }
  }
  return [...seen.values()].sort((a, b) => SEVERITY_RANK[b.priority] - SEVERITY_RANK[a.priority]);
}

/** 给 SkillEvalSnapshot 借口暴露 — 当前未使用但保留以备 detection 扩展(eval-score 卡的指标进 insight)。 */
export type _SkillEvalSnapshotForInsight = SkillEvalSnapshot;

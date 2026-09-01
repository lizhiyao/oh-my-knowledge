import type {
  DetectInsightsOptions,
  Diagnosis,
  DiagnosisAudience,
  DiagnosisSeverity,
  DiagnosisType,
  Insight,
  InsightAudience,
  InsightCategory,
  InsightEvidence,
  InsightRecommendation,
  InsightSeverity,
  SkillDoctorSnapshot,
  SkillIndexEntry,
  SkillObserveSnapshot,
} from '../types/index.js';
import { isActiveDiagnosisLifecycle } from '../diagnosis/types.js';

export type {
  DetectInsightsOptions,
  Insight,
  InsightAudience,
  InsightCategory,
  InsightEvidence,
  InsightRecommendation,
  InsightSeverity,
} from '../types/index.js';

const SEVERITY_RANK: Record<InsightSeverity, number> = { high: 3, medium: 2, low: 1 };

function underpoweredCaveat(observe: SkillObserveSnapshot): InsightEvidence | null {
  return observe.confidence === 'underpowered'
    ? { perspective: 'observe', status: 'silent', message: `仅观测到 ${observe.segmentCount} 个片段，信号样本不足，暂不下硬结论。` }
    : null;
}

function capByObserveConfidence(severity: InsightSeverity, observe: SkillObserveSnapshot): InsightSeverity {
  return observe.confidence === 'underpowered' && severity !== 'low' ? 'low' : severity;
}

function hasEnoughComparableToolResults(observe: SkillObserveSnapshot): boolean {
  if (observe.toolCallCount === undefined) return true;
  return Math.max(
    0,
    (observe.toolResolvedCount ?? observe.toolCallCount) - (observe.toolCancelledCount ?? 0),
  ) >= 5;
}

function detectSkillDocGap(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  const dependency = doctor?.results.find((result) => (
    result.ruleId === 'dependencies_present' && result.status !== 'pass'
  ));
  if (dependency === undefined) return null;
  const missingFiles = (dependency.detail?.missing_files as string[] | undefined) ?? [];
  return {
    id: 'skill-doc-gap',
    category: 'skill-doc-gap',
    audience: 'sample-author',
    title: 'skill 引用了未声明或不可用的依赖文件',
    description: '静态体检确认知识定义依赖不完整；请先修复依赖事实，再生成或调整评测用例。',
    severity: dependency.status === 'fail' ? 'high' : 'medium',
    affectedCount: Math.max(1, missingFiles.length),
    stageRefs: {
      doctorRuleIds: [dependency.ruleId],
      ...((observe?.gapRate ?? 0) >= 0.2 ? { observeRefs: ['gap'] } : {}),
    },
    evidence: [{ perspective: 'doctor', status: 'flagged', message: dependency.message, ref: dependency.ruleId }],
    recommendations: [{
      action: '补齐实际依赖文件，或从 SKILL.md 中移除失效引用；随后重新运行 doctor。',
      priority: dependency.status === 'fail' ? 'high' : 'medium',
    }],
  };
}

function detectProductionInstability(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  if (observe === null
      || observe.failureRate < 0.2
      || !hasEnoughComparableToolResults(observe)) return null;
  const severity = capByObserveConfidence(observe.failureRate >= 0.4 ? 'high' : 'medium', observe);
  const evidence: InsightEvidence[] = [{
    perspective: 'observe',
    status: 'flagged',
    message: `生产工具失败率为 ${(observe.failureRate * 100).toFixed(0)}％。`,
  }];
  const dependency = doctor?.results.find((result) => (
    result.ruleId === 'dependencies_present' && result.status !== 'pass'
  ));
  if (dependency !== undefined) {
    evidence.push({ perspective: 'doctor', status: 'flagged', message: dependency.message, ref: dependency.ruleId });
  }
  const caveat = underpoweredCaveat(observe);
  if (caveat !== null) evidence.push(caveat);
  return {
    id: 'production-instability',
    category: 'production-instability',
    audience: 'skill-author',
    title: '真实运行中的工具调用不稳定',
    description: '生产观测显示工具调用存在持续失败；先区分知识工作流问题与环境故障，再决定修改位置。',
    severity,
    affectedCount: Math.max(1, Math.round((observe.toolCallCount ?? observe.segmentCount) * observe.failureRate)),
    stageRefs: { observeRefs: ['high-failure-rate'] },
    evidence,
    recommendations: [{
      action: '核对失败调用的凭证、网络、工具版本和参数；若属于可恢复故障，在 skill 中明确重试与诚实失败策略。',
      priority: severity,
    }],
  };
}

function detectCoverageGap(observe: SkillObserveSnapshot | null): Insight | null {
  if (observe === null || observe.gapRate <= 0) return null;
  const severity = capByObserveConfidence(
    observe.gapRate >= 0.4 ? 'high' : observe.gapRate >= 0.2 ? 'medium' : 'low',
    observe,
  );
  const evidence: InsightEvidence[] = [{
    perspective: 'observe',
    status: 'flagged',
    message: `生产知识缺口率为 ${(observe.gapRate * 100).toFixed(0)}％。`,
  }];
  const caveat = underpoweredCaveat(observe);
  if (caveat !== null) evidence.push(caveat);
  return {
    id: 'coverage-gap',
    category: 'coverage-gap',
    audience: 'sample-author',
    title: '真实使用中存在知识覆盖缺口',
    description: '观测证据表明部分真实任务没有被现有知识覆盖。用例应从原始观测证据生成，而不是从旧评测报告反推。',
    severity,
    affectedCount: Math.max(1, Math.round(observe.segmentCount * observe.gapRate)),
    stageRefs: { observeRefs: ['gap', 'uncovered-files'] },
    evidence,
    recommendations: [{ action: '查看对应观察记录，基于真实失败轨迹起草新用例并人工确认。', priority: severity }],
  };
}

function detectSkillTooLong(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  const rule = doctor?.results.find((result) => (
    result.ruleId === 'skill_readable' && result.status === 'warn'
  ));
  if (rule === undefined) return null;
  const observeBump = observe !== null && observe.gapRate >= 0.3 && observe.confidence !== 'underpowered';
  return {
    id: 'skill-too-long',
    category: 'skill-too-long',
    audience: 'skill-author',
    title: 'skill 文档过长，关键约束可能被忽略',
    description: '将长示例和背景资料下沉到 references，保持主工作流清晰。',
    severity: observeBump ? 'medium' : 'low',
    affectedCount: 1,
    stageRefs: { doctorRuleIds: [rule.ruleId], ...(observeBump ? { observeRefs: ['gap'] } : {}) },
    evidence: [{ perspective: 'doctor', status: 'flagged', message: rule.message, ref: rule.ruleId }],
    recommendations: [{
      action: '把长示例和背景材料拆到 references，SKILL.md 只保留触发条件、硬规则与主工作流。',
      priority: 'medium',
    }],
  };
}

function insightCategory(type: DiagnosisType, signal: string): InsightCategory {
  if (type === 'definition_gap' || type === 'standard_candidate') return 'skill-doc-gap';
  if (type === 'sample_design_issue') return 'environment-blocked-mocks';
  if (type === 'doctor_gap' || type === 'maintenance_issue') return 'omk-doctor-blindspot';
  if (type === 'eval_failure') return 'failure-mode-skill';
  if ((type === 'runtime_issue' || type === 'user_feedback_pattern')
      && (signal.includes('coverage') || signal.includes('gap'))) return 'coverage-gap';
  if (type === 'runtime_issue' || type === 'user_feedback_pattern') return 'production-instability';
  return 'other';
}

function insightAudience(audience: DiagnosisAudience): InsightAudience {
  if (audience === 'sample-author') return 'sample-author';
  if (audience === 'omk-maintainer') return 'omk-maintainer';
  return 'skill-author';
}

function insightSeverity(severity: DiagnosisSeverity): InsightSeverity {
  return severity === 'high' ? 'high' : severity === 'medium' ? 'medium' : 'low';
}

function patchTarget(target: NonNullable<Diagnosis['patch']>['target']): NonNullable<InsightRecommendation['patch']>['target'] {
  return target === 'definition' ? 'skill' : target;
}

function projectDiagnosis(diagnosis: Diagnosis): Insight {
  const severity = insightSeverity(diagnosis.severity);
  const recommendations: InsightRecommendation[] = [];
  if (diagnosis.recommendation !== undefined || diagnosis.patch !== undefined) {
    recommendations.push({
      action: diagnosis.recommendation ?? diagnosis.command ?? '检查关联证据并修复对应知识定义。',
      priority: severity,
      ...(diagnosis.patch === undefined ? {} : {
        patch: {
          target: patchTarget(diagnosis.patch.target),
          location: diagnosis.patch.location,
          snippet: diagnosis.patch.snippet,
        },
      }),
    });
  }
  if (diagnosis.command !== undefined
      && !recommendations.some((entry) => entry.action === diagnosis.command)) {
    recommendations.push({ action: diagnosis.command, priority: severity });
  }
  if (recommendations.length === 0) {
    recommendations.push({ action: '检查关联证据并修复对应知识定义。', priority: severity });
  }
  const doctorRuleIds = diagnosis.scope.refs.ruleId === undefined
    ? []
    : [diagnosis.scope.refs.ruleId];
  const observeRefs = diagnosis.occurrences.some((occurrence) => occurrence.source === 'observe')
    ? [diagnosis.signal]
    : [];
  const perspective = diagnosis.occurrences.length > 0
    && diagnosis.occurrences.every((occurrence) => occurrence.source === 'doctor')
    ? 'doctor'
    : 'observe';
  return {
    id: `diagnosis:${diagnosis.id}`,
    category: insightCategory(diagnosis.type, diagnosis.signal),
    audience: insightAudience(diagnosis.audience),
    title: diagnosis.title,
    description: diagnosis.summary ?? diagnosis.evidenceSummary,
    severity,
    affectedCount: diagnosis.occurrenceCount,
    stageRefs: {
      ...(doctorRuleIds.length === 0 ? {} : { doctorRuleIds }),
      ...(observeRefs.length === 0 ? {} : { observeRefs }),
    },
    evidence: [{
      perspective,
      status: 'flagged',
      message: diagnosis.evidenceSummary ?? diagnosis.summary ?? diagnosis.title,
      ref: diagnosis.occurrences[0]?.sourceId ?? diagnosis.stableKey,
    }],
    recommendations,
  };
}

export function projectDiagnosticsToInsights(diagnostics: Diagnosis[]): Insight[] {
  return diagnostics
    .filter((diagnosis) => isActiveDiagnosisLifecycle(diagnosis.lifecycle))
    .map(projectDiagnosis)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.affectedCount - a.affectedCount);
}

export function detectInsights(entry: SkillIndexEntry, options: DetectInsightsOptions = {}): Insight[] {
  return [
    detectSkillDocGap(entry.doctor, entry.observe),
    detectSkillTooLong(entry.doctor, entry.observe),
    detectCoverageGap(entry.observe),
    detectProductionInstability(entry.doctor, entry.observe),
    ...projectDiagnosticsToInsights(options.diagnostics ?? []),
  ].filter((candidate): candidate is Insight => candidate !== null)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.affectedCount - a.affectedCount);
}

export function flattenRecommendations(insights: Insight[]): InsightRecommendation[] {
  const seen = new Map<string, InsightRecommendation>();
  for (const insight of insights) {
    for (const recommendation of insight.recommendations) {
      const previous = seen.get(recommendation.action);
      if (previous === undefined
          || SEVERITY_RANK[recommendation.priority] > SEVERITY_RANK[previous.priority]) {
        seen.set(recommendation.action, recommendation);
      }
    }
  }
  return [...seen.values()].sort((a, b) => SEVERITY_RANK[b.priority] - SEVERITY_RANK[a.priority]);
}

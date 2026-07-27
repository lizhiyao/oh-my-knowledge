import { createHash } from 'node:crypto';
import type {
  Diagnosis,
  DiagnosisAudience,
  DiagnosisBundle,
  DiagnosisEvidenceRef,
  DiagnosisLifecycle,
  DiagnosisOccurrence,
  DiagnosisSeverity,
  DiagnosisType,
} from './types.js';
import { maxDiagnosisLifecycle } from './types.js';
import {
  ownRecordValue,
  setOwnRecordValue,
  sumRecordCounts,
} from '../shared/record-count.js';

const OBSERVE_ONLY_COVERAGE = { observe: true, doctor: false, eval: false } as const;

export interface ObserveDiagnosisInput {
  generatedAt: string;
  skillChainAdvisories?: SkillChainAdvisorySource[];
  runtimeChecks?: ObservationRuntimeCheckSource[];
  problemPatterns?: ExperienceProblemPatternSource[];
  reviewerFindings?: ExperienceReviewerReportFindingSource[];
  derivedStandards?: SkillDerivedStandardSource[];
}

export interface SkillChainAdvisorySource {
  skillName: string;
  code: 'hardrules_not_declared' | 'workflows_not_declared' | 'skill_md_not_found';
  message?: string;
  exampleYaml?: string;
  commandTemplate?: string;
  sourceId?: string;
}

export interface ObservationRuntimeCheckSource {
  skillName: string;
  id: string;
  nodeKind: 'hardRule' | 'workflowNode';
  status: 'passed' | 'attention' | 'manual_review';
  title?: string;
  expectation?: string;
  reason?: string;
  evidenceRefs?: DiagnosisEvidenceRef[];
  evidenceSnippets?: string[];
}

export interface ExperienceProblemPatternSource {
  skillName: string;
  bucket: string;
  patternKey: string;
  signalTypes: string[];
  count: number;
  sessionCount: number;
  recentSessionIds?: string[];
  evidenceRefs?: DiagnosisEvidenceRef[];
  lastSeen?: string;
}

export interface ExperienceReviewerReportFindingSource {
  skillName: string;
  id: string;
  judgmentId?: string;
  source: 'deterministic_rule' | 'llm_soft' | 'manual';
  level: 'info' | 'low' | 'medium' | 'high' | 'attention' | 'sample' | 'normal' | 'warning' | 'critical';
  title?: string;
  body?: string;
  ruleSource: string;
  ruleVersion?: string;
  targetKey?: string;
  evidenceRefs?: DiagnosisEvidenceRef[];
}

export interface SkillDerivedStandardSource {
  skillName: string;
  id: string;
  standardKind: 'hard_rule_candidate' | 'workflow_candidate';
  status: 'pending_review' | 'author_confirmed' | 'rejected' | 'stale';
  title: string;
  body?: string;
  source?: 'llm_soft_standard' | 'manual';
  confidence?: number;
  evidence?: string[];
  model?: string;
  promptVersion?: string;
}

export function buildObserveDiagnostics(input: ObserveDiagnosisInput): DiagnosisBundle {
  const byStableKey = new Map<string, Diagnosis>();
  for (const advisory of input.skillChainAdvisories ?? []) {
    upsertDiagnosis(byStableKey, advisoryToDiagnosis(input.generatedAt, advisory));
  }
  for (const check of input.runtimeChecks ?? []) {
    const diagnosis = runtimeCheckToDiagnosis(input.generatedAt, check);
    if (diagnosis) upsertDiagnosis(byStableKey, diagnosis);
  }
  for (const pattern of input.problemPatterns ?? []) {
    upsertDiagnosis(byStableKey, problemPatternToDiagnosis(input.generatedAt, pattern));
  }
  for (const finding of input.reviewerFindings ?? []) {
    const diagnosis = reviewerFindingToDiagnosis(input.generatedAt, finding);
    if (diagnosis) upsertDiagnosis(byStableKey, diagnosis);
  }
  for (const standard of input.derivedStandards ?? []) {
    upsertDiagnosis(byStableKey, derivedStandardToDiagnosis(input.generatedAt, standard));
  }

  const bySkill: Record<string, Diagnosis[]> = {};
  for (const diagnosis of byStableKey.values()) {
    const group = ownRecordValue(bySkill, diagnosis.skillName) ?? [];
    group.push(diagnosis);
    setOwnRecordValue(bySkill, diagnosis.skillName, group);
  }
  for (const diagnoses of Object.values(bySkill)) {
    diagnoses.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.signal.localeCompare(b.signal));
  }

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    sourceCoverage: { ...OBSERVE_ONLY_COVERAGE },
    bySkill,
  };
}

function advisoryToDiagnosis(generatedAt: string, advisory: SkillChainAdvisorySource): Diagnosis {
  const target = advisory.code === 'hardrules_not_declared'
    ? 'definition:hardRules'
    : advisory.code === 'workflows_not_declared'
      ? 'definition:workflows'
      : 'definition:skill_md';
  const title = advisory.code === 'hardrules_not_declared'
    ? 'Hard rules are not declared in SKILL.md'
    : advisory.code === 'workflows_not_declared'
      ? 'Workflow is not declared in SKILL.md'
      : 'SKILL.md was not found';
  return makeDiagnosis(generatedAt, {
    skillName: advisory.skillName,
    type: 'definition_gap',
    signal: advisory.code,
    target,
    title,
    summary: advisory.message,
    severity: advisory.code === 'skill_md_not_found' ? 'high' : 'medium',
    audience: 'skill-author',
    lifecycle: 'detected',
    sourceKind: 'skill_chain',
    sourceId: advisory.sourceId ?? `skill_chain:${advisory.code}:${advisory.skillName}`,
    evidenceRefs: [],
    payload: { ...advisory },
    recommendation: advisory.exampleYaml ? 'Move confirmed rules or workflow into SKILL.md frontmatter.' : undefined,
    command: advisory.commandTemplate,
    patch: advisory.exampleYaml
      ? { target: 'definition', location: 'SKILL.md frontmatter', snippet: advisory.exampleYaml }
      : undefined,
  });
}

function runtimeCheckToDiagnosis(generatedAt: string, check: ObservationRuntimeCheckSource): Diagnosis | null {
  if (check.status === 'passed') return null;
  const target = check.nodeKind === 'hardRule' ? `runtime:hardRule:${check.id}` : `runtime:workflowNode:${check.id}`;
  return makeDiagnosis(generatedAt, {
    skillName: check.skillName,
    type: 'runtime_issue',
    signal: check.nodeKind === 'hardRule' ? 'runtime_hard_rule_review' : 'runtime_workflow_review',
    target,
    title: check.title ?? (check.nodeKind === 'hardRule' ? 'Hard rule runtime check needs review' : 'Workflow runtime check needs review'),
    summary: check.reason ?? check.expectation,
    severity: check.status === 'manual_review' ? 'medium' : 'low',
    audience: 'reviewer',
    lifecycle: 'detected',
    sourceKind: 'runtime_check',
    sourceId: check.id,
    evidenceRefs: check.evidenceRefs ?? [],
    payload: { ...check },
  });
}

function problemPatternToDiagnosis(generatedAt: string, pattern: ExperienceProblemPatternSource): Diagnosis {
  const signal = pattern.signalTypes[0] ?? pattern.bucket;
  return makeDiagnosis(generatedAt, {
    skillName: pattern.skillName,
    type: typeForPattern(pattern.bucket, signal),
    signal,
    target: `pattern:${pattern.bucket}:${pattern.patternKey}`,
    title: `Repeated observe pattern: ${signal}`,
    summary: `Seen in ${pattern.sessionCount} session(s), ${pattern.count} occurrence(s).`,
    severity: pattern.sessionCount >= 3 ? 'high' : pattern.sessionCount >= 2 ? 'medium' : 'low',
    audience: 'skill-author',
    lifecycle: 'detected',
    sourceKind: 'problem_pattern',
    sourceId: pattern.patternKey,
    evidenceRefs: pattern.evidenceRefs ?? [],
    timestamp: pattern.lastSeen,
    payload: { ...pattern },
    // pattern.count = 总发生次数(可能跨多 session),用作 affectedCount 更贴近用户感知的「影响范围」,
    // 比 sessionCount 更稳(单 session 内重复 10 次也算 10 次发生)。
    occurrenceCount: pattern.count,
  });
}

function reviewerFindingToDiagnosis(generatedAt: string, finding: ExperienceReviewerReportFindingSource): Diagnosis | null {
  if (finding.ruleSource === 'no_priority_signal') return null;
  const target = finding.targetKey ?? `reviewer:${finding.ruleSource}`;
  return makeDiagnosis(generatedAt, {
    skillName: finding.skillName,
    type: typeForReviewerRule(finding.ruleSource),
    signal: finding.ruleSource,
    target,
    title: titleForReviewerRule(finding.ruleSource, finding.title),
    summary: finding.body,
    severity: severityFromReviewerLevel(finding.level),
    audience: 'reviewer',
    lifecycle: 'detected',
    sourceKind: finding.ruleSource,
    sourceId: finding.id,
    evidenceRefs: finding.evidenceRefs ?? [],
    producer: finding.source,
    payload: { ...finding },
  });
}

function derivedStandardToDiagnosis(generatedAt: string, standard: SkillDerivedStandardSource): Diagnosis {
  return makeDiagnosis(generatedAt, {
    skillName: standard.skillName,
    type: 'standard_candidate',
    signal: standard.standardKind,
    target: `standard:${standard.standardKind}:${standard.id}`,
    title: standard.title,
    summary: standard.body,
    severity: standard.status === 'author_confirmed' ? 'info' : 'low',
    audience: 'skill-author',
    lifecycle: lifecycleFromStandardStatus(standard.status),
    sourceKind: standard.standardKind,
    sourceId: standard.id,
    evidenceRefs: [],
    producer: standard.source === 'manual' ? 'manual' : 'llm_soft',
    payload: { ...standard },
    evidenceSummary: standard.evidence?.join('\n'),
  });
}

function makeDiagnosis(
  generatedAt: string,
  input: {
    skillName: string;
    type: DiagnosisType;
    signal: string;
    target: string;
    title: string;
    summary?: string;
    severity: DiagnosisSeverity;
    audience: DiagnosisAudience;
    lifecycle: DiagnosisLifecycle;
    sourceKind: string;
    sourceId: string;
    evidenceRefs: DiagnosisEvidenceRef[];
    producer?: DiagnosisOccurrence['producer'];
    payload: Record<string, unknown>;
    timestamp?: string;
    evidenceSummary?: string;
    recommendation?: string;
    command?: string;
    patch?: Diagnosis['patch'];
    /** 对聚合型 source(如 problem pattern)用真实 count 覆盖默认的 1。
     *  默认 1 是「每个 source 贡献一个 occurrence」语义。但 problemPattern 已经是
     *  「N 个 session / M 次发生」的聚合,1 会让 Studio 排序和 affectedCount 显示失真。 */
    occurrenceCount?: number;
  },
): Diagnosis {
  const stableKey = [
    `skill:${input.skillName}`,
    `type:${input.type}`,
    `signal:${input.signal}`,
    `target:${input.target}`,
  ].join('|');
  const occurrence: DiagnosisOccurrence = {
    id: hashParts(
      'occurrence',
      stableKey,
      input.sourceKind,
      input.sourceId,
      input.timestamp ?? generatedAt,
    ),
    diagnosisStableKey: stableKey,
    source: 'observe',
    sourceId: input.sourceId,
    sourceKind: input.sourceKind,
    timestamp: input.timestamp ?? generatedAt,
    severity: input.severity,
    evidenceRefs: input.evidenceRefs,
    producer: input.producer ?? 'deterministic_rule',
    payload: input.payload,
  };
  return {
    id: hashParts('diagnosis', stableKey),
    stableKey,
    skillName: input.skillName,
    type: input.type,
    signal: input.signal,
    title: input.title,
    summary: input.summary,
    severity: input.severity,
    audience: input.audience,
    lifecycle: input.lifecycle,
    scope: {
      primary: input.target.startsWith('definition:') || input.target.startsWith('standard:') ? 'definition' : 'skill',
      refs: { skillName: input.skillName },
    },
    occurrences: [occurrence],
    occurrenceCount: input.occurrenceCount ?? 1,
    evidenceSummary: input.evidenceSummary,
    recommendation: input.recommendation,
    command: input.command,
    patch: input.patch,
  };
}

function upsertDiagnosis(byStableKey: Map<string, Diagnosis>, next: Diagnosis): void {
  const existing = byStableKey.get(next.stableKey);
  if (!existing) {
    byStableKey.set(next.stableKey, next);
    return;
  }
  const existingOccurrenceIds = new Set(existing.occurrences.map((occurrence) => occurrence.id));
  const hasOverlap = next.occurrences.some((occurrence) => existingOccurrenceIds.has(occurrence.id));
  existing.occurrences.push(
    ...next.occurrences.filter((occurrence) => !existingOccurrenceIds.has(occurrence.id)),
  );
  existing.occurrenceCount = hasOverlap
    ? Math.max(existing.occurrenceCount, next.occurrenceCount)
    : sumRecordCounts(existing.occurrenceCount, next.occurrenceCount);
  existing.severity = maxSeverity(existing.severity, next.severity);
  existing.lifecycle = maxDiagnosisLifecycle(existing.lifecycle, next.lifecycle);
}

function typeForPattern(bucket: string, signal: string): DiagnosisType {
  if (bucket === 'definition_gap') return 'definition_gap';
  if (signal.includes('feedback') || signal.includes('correction') || signal.includes('interruption')) return 'user_feedback_pattern';
  return 'runtime_issue';
}

function typeForReviewerRule(ruleSource: string): DiagnosisType {
  if (ruleSource.includes('feedback') || ruleSource.includes('correction') || ruleSource.includes('interruption')) {
    return 'user_feedback_pattern';
  }
  return 'runtime_issue';
}

function titleForReviewerRule(ruleSource: string, fallback?: string): string {
  if (ruleSource === 'final_delivery_absent') return 'Final delivery is missing in repeated runs';
  if (ruleSource === 'tool_error_recovery') return 'Tool failure recovery needs review';
  return fallback ?? `Reviewer finding: ${ruleSource}`;
}

function severityFromReviewerLevel(level: ExperienceReviewerReportFindingSource['level']): DiagnosisSeverity {
  if (level === 'critical' || level === 'high') return 'high';
  if (level === 'warning' || level === 'attention' || level === 'medium') return 'medium';
  if (level === 'sample' || level === 'low') return 'low';
  return 'info';
}

function lifecycleFromStandardStatus(status: SkillDerivedStandardSource['status']): DiagnosisLifecycle {
  if (status === 'pending_review') return 'candidate';
  if (status === 'author_confirmed') return 'resolved';
  if (status === 'rejected') return 'rejected';
  return 'stale';
}

function maxSeverity(a: DiagnosisSeverity, b: DiagnosisSeverity): DiagnosisSeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

export function maxLifecycle(a: DiagnosisLifecycle, b: DiagnosisLifecycle): DiagnosisLifecycle {
  // mapper 内的 upsert 合并语义:同一批 build 里多个 source 产生同 stableKey 时,
  // 终态(resolved / rejected)是作者人为确认或驳回的结果,优先级高于自动检出态。
  // 比如 `derivedStandard.author_confirmed` 已经把 standard 标 resolved,旁路再来一个
  // 自动 detected 信号,应保留 resolved 而不是把 confirmation 擦掉。
  // 「resolved 后新 occurrence 进来 reopen 到 detected」属于跨时间的 lifecycle 状态机,
  // 由上层 review-state store 决定,不在此处处理。
  return maxDiagnosisLifecycle(a, b);
}

function severityRank(severity: DiagnosisSeverity): number {
  if (severity === 'high') return 4;
  if (severity === 'medium') return 3;
  if (severity === 'low') return 2;
  return 1;
}

function hashParts(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

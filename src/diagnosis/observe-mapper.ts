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
  kind: 'hardRule' | 'workflowNode';
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
  kind: 'hard_rule_candidate' | 'workflow_candidate';
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
    bySkill[diagnosis.skillName] ??= [];
    bySkill[diagnosis.skillName].push(diagnosis);
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
  const target = check.kind === 'hardRule' ? `runtime:hardRule:${check.id}` : `runtime:workflowNode:${check.id}`;
  return makeDiagnosis(generatedAt, {
    skillName: check.skillName,
    type: 'runtime_issue',
    signal: check.kind === 'hardRule' ? 'runtime_hard_rule_review' : 'runtime_workflow_review',
    target,
    title: check.title ?? (check.kind === 'hardRule' ? 'Hard rule runtime check needs review' : 'Workflow runtime check needs review'),
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
    signal: standard.kind,
    target: `standard:${standard.kind}:${standard.id}`,
    title: standard.title,
    summary: standard.body,
    severity: standard.status === 'author_confirmed' ? 'info' : 'low',
    audience: 'skill-author',
    lifecycle: lifecycleFromStandardStatus(standard.status),
    sourceKind: standard.kind,
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
  },
): Diagnosis {
  const stableKey = [
    `skill:${input.skillName}`,
    `type:${input.type}`,
    `signal:${input.signal}`,
    `target:${input.target}`,
  ].join('|');
  const occurrence: DiagnosisOccurrence = {
    id: hashParts('occurrence', stableKey, input.sourceKind, input.sourceId),
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
    occurrenceCount: 1,
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
  existing.occurrences.push(...next.occurrences);
  existing.occurrenceCount = existing.occurrences.length;
  existing.severity = maxSeverity(existing.severity, next.severity);
  existing.lifecycle = maxLifecycle(existing.lifecycle, next.lifecycle);
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

function maxLifecycle(a: DiagnosisLifecycle, b: DiagnosisLifecycle): DiagnosisLifecycle {
  const rank: Record<DiagnosisLifecycle, number> = {
    detected: 5,
    candidate: 4,
    stale: 3,
    confirmed: 2,
    resolved: 1,
    rejected: 0,
  };
  return rank[a] >= rank[b] ? a : b;
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

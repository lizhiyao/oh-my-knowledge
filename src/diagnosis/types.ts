export type DiagnosisSource = 'observe' | 'doctor' | 'eval';
export type DiagnosisAudience = 'skill-author' | 'sample-author' | 'omk-maintainer' | 'reviewer';
export type DiagnosisSeverity = 'high' | 'medium' | 'low' | 'info';
export type DiagnosisLifecycle = 'detected' | 'candidate' | 'confirmed' | 'rejected' | 'resolved' | 'stale';
export type DiagnosisType =
  | 'definition_gap'
  | 'runtime_issue'
  | 'user_feedback_pattern'
  | 'eval_failure'
  | 'sample_design_issue'
  | 'doctor_gap'
  | 'standard_candidate'
  | 'maintenance_issue';

export interface DiagnosisSourceCoverage {
  observe: boolean;
  doctor: boolean;
  eval: boolean;
}

export interface DiagnosisScope {
  primary: 'skill' | 'definition' | 'session' | 'sample';
  refs: {
    skillName: string;
    sessionId?: string;
    invocationId?: string;
    sampleId?: string;
    ruleId?: string;
    workflowId?: string;
    sourceTrace?: string;
  };
}

export interface DiagnosisEvidenceRef {
  id: string;
  kind: string;
  sourceTrace?: string;
  sessionId?: string;
  messageIndex?: number;
  logicalMessageIndex?: number;
  sourceLineIndex?: number;
  messageUuid?: string;
  toolUseId?: string;
  timestamp?: string;
  label?: string;
  snippet?: string;
}

export interface DiagnosisOccurrence {
  id: string;
  diagnosisStableKey: string;
  source: DiagnosisSource;
  sourceId: string;
  sourceKind: string;
  timestamp?: string;
  severity?: DiagnosisSeverity;
  evidenceRefs: DiagnosisEvidenceRef[];
  rawRef?: string;
  producer: 'deterministic_rule' | 'llm_soft' | 'manual';
  payload?: Record<string, unknown>;
}

export interface DiagnosisPatch {
  target: 'skill' | 'sample-environment' | 'sample-mocks' | 'doctor-rule' | 'definition';
  location: string;
  snippet: string;
}

export interface Diagnosis {
  id: string;
  stableKey: string;
  skillName: string;
  type: DiagnosisType;
  signal: string;
  title: string;
  summary?: string;
  severity: DiagnosisSeverity;
  audience: DiagnosisAudience;
  lifecycle: DiagnosisLifecycle;
  scope: DiagnosisScope;
  occurrences: DiagnosisOccurrence[];
  occurrenceCount: number;
  evidenceSummary?: string;
  recommendation?: string;
  patch?: DiagnosisPatch;
  command?: string;
}

export interface DiagnosisBundle {
  schemaVersion: 1;
  generatedAt: string;
  sourceCoverage: DiagnosisSourceCoverage;
  bySkill: Record<string, Diagnosis[]>;
}

/** Diagnosis 是否「active problem」的唯一权威定义。
 *
 *  跟 docs/diagnosis-occurrence-mapping.md 的 studio projection rule 对齐:
 *    active = detected / candidate / stale
 *    inactive = resolved / rejected(默认从 active 列表隐藏)
 *    confirmed:目前 mapper 不产出,如果将来 producer / review-state 写出,会被一并算 inactive
 *               —— 跟 confirmed soft standard 的「已被认知、进入处理流程」语义一致。
 *
 *  抽这个 helper 是为了:Insight 投影(影响 skill 健康 / 待优化数)和 /api/observations/diagnostics
 *  的 active 列表共用同一份口径,避免「Insight 把 confirmed 算 active 但 API 不算」的口径分叉。
 */
const ACTIVE_DIAGNOSIS_LIFECYCLES: ReadonlySet<DiagnosisLifecycle> = new Set<DiagnosisLifecycle>([
  'detected',
  'candidate',
  'stale',
]);

export function isActiveDiagnosisLifecycle(lifecycle: DiagnosisLifecycle): boolean {
  return ACTIVE_DIAGNOSIS_LIFECYCLES.has(lifecycle);
}

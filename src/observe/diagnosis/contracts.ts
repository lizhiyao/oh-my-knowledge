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
    traceId?: string;
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
  traceId?: string;
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

export interface StudioDiagnosisSummary {
  sourceCoverage: DiagnosisSourceCoverage;
  totalCount: number;
  partial: boolean;
  bySeverity: Record<DiagnosisSeverity, number>;
  bySkill: Record<string, number>;
  byAudience: Record<string, number>;
}

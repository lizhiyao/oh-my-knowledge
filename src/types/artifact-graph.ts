export interface ArtifactGraphDocument {
  documentKind: 'artifact-graph';
  schemaVersion: 1;
  graphId: string;
  generatedAt: string;
  source: ArtifactGraphSource;
  scope: ArtifactGraphScope;
  nodes: ArtifactGraphNode[];
  edges: ArtifactGraphEdge[];
  summaries?: ArtifactGraphSummary[];
}

export type ArtifactGraphSourceKind = 'doctor' | 'eval' | 'observe';

export interface ArtifactGraphSource {
  sourceKind: ArtifactGraphSourceKind;
  sourceId: string;
  sourcePath?: string;
  cliVersion?: string;
}

export interface ArtifactGraphScope {
  cwd: string;
  artifactKind?: 'skill' | 'prompt' | 'agent' | 'workflow';
  skillName?: string;
  artifactHash?: string;
  sourceLocator?: string;
  sampleSetHash?: string;
}

export type ArtifactGraphLayer = 'definition' | 'measurement' | 'production';

export type ArtifactGraphNodeRole = 'entity' | 'observation' | 'aggregate';

// Schema v1 intentionally reserves eval/observe node and edge kinds. Enum
// expansion is additive: Core-native projections use qualified measurement
// entities instead of overloading legacy variant/result semantics.
export type ArtifactGraphNodeKind =
  | 'skill'
  | 'skill_file'
  | 'frontmatter'
  | 'reference'
  | 'script'
  | 'tool'
  | 'env'
  | 'preflight'
  | 'hard_rule'
  | 'workflow'
  | 'workflow_node'
  | 'sample'
  | 'assertion'
  | 'variant'
  | 'doctor_rule_result'
  | 'eval_result'
  | 'judge_dimension'
  | 'diagnostic'
  | 'trace_session'
  | 'skill_invocation'
  | 'tool_call'
  | 'gap_signal'
  | 'evaluation_run'
  | 'target'
  | 'evaluator'
  | 'metric'
  | 'execution_result'
  | 'evaluation_result'
  | 'analysis_result'
  | 'decision';

export type ArtifactGraphStatus =
  | 'ok'
  | 'warning'
  | 'failed'
  | 'skipped'
  | 'unknown'
  | 'not_measured';

export interface ArtifactGraphBinding {
  bindingStrength: 'content-hash' | 'source-locator' | 'runtime-trace' | 'name-only' | 'aggregate' | 'explicit';
  keys: Record<string, string>;
}

export interface ArtifactGraphAttrs {
  display?: Record<string, unknown>;
  producer?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface ArtifactGraphNode {
  id: string;
  stableKey: string;
  nodeKind: ArtifactGraphNodeKind;
  nodeRole: ArtifactGraphNodeRole;
  layer: ArtifactGraphLayer;
  label: string;
  status?: ArtifactGraphStatus;
  confidence?: number;
  binding?: ArtifactGraphBinding;
  metrics?: Record<string, number>;
  attrs?: ArtifactGraphAttrs;
  evidenceRefs?: ArtifactGraphEvidenceRef[];
}

export type ArtifactGraphEdgeKind =
  | 'contains'
  | 'declares'
  | 'requires'
  | 'references'
  | 'defines_workflow'
  | 'next_step'
  | 'covers'
  | 'evaluates'
  | 'passes'
  | 'fails'
  | 'diagnoses'
  | 'invokes'
  | 'calls_tool'
  | 'observes'
  | 'signals_gap'
  | 'derived_from';

export interface ArtifactGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeKind: ArtifactGraphEdgeKind;
  layer: ArtifactGraphLayer;
  label?: string;
  status?: ArtifactGraphStatus;
  confidence?: number;
  weight?: number;
  binding?: ArtifactGraphBinding;
  metrics?: Record<string, number>;
  attrs?: ArtifactGraphAttrs;
  evidenceRefs?: ArtifactGraphEvidenceRef[];
}

export type ArtifactGraphEvidenceSourceKind =
  | 'skill-file'
  | 'doctor-report'
  | 'eval-report'
  | 'observe-report'
  | 'trace'
  | 'sample'
  | 'evaluation-core-document'
  | 'managed-record';

export type ArtifactGraphEvidenceSelectorKind =
  | 'json-pointer'
  | 'line-range'
  | 'sample-id'
  | 'rule-id'
  | 'trace-event-id'
  | 'node-id';

export interface ArtifactGraphEvidenceSelector {
  selectorKind: ArtifactGraphEvidenceSelectorKind;
  value: string;
}

export interface ArtifactGraphEvidenceRef {
  sourceKind: ArtifactGraphEvidenceSourceKind;
  sourceId?: string;
  path?: string;
  selector?: ArtifactGraphEvidenceSelector;
  contentHash?: string;
  label?: string;
  snippet?: string;
  redaction?: 'none' | 'truncated' | 'redacted';
}

export interface ArtifactGraphSummary {
  summaryKind: 'structure' | 'coverage' | 'risk' | 'gap' | 'workflow' | 'collection';
  title: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  nodeIds?: string[];
  edgeIds?: string[];
  evidenceRefs?: ArtifactGraphEvidenceRef[];
}

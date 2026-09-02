import type {
  ArtifactGraphDocument,
  ArtifactGraphEdge,
  ArtifactGraphEvidenceRef,
  ArtifactGraphNode,
  ArtifactGraphSummary,
} from './contracts.js';
import { normalizeRfc3339Timestamp } from '../../shared/timestamp.js';

const SOURCE_KINDS = new Set(['doctor', 'eval', 'observe']);
const ARTIFACT_KINDS = new Set(['skill', 'prompt', 'agent', 'workflow']);
const LAYERS = new Set(['definition', 'measurement', 'production']);
const NODE_ROLES = new Set(['entity', 'observation', 'aggregate']);
const NODE_KINDS = new Set([
  'skill',
  'skill_file',
  'frontmatter',
  'reference',
  'script',
  'tool',
  'env',
  'preflight',
  'hard_rule',
  'workflow',
  'workflow_node',
  'sample',
  'assertion',
  'variant',
  'doctor_rule_result',
  'eval_result',
  'judge_dimension',
  'diagnostic',
  'trace_session',
  'skill_invocation',
  'tool_call',
  'gap_signal',
  'evaluation_run',
  'target',
  'evaluator',
  'metric',
  'execution_result',
  'evaluation_result',
  'analysis_result',
  'decision',
]);
const STATUSES = new Set(['ok', 'warning', 'failed', 'skipped', 'unknown', 'not_measured']);
const BINDING_STRENGTHS = new Set([
  'content-hash',
  'source-locator',
  'runtime-trace',
  'name-only',
  'aggregate',
  'explicit',
]);
const EDGE_KINDS = new Set([
  'contains',
  'declares',
  'requires',
  'references',
  'defines_workflow',
  'next_step',
  'covers',
  'evaluates',
  'passes',
  'fails',
  'diagnoses',
  'invokes',
  'calls_tool',
  'observes',
  'signals_gap',
  'derived_from',
]);
const EVIDENCE_SOURCE_KINDS = new Set([
  'skill-file',
  'doctor-report',
  'eval-report',
  'observe-report',
  'trace',
  'sample',
  'evaluation-core-document',
  'managed-record',
]);
const SELECTOR_KINDS = new Set([
  'json-pointer',
  'line-range',
  'sample-id',
  'rule-id',
  'trace-event-id',
  'node-id',
]);
const SUMMARY_KINDS = new Set(['structure', 'coverage', 'risk', 'gap', 'workflow', 'collection']);
const SUMMARY_SEVERITIES = new Set(['info', 'low', 'medium', 'high']);

/** Validate a complete graph, including graph identities and referential integrity. */
export function parseArtifactGraphDocument(value: unknown): ArtifactGraphDocument | null {
  if (
    !isRecord(value)
    || value.documentKind !== 'artifact-graph'
    || value.schemaVersion !== 1
    || !nonEmptyString(value.graphId)
    || normalizeRfc3339Timestamp(value.generatedAt) === undefined
    || !isSource(value.source)
    || !isScope(value.scope)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !value.nodes.every(isNode)
    || !value.edges.every(isEdge)
    || (
      value.summaries !== undefined
      && (!Array.isArray(value.summaries) || !value.summaries.every(isSummary))
    )
  ) return null;

  const nodes = value.nodes as ArtifactGraphNode[];
  const edges = value.edges as ArtifactGraphEdge[];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const stableKeys = new Set(nodes.map((node) => node.stableKey));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  if (
    nodeIds.size !== nodes.length
    || stableKeys.size !== nodes.length
    || edgeIds.size !== edges.length
    || edges.some((edge) => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))
  ) return null;

  const summaries = (value.summaries ?? []) as ArtifactGraphSummary[];
  if (summaries.some((summary) =>
    summary.nodeIds?.some((id) => !nodeIds.has(id))
    || summary.edgeIds?.some((id) => !edgeIds.has(id))
  )) return null;
  return value as unknown as ArtifactGraphDocument;
}

function isSource(value: unknown): boolean {
  return isRecord(value)
    && SOURCE_KINDS.has(String(value.sourceKind))
    && nonEmptyString(value.sourceId)
    && optionalString(value.sourcePath)
    && optionalString(value.cliVersion);
}

function isScope(value: unknown): boolean {
  return isRecord(value)
    && typeof value.cwd === 'string'
    && (
      value.artifactKind === undefined
      || ARTIFACT_KINDS.has(String(value.artifactKind))
    )
    && [
      value.skillName,
      value.artifactHash,
      value.sourceLocator,
      value.sampleSetHash,
    ].every(optionalString);
}

function isNode(value: unknown): boolean {
  return isRecord(value)
    && nonEmptyString(value.id)
    && nonEmptyString(value.stableKey)
    && NODE_KINDS.has(String(value.nodeKind))
    && NODE_ROLES.has(String(value.nodeRole))
    && LAYERS.has(String(value.layer))
    && nonEmptyString(value.label)
    && optionalEnum(value.status, STATUSES)
    && optionalRate(value.confidence)
    && optionalBinding(value.binding)
    && optionalMetrics(value.metrics)
    && optionalAttrs(value.attrs)
    && optionalEvidenceRefs(value.evidenceRefs);
}

function isEdge(value: unknown): boolean {
  return isRecord(value)
    && nonEmptyString(value.id)
    && nonEmptyString(value.fromNodeId)
    && nonEmptyString(value.toNodeId)
    && EDGE_KINDS.has(String(value.edgeKind))
    && LAYERS.has(String(value.layer))
    && optionalString(value.label)
    && optionalEnum(value.status, STATUSES)
    && optionalRate(value.confidence)
    && (value.weight === undefined || isFiniteMetric(value.weight))
    && optionalBinding(value.binding)
    && optionalMetrics(value.metrics)
    && optionalAttrs(value.attrs)
    && optionalEvidenceRefs(value.evidenceRefs);
}

function isSummary(value: unknown): boolean {
  return isRecord(value)
    && SUMMARY_KINDS.has(String(value.summaryKind))
    && nonEmptyString(value.title)
    && SUMMARY_SEVERITIES.has(String(value.severity))
    && optionalStringArray(value.nodeIds)
    && optionalStringArray(value.edgeIds)
    && optionalEvidenceRefs(value.evidenceRefs);
}

function optionalBinding(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && BINDING_STRENGTHS.has(String(value.bindingStrength))
    && isRecord(value.keys)
    && Object.values(value.keys).every((entry) => typeof entry === 'string')
  );
}

function optionalMetrics(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) && Object.values(value).every(isFiniteMetric)
  );
}

function optionalAttrs(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && [value.display, value.producer, value.experimental].every(
      (entry) => entry === undefined || isRecord(entry),
    )
  );
}

function optionalEvidenceRefs(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) && value.every(isEvidenceRef)
  );
}

function isEvidenceRef(value: unknown): value is ArtifactGraphEvidenceRef {
  return isRecord(value)
    && EVIDENCE_SOURCE_KINDS.has(String(value.sourceKind))
    && [
      value.sourceId,
      value.path,
      value.contentHash,
      value.label,
      value.snippet,
    ].every(optionalString)
    && (
      value.redaction === undefined
      || value.redaction === 'none'
      || value.redaction === 'truncated'
      || value.redaction === 'redacted'
    )
    && (
      value.selector === undefined
      || (
        isRecord(value.selector)
        && SELECTOR_KINDS.has(String(value.selector.selectorKind))
        && typeof value.selector.value === 'string'
      )
    );
}

function optionalEnum(value: unknown, values: Set<string>): boolean {
  return value === undefined || values.has(String(value));
}

function optionalRate(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

function isFiniteMetric(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) && value.every(nonEmptyString)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

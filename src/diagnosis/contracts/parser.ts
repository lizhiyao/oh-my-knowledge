import type {
  Diagnosis,
  DiagnosisBundle,
  DiagnosisEvidenceRef,
  DiagnosisOccurrence,
} from '../contracts.js';
import { isRfc3339Timestamp } from '../../shared/timestamp.js';

const DIAGNOSIS_TYPES = new Set([
  'definition_gap',
  'runtime_issue',
  'user_feedback_pattern',
  'eval_failure',
  'sample_design_issue',
  'doctor_gap',
  'standard_candidate',
  'maintenance_issue',
]);
const DIAGNOSIS_SEVERITIES = new Set(['high', 'medium', 'low', 'info']);
const DIAGNOSIS_AUDIENCES = new Set(['skill-author', 'sample-author', 'omk-maintainer', 'reviewer']);
const DIAGNOSIS_LIFECYCLES = new Set(['detected', 'candidate', 'confirmed', 'rejected', 'resolved', 'stale']);
const DIAGNOSIS_SCOPES = new Set(['skill', 'definition', 'session', 'sample']);
const DIAGNOSIS_SOURCES = new Set(['observe', 'doctor', 'eval']);
const DIAGNOSIS_PRODUCERS = new Set(['deterministic_rule', 'llm_soft', 'manual']);
const DIAGNOSIS_PATCH_TARGETS = new Set([
  'skill',
  'sample-environment',
  'sample-mocks',
  'doctor-rule',
  'definition',
]);

/**
 * Validate the persisted Diagnosis contract before downstream projections use it.
 *
 * Keep this parser independent from observe-inbox: doctor and eval can produce the
 * same source-neutral bundle, and every persistence boundary should share one
 * contract instead of maintaining source-specific casts.
 */
export function parseDiagnosisBundle(value: unknown): DiagnosisBundle | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isTimestamp(value.generatedAt)) return null;
  if (!isSourceCoverage(value.sourceCoverage) || !isRecord(value.bySkill)) return null;

  const diagnosisIds = new Set<string>();
  const stableKeys = new Set<string>();
  const occurrenceIds = new Set<string>();
  for (const [skillName, diagnoses] of Object.entries(value.bySkill)) {
    if (!isNonEmptyString(skillName) || !Array.isArray(diagnoses)) return null;
    for (const diagnosis of diagnoses) {
      if (
        !isDiagnosis(diagnosis, skillName, value.sourceCoverage)
        || diagnosisIds.has(diagnosis.id)
        || stableKeys.has(diagnosis.stableKey)
      ) return null;
      diagnosisIds.add(diagnosis.id);
      stableKeys.add(diagnosis.stableKey);
      for (const occurrence of diagnosis.occurrences) {
        if (occurrenceIds.has(occurrence.id)) return null;
        occurrenceIds.add(occurrence.id);
      }
    }
  }

  return value as unknown as DiagnosisBundle;
}

function isDiagnosis(
  value: unknown,
  skillName: string,
  sourceCoverage: DiagnosisBundle['sourceCoverage'],
): value is Diagnosis {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.stableKey)
    || value.skillName !== skillName
    || !isEnum(value.type, DIAGNOSIS_TYPES)
    || !isNonEmptyString(value.signal)
    || !isNonEmptyString(value.title)
    || !isOptionalString(value.summary)
    || !isEnum(value.severity, DIAGNOSIS_SEVERITIES)
    || !isEnum(value.audience, DIAGNOSIS_AUDIENCES)
    || !isEnum(value.lifecycle, DIAGNOSIS_LIFECYCLES)
    || !isScope(value.scope, skillName)
    || !Array.isArray(value.occurrences)
    || !isNonNegativeInteger(value.occurrenceCount)
    || value.occurrenceCount < value.occurrences.length
    || !isOptionalString(value.evidenceSummary)
    || !isOptionalString(value.recommendation)
    || !isOptionalString(value.command)
    || !isOptionalPatch(value.patch)
  ) return false;

  const occurrenceIds = new Set<string>();
  const stableKey = value.stableKey;
  return value.occurrences.every((occurrence) => {
    if (
      !isOccurrence(occurrence, stableKey, sourceCoverage)
      || occurrenceIds.has(occurrence.id)
    ) return false;
    occurrenceIds.add(occurrence.id);
    return true;
  });
}

function isScope(value: unknown, skillName: string): boolean {
  if (!isRecord(value) || !isEnum(value.primary, DIAGNOSIS_SCOPES) || !isRecord(value.refs)) return false;
  const refs = value.refs;
  if (refs.skillName !== skillName) return false;
  return [
    'traceId',
    'sessionId',
    'invocationId',
    'sampleId',
    'ruleId',
    'workflowId',
    'sourceTrace',
  ].every((key) => isOptionalString(refs[key]));
}

function isOccurrence(
  value: unknown,
  stableKey: string,
  sourceCoverage: DiagnosisBundle['sourceCoverage'],
): value is DiagnosisOccurrence {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id)
    || value.diagnosisStableKey !== stableKey
    || !isEnum(value.source, DIAGNOSIS_SOURCES)
    || sourceCoverage[value.source as keyof typeof sourceCoverage] !== true
    || !isNonEmptyString(value.sourceId)
    || !isNonEmptyString(value.sourceKind)
    || !isOptionalTimestamp(value.timestamp)
    || !isOptionalEnum(value.severity, DIAGNOSIS_SEVERITIES)
    || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.every(isEvidenceRef)
    || !isOptionalString(value.rawRef)
    || !isEnum(value.producer, DIAGNOSIS_PRODUCERS)
    || (value.payload !== undefined && !isRecord(value.payload))
  ) return false;
  return true;
}

function isEvidenceRef(value: unknown): value is DiagnosisEvidenceRef {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.kind)) return false;
  if (
    ![
      'traceId',
      'sourceTrace',
      'sessionId',
      'messageUuid',
      'toolUseId',
      'label',
      'snippet',
    ].every((key) => isOptionalString(value[key]))
    || !['messageIndex', 'logicalMessageIndex', 'sourceLineIndex']
      .every((key) => value[key] === undefined || isNonNegativeInteger(value[key]))
    || !isOptionalTimestamp(value.timestamp)
  ) return false;
  return true;
}

function isOptionalPatch(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value)
    && isEnum(value.target, DIAGNOSIS_PATCH_TARGETS)
    && isNonEmptyString(value.location)
    && isNonEmptyString(value.snippet);
}

function isSourceCoverage(value: unknown): value is DiagnosisBundle['sourceCoverage'] {
  return isRecord(value)
    && typeof value.observe === 'boolean'
    && typeof value.doctor === 'boolean'
    && typeof value.eval === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTimestamp(value: unknown): value is string {
  return isRfc3339Timestamp(value);
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEnum(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function isOptionalEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || isEnum(value, allowed);
}

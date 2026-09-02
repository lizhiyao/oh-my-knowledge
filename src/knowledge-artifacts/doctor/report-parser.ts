import type {
  DoctorReport,
  DoctorRuleResult,
  DoctorSkillStatus,
} from './contracts.js';
import { normalizeRfc3339Timestamp } from '../../shared/timestamp.js';

const RULE_STATUSES = new Set(['pass', 'warn', 'fail', 'skipped']);
const SEVERITIES = new Set(['fatal', 'warn', 'info']);
const SKILL_STATUSES = new Set(['pass', 'warn', 'fail']);
const OUTCOMES = new Set(['passed', 'warnings_only', 'failed']);

/** Parse a persisted doctor report without trusting JSON casts at Studio boundaries. */
export function parseDoctorReport(value: unknown): DoctorReport | null {
  if (
    !isRecord(value)
    || value.kind !== 'doctor'
    || typeof value.schemaVersion !== 'string'
    || value.schemaVersion.length === 0
    || typeof value.id !== 'string'
    || value.id.length === 0
    || normalizeRfc3339Timestamp(value.timestamp) === undefined
    || !allStrings([
      value.cliVersion,
      value.cwd,
      value.executorName,
      value.model,
    ])
    || !Array.isArray(value.skills)
    || !OUTCOMES.has(String(value.outcome))
    || !isCountRecord(value.totals, ['pass', 'warn', 'fail'])
    || !isCountRecord(value.ruleStats, ['pass', 'warn', 'fail', 'skipped', 'total'])
  ) return null;

  const skills = value.skills;
  if (!skills.every(isDoctorSkillReport)) return null;

  const totals = value.totals as Record<string, number>;
  const ruleStats = value.ruleStats as Record<string, number>;
  const expectedTotals = { pass: 0, warn: 0, fail: 0 };
  const expectedRuleStats = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const skill of skills as Array<Record<string, unknown>>) {
    expectedTotals[skill.status as DoctorSkillStatus] += 1;
    for (const result of skill.results as DoctorRuleResult[]) {
      expectedRuleStats[result.status] += 1;
    }
  }
  const ruleTotal = Object.values(expectedRuleStats).reduce((sum, count) => sum + count, 0);
  if (
    !sameCounts(totals, expectedTotals)
    || !sameCounts(ruleStats, expectedRuleStats)
    || ruleStats.total !== ruleTotal
  ) return null;

  const expectedOutcome = totals.fail > 0
    ? 'failed'
    : totals.warn > 0
      ? 'warnings_only'
      : 'passed';
  return value.outcome === expectedOutcome ? value as unknown as DoctorReport : null;
}

function isDoctorSkillReport(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value.skillName !== 'string'
    || value.skillName.length === 0
    || typeof value.skillPath !== 'string'
    || !Array.isArray(value.results)
    || !SKILL_STATUSES.has(String(value.status))
    || !value.results.every(isDoctorRuleResult)
  ) return false;
  return value.status === classifySkillStatus(value.results as DoctorRuleResult[]);
}

function isDoctorRuleResult(value: unknown): boolean {
  return isRecord(value)
    && allStrings([value.ruleId, value.labelKey, value.message])
    && String(value.ruleId).length > 0
    && String(value.labelKey).length > 0
    && SEVERITIES.has(String(value.severity))
    && RULE_STATUSES.has(String(value.status))
    && isNonNegativeNumber(value.durationMs)
    && (value.hint === undefined || typeof value.hint === 'string')
    && (value.groupId === undefined || typeof value.groupId === 'string')
    && (value.detail === undefined || isRecord(value.detail));
}

function classifySkillStatus(results: DoctorRuleResult[]): DoctorSkillStatus {
  if (results.some((result) => result.status === 'fail' && result.severity === 'fatal')) {
    return 'fail';
  }
  if (results.some((result) => result.status === 'warn' || result.status === 'fail')) {
    return 'warn';
  }
  return 'pass';
}

function isCountRecord(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.every((key) => isNonNegativeInteger(value[key]));
}

function sameCounts(
  actual: Record<string, number>,
  expected: Record<string, number>,
): boolean {
  return Object.entries(expected).every(([key, count]) => actual[key] === count);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function allStrings(values: unknown[]): boolean {
  return values.every((value) => typeof value === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

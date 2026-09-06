import _Ajv from 'ajv';
import type { ToolCallInfo } from '../../executors/contracts/trace.js';
import type { SyncAssertionType } from '../inputs/assertion-types.js';
import type { Assertion } from '../inputs/contracts/assertion.js';

const Ajv = _Ajv.default ?? _Ajv;

type JsonSchemaValidator = (
  data: unknown,
  schema: Record<string, unknown>,
) => boolean;

export const DETERMINISTIC_ASSERTION_ALGORITHM_VERSION =
  'omk.deterministic-assertions/v1' as const;

export interface DeterministicAssertionContext {
  readonly costUSD?: number;
  readonly durationMs?: number;
  readonly numTurns?: number;
  readonly toolCalls?: readonly ToolCallInfo[];
  readonly mockStats?: {
    readonly hits: number;
    readonly misses: number;
    readonly perMock: Readonly<Record<string, number>>;
  };
}

export const OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES = [
  'contains',
  'not_contains',
  'regex',
  'min_length',
  'max_length',
  'json_valid',
  'json_schema',
  'starts_with',
  'ends_with',
  'equals',
  'not_equals',
  'word_count_min',
  'word_count_max',
  'contains_all',
  'contains_any',
  'rouge_n_min',
  'levenshtein_max',
  'bleu_min',
  'assert-set',
] as const satisfies readonly SyncAssertionType[];

export const EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES = [
  'cost_max',
  'latency_max',
  'turns_max',
  'turns_min',
  'tools_called',
  'tools_not_called',
  'tools_count_max',
  'tools_count_min',
  'tool_output_contains',
  'tool_input_contains',
  'tool_input_not_contains',
  'mock_hit',
] as const satisfies readonly SyncAssertionType[];

export const OUTPUT_ONLY_SYNC_ASSERTION_TYPES: ReadonlySet<string> = new Set(
  OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES,
);

export const EXECUTION_AWARE_SYNC_ASSERTION_TYPES: ReadonlySet<string> = new Set(
  EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES,
);

export type DeterministicAssertionInputSourceKind =
  | 'output'
  | 'execution-facts'
  | 'trace';

const EXECUTION_FACT_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  'cost_max',
  'latency_max',
]);

/** Returns the least-authority source union required by an assertion tree. */
export function deterministicAssertionInputSourceKinds(
  assertion: Assertion,
): readonly DeterministicAssertionInputSourceKind[] {
  const sources = new Set<DeterministicAssertionInputSourceKind>();
  const collect = (candidate: Assertion): void => {
    if (candidate.type === 'assert-set') {
      for (const child of candidate.children ?? []) collect(child);
      return;
    }
    if (OUTPUT_ONLY_SYNC_ASSERTION_TYPES.has(candidate.type)) {
      sources.add('output');
      return;
    }
    if (EXECUTION_FACT_ASSERTION_TYPES.has(candidate.type)) {
      sources.add('execution-facts');
      return;
    }
    if (EXECUTION_AWARE_SYNC_ASSERTION_TYPES.has(candidate.type)) sources.add('trace');
  };
  collect(assertion);
  return Object.freeze([
    ...(['output', 'execution-facts', 'trace'] as const).filter((source) => sources.has(source)),
  ]);
}

export function ratioToScore(ratio: number): number {
  return Number((1 + ratio * 4).toFixed(2));
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+|[一-龥]/g) ?? [];
}

function ngrams(tokens: readonly string[], n: number): string[] {
  if (n <= 0 || tokens.length < n) return [];
  const result = new Array<string>(tokens.length - n + 1);
  for (let index = 0; index <= tokens.length - n; index += 1) {
    result[index] = tokens.slice(index, index + n).join(' ');
  }
  return result;
}

function clippedOverlap(candidate: readonly string[], reference: readonly string[]): number {
  if (candidate.length === 0 || reference.length === 0) return 0;
  const candidateCounts = new Map<string, number>();
  const referenceCounts = new Map<string, number>();
  for (const value of candidate) {
    candidateCounts.set(value, (candidateCounts.get(value) ?? 0) + 1);
  }
  for (const value of reference) {
    referenceCounts.set(value, (referenceCounts.get(value) ?? 0) + 1);
  }
  let total = 0;
  for (const [value, count] of candidateCounts) {
    total += Math.min(count, referenceCounts.get(value) ?? 0);
  }
  return total;
}

export function rougeN(candidate: string, reference: string, n: number): number {
  const candidateNgrams = ngrams(tokenize(candidate), n);
  const referenceNgrams = ngrams(tokenize(reference), n);
  if (referenceNgrams.length === 0) return 0;
  return clippedOverlap(candidateNgrams, referenceNgrams) / referenceNgrams.length;
}

export function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let a = left;
  let b = right;
  if (a.length < b.length) [a, b] = [b, a];
  const rows = b.length;
  let previous = new Array<number>(rows + 1);
  let current = new Array<number>(rows + 1);
  for (let column = 0; column <= rows; column += 1) previous[column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= rows; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[rows];
}

export function bleu(candidate: string, reference: string, maxN = 4): number {
  const candidateTokens = tokenize(candidate);
  const referenceTokens = tokenize(reference);
  if (candidateTokens.length === 0 || referenceTokens.length === 0) return 0;
  let logSum = 0;
  for (let n = 1; n <= maxN; n += 1) {
    const candidateNgrams = ngrams(candidateTokens, n);
    const referenceNgrams = ngrams(referenceTokens, n);
    if (candidateNgrams.length === 0) return 0;
    const overlap = clippedOverlap(candidateNgrams, referenceNgrams);
    if (overlap === 0) return 0;
    logSum += Math.log(overlap / candidateNgrams.length);
  }
  const brevityPenalty = candidateTokens.length >= referenceTokens.length
    ? 1
    : Math.exp(1 - referenceTokens.length / candidateTokens.length);
  return brevityPenalty * Math.exp(logSum / maxN);
}

function validateJsonSchemaWith(
  validator: InstanceType<typeof Ajv>,
  data: unknown,
  schema: Record<string, unknown>,
): boolean {
  if (!schema || typeof schema !== 'object') return true;
  try {
    const validate = validator.compile(schema);
    return validate(data) as boolean;
  } catch {
    return false;
  }
}

function evaluateRaw(
  output: string,
  assertion: Assertion,
  context: Required<Pick<DeterministicAssertionContext, 'toolCalls'>>
    & DeterministicAssertionContext
    & {
      outputLower: string;
      toolNames: readonly string[];
      validateSchema: JsonSchemaValidator;
    },
): boolean {
  if (assertion.type === 'assert-set') {
    const children = assertion.children ?? [];
    if (children.length === 0) return false;
    const childPasses = children.map((child) => {
      const raw = evaluateRaw(output, child, context);
      return child.not ? !raw : raw;
    });
    return (assertion.mode ?? 'all') === 'any'
      ? childPasses.some(Boolean)
      : childPasses.every(Boolean);
  }

  switch (assertion.type) {
    case 'contains':
      return context.outputLower.includes(String(assertion.value).toLowerCase());
    case 'not_contains':
      return !context.outputLower.includes(String(assertion.value).toLowerCase());
    case 'regex':
      return new RegExp(assertion.pattern!, assertion.flags || 'i').test(output);
    case 'min_length': return output.length >= (assertion.value as number);
    case 'max_length': return output.length <= (assertion.value as number);
    case 'json_valid':
      try { JSON.parse(output); return true; } catch { return false; }
    case 'json_schema':
      try { return context.validateSchema(JSON.parse(output), assertion.schema!); } catch { return false; }
    case 'starts_with':
      return context.outputLower.startsWith(String(assertion.value).toLowerCase());
    case 'ends_with':
      return context.outputLower.endsWith(String(assertion.value).toLowerCase());
    case 'equals': return output.trim() === String(assertion.value).trim();
    case 'not_equals': return output.trim() !== String(assertion.value).trim();
    case 'word_count_min':
      return output.split(/\s+/).filter(Boolean).length >= (assertion.value as number);
    case 'word_count_max':
      return output.split(/\s+/).filter(Boolean).length <= (assertion.value as number);
    case 'contains_all':
      return (assertion.values ?? []).every(
        (value) => context.outputLower.includes(value.toLowerCase()),
      );
    case 'contains_any':
      return (assertion.values ?? []).some(
        (value) => context.outputLower.includes(value.toLowerCase()),
      );
    case 'cost_max': return (context.costUSD ?? Infinity) <= (assertion.value as number);
    case 'latency_max':
      return (context.durationMs ?? Infinity) <= (assertion.value as number);
    case 'turns_max': return (context.numTurns ?? Infinity) <= (assertion.value as number);
    case 'turns_min': return (context.numTurns ?? 0) >= (assertion.value as number);
    case 'tools_called':
      return (assertion.values ?? []).every(
        (value) => context.toolNames.includes(value.toLowerCase()),
      );
    case 'tools_not_called':
      return (assertion.values ?? []).every(
        (value) => !context.toolNames.includes(value.toLowerCase()),
      );
    case 'tools_count_max': return context.toolCalls.length <= (assertion.value as number);
    case 'tools_count_min': return context.toolCalls.length >= (assertion.value as number);
    case 'tool_output_contains': {
      const separator = String(assertion.value).indexOf(':');
      if (separator <= 0) return false;
      const tool = String(assertion.value).slice(0, separator).toLowerCase();
      const expected = String(assertion.value).slice(separator + 1).toLowerCase();
      return context.toolCalls.some((call) => (
        call.tool.toLowerCase() === tool
        && String(call.output || '').toLowerCase().includes(expected)
      ));
    }
    case 'tool_input_contains':
    case 'tool_input_not_contains': {
      const separator = String(assertion.value).indexOf(':');
      if (separator <= 0) return assertion.type === 'tool_input_not_contains';
      const tool = String(assertion.value).slice(0, separator).toLowerCase();
      const expected = String(assertion.value).slice(separator + 1).toLowerCase();
      const found = context.toolCalls.some((call) => (
        call.tool.toLowerCase() === tool
        && JSON.stringify(call.input || '').toLowerCase().includes(expected)
      ));
      return assertion.type === 'tool_input_not_contains' ? !found : found;
    }
    case 'mock_hit': {
      const hits = context.mockStats?.perMock[String(assertion.value)] ?? 0;
      return context.mockStats !== undefined && hits >= (assertion.threshold ?? 1);
    }
    case 'rouge_n_min':
      return rougeN(output, String(assertion.reference ?? assertion.value ?? ''), assertion.n ?? 1)
        >= (assertion.threshold ?? 0.5);
    case 'levenshtein_max':
      return levenshtein(output, String(assertion.reference ?? assertion.value ?? ''))
        <= (assertion.value as number ?? Infinity);
    case 'bleu_min':
      return bleu(output, String(assertion.reference ?? assertion.value ?? ''))
        >= (assertion.threshold ?? 0.5);
    default: return false;
  }
}

/** Creates an evaluator whose schema compilation has no cross-criterion, record, or run state. */
export function createIsolatedDeterministicAssertionEvaluator(): (
  output: string,
  assertion: Assertion,
  context?: DeterministicAssertionContext,
) => boolean {
  const validateSchema: JsonSchemaValidator = (data, schema) => (
    validateJsonSchemaWith(new Ajv(), data, schema)
  );
  return (output, assertion, context = {}) => {
    const toolCalls = [...(context.toolCalls ?? [])];
    const raw = evaluateRaw(output, assertion, {
      ...context,
      toolCalls,
      outputLower: output.toLowerCase(),
      toolNames: toolCalls.map((call) => call.tool.toLowerCase()),
      validateSchema,
    });
    return assertion.not ? !raw : raw;
  };
}

export function assertionUsesOnlyOutput(assertion: Assertion): boolean {
  if (!OUTPUT_ONLY_SYNC_ASSERTION_TYPES.has(assertion.type)) return false;
  return assertion.type !== 'assert-set'
    || (assertion.children ?? []).every(assertionUsesOnlyOutput);
}

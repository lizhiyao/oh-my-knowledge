import { isJsonValue } from './json-value.js';
import {
  ASYNC_ASSERTION_TYPES,
  SUPPORTED_ASSERTION_TYPES,
} from './assertion-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const STRING_VALUE_ASSERTIONS = new Set([
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'equals',
  'not_equals',
  'tool_output_contains',
  'tool_input_contains',
  'tool_input_not_contains',
  'mock_hit',
]);

const NUMBER_VALUE_ASSERTIONS = new Set([
  'min_length',
  'max_length',
  'word_count_min',
  'word_count_max',
  'cost_max',
  'latency_max',
  'turns_max',
  'turns_min',
  'tools_count_max',
  'tools_count_min',
  'levenshtein_max',
]);

const NON_NEGATIVE_VALUE_ASSERTIONS = new Set([
  ...NUMBER_VALUE_ASSERTIONS,
]);

const STRING_VALUES_ASSERTIONS = new Set([
  'contains_all',
  'contains_any',
  'tools_called',
  'tools_not_called',
]);

const REFERENCE_ASSERTIONS = new Set([
  'semantic_similarity',
  'rouge_n_min',
  'levenshtein_max',
  'bleu_min',
]);

export function assertionContractValidationError(
  value: unknown,
  depth = 0,
  insideAssertSet = false,
): string | undefined {
  if (depth >= 16) return 'assertion nesting exceeds 16 levels';
  if (!isRecord(value)) return 'assertion must be an object';
  if (!isNonEmptyString(value.type)) return 'assertion "type" must be a non-empty string';
  if (!SUPPORTED_ASSERTION_TYPES.has(value.type)) {
    return `unsupported assertion type: ${JSON.stringify(value.type)}`;
  }
  if (insideAssertSet && ASYNC_ASSERTION_TYPES.has(value.type)) {
    return `async assertion type ${JSON.stringify(value.type)} cannot be nested in "assert-set"`;
  }
  if (
    value.value !== undefined
    && typeof value.value !== 'string'
    && !isFiniteNumber(value.value)
  ) return '"value" must be a finite number or string when present';
  if (value.values !== undefined && !isStringArray(value.values)) {
    return '"values" must be an array of non-empty strings when present';
  }
  if (value.pattern !== undefined && typeof value.pattern !== 'string') {
    return '"pattern" must be a string when present';
  }
  if (value.flags !== undefined && typeof value.flags !== 'string') {
    return '"flags" must be a string when present';
  }
  if (
    value.schema !== undefined
    && (!isRecord(value.schema) || !isJsonValue(value.schema))
  ) return '"schema" must be a JSON object when present';
  if (value.weight !== undefined && (!isFiniteNumber(value.weight) || value.weight <= 0)) {
    return '"weight" must be a positive finite number when present';
  }
  if (value.fn !== undefined && typeof value.fn !== 'string') {
    return '"fn" must be a string when present';
  }
  if (value.reference !== undefined && typeof value.reference !== 'string') {
    return '"reference" must be a string when present';
  }
  if (value.threshold !== undefined && !isFiniteNumber(value.threshold)) {
    return '"threshold" must be a finite number when present';
  }
  if (value.not !== undefined && typeof value.not !== 'boolean') {
    return '"not" must be boolean when present';
  }
  if (
    value.mode !== undefined
    && value.mode !== 'any'
    && value.mode !== 'all'
  ) return '"mode" must be "any" or "all" when present';
  if (
    value.n !== undefined
    && (!Number.isSafeInteger(value.n) || (value.n as number) <= 0)
  ) return '"n" must be a positive integer when present';

  if (STRING_VALUE_ASSERTIONS.has(value.type) && !isNonEmptyString(value.value)) {
    return `${JSON.stringify(value.type)} requires a non-empty string "value"`;
  }
  if (NUMBER_VALUE_ASSERTIONS.has(value.type) && !isFiniteNumber(value.value)) {
    return `${JSON.stringify(value.type)} requires a finite numeric "value"`;
  }
  if (
    NON_NEGATIVE_VALUE_ASSERTIONS.has(value.type)
    && isFiniteNumber(value.value)
    && value.value < 0
  ) return `${JSON.stringify(value.type)} requires a non-negative "value"`;
  if (
    STRING_VALUES_ASSERTIONS.has(value.type)
    && (!isStringArray(value.values) || value.values.length === 0)
  ) return `${JSON.stringify(value.type)} requires non-empty string "values"`;
  if (REFERENCE_ASSERTIONS.has(value.type) && !isNonEmptyString(value.reference)) {
    return `${JSON.stringify(value.type)} requires a non-empty "reference"`;
  }
  if (value.type === 'regex') {
    if (typeof value.pattern !== 'string') return '"regex" requires a string "pattern"';
    try {
      new RegExp(value.pattern, typeof value.flags === 'string' ? value.flags : 'i');
    } catch {
      return '"regex" contains an invalid pattern or flags';
    }
  }
  if (value.type === 'json_schema' && (!isRecord(value.schema) || !isJsonValue(value.schema))) {
    return '"json_schema" requires a JSON object "schema"';
  }
  if (value.type === 'custom' && !isNonEmptyString(value.fn)) {
    return '"custom" requires a non-empty "fn"';
  }
  if (
    (value.type === 'rouge_n_min' || value.type === 'bleu_min')
    && value.threshold !== undefined
    && (value.threshold < 0 || value.threshold > 1)
  ) return `${JSON.stringify(value.type)} "threshold" must be within [0, 1]`;
  if (
    (
      value.type === 'semantic_similarity'
      || value.type === 'faithfulness'
      || value.type === 'answer_relevancy'
      || value.type === 'context_recall'
    )
    && value.threshold !== undefined
    && (value.threshold < 1 || value.threshold > 5)
  ) return `${JSON.stringify(value.type)} "threshold" must be within [1, 5]`;
  if (
    value.type === 'mock_hit'
    && typeof value.value === 'string'
    && !/^[^:]+:[1-9]\d*$/.test(value.value)
  ) return '"mock_hit" value must use "Tool:N" with a positive 1-based ordinal';
  if (
    value.type === 'assert-set'
    && (!Array.isArray(value.children) || value.children.length === 0)
  ) return '"assert-set" requires non-empty "children"';
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return '"children" must be an array when present';
    for (const [index, child] of value.children.entries()) {
      const error = assertionContractValidationError(child, depth + 1, value.type === 'assert-set');
      if (error) return `children[${index}]: ${error}`;
    }
  }
  return undefined;
}

function isMockReturn(value: unknown): boolean {
  return typeof value === 'string'
    || (isRecord(value) && isJsonValue(value));
}

function mockValidationError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'mock must be an object';
  if (!isNonEmptyString(value.tool)) return '"tool" must be a non-empty string';
  if (value.return !== undefined && !isMockReturn(value.return)) {
    return '"return" must be a string or JSON object';
  }
  if (value.return_file !== undefined && !isNonEmptyString(value.return_file)) {
    return '"return_file" must be a non-empty string';
  }
  if (
    value.return_seq !== undefined
    && (
      !Array.isArray(value.return_seq)
      || value.return_seq.length === 0
      || !value.return_seq.every(isMockReturn)
    )
  ) return '"return_seq" must be a non-empty array of mock returns';
  const returnSources = [value.return, value.return_file, value.return_seq]
    .filter((candidate) => candidate !== undefined).length;
  if (returnSources !== 1) {
    return 'mock requires exactly one of "return", "return_file", or "return_seq"';
  }
  if (value.match === undefined) return undefined;
  if (!isRecord(value.match)) return '"match" must be an object when present';
  const matchFields = [
    'file_path',
    'file_path_endswith',
    'url',
    'url_glob',
    'command_glob',
    'input_contains',
  ] as const;
  if (!hasOnlyKeys(value.match, [...matchFields, 'input'])) {
    return '"match" contains an unsupported field';
  }
  if (value.match.url !== undefined && value.match.url_glob !== undefined) {
    return '"match.url" and "match.url_glob" are mutually exclusive';
  }
  for (const field of matchFields) {
    if (value.match[field] !== undefined && !isNonEmptyString(value.match[field])) {
      return `"match.${field}" must be a non-empty string when present`;
    }
  }
  if (
    value.match.input !== undefined
    && (!isRecord(value.match.input) || !isJsonValue(value.match.input))
  ) return '"match.input" must be a JSON object when present';
  return undefined;
}

export function sampleMockReferenceKeys(value: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!Array.isArray(value)) return keys;
  const countByTool = new Map<string, number>();
  for (const mock of value) {
    if (!isRecord(mock) || !isNonEmptyString(mock.tool)) continue;
    const ordinal = (countByTool.get(mock.tool) ?? 0) + 1;
    countByTool.set(mock.tool, ordinal);
    keys.add(`${mock.tool}:${ordinal}`);
  }
  return keys;
}

function mockHitReferenceValidationError(
  assertions: unknown,
  mockKeys: ReadonlySet<string>,
): string | undefined {
  if (!Array.isArray(assertions)) return undefined;
  for (const assertion of assertions) {
    if (!isRecord(assertion)) continue;
    if (
      assertion.type === 'mock_hit'
      && typeof assertion.value === 'string'
      && !mockKeys.has(assertion.value)
    ) {
      const available = mockKeys.size > 0 ? [...mockKeys].join(', ') : '(none)';
      return `"mock_hit" references missing mock ${JSON.stringify(assertion.value)}; available mock keys: ${available}`;
    }
    const childError = mockHitReferenceValidationError(assertion.children, mockKeys);
    if (childError) return childError;
  }
  return undefined;
}

export function sampleContractValidationError(
  value: unknown,
  expectedId?: string,
): string | undefined {
  if (!isRecord(value)) return 'sample must be an object';
  if (
    !isNonEmptyString(value.sample_id)
    || (expectedId !== undefined && value.sample_id !== expectedId)
  ) return '"sample_id" must be a non-empty matching string';
  if (!isNonEmptyString(value.prompt)) return '"prompt" must be a non-empty string';
  for (const field of ['cwd', 'rubric', 'context'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return `"${field}" must be a string when present`;
    }
  }
  if (
    value.dimensions !== undefined
    && (
      !isRecord(value.dimensions)
      || !Object.keys(value.dimensions).every(isNonEmptyString)
      || !Object.values(value.dimensions).every(isNonEmptyString)
    )
  ) return '"dimensions" must map non-empty names to non-empty string rubrics';
  if (value.assertions !== undefined) {
    if (!Array.isArray(value.assertions)) return '"assertions" must be an array';
    for (const [index, assertion] of value.assertions.entries()) {
      const error = assertionContractValidationError(assertion);
      if (error) return `"assertions[${index}]": ${error}`;
    }
    for (const assertion of value.assertions) {
      if (
        isRecord(assertion)
        && (assertion.type === 'faithfulness' || assertion.type === 'context_recall')
        && !isNonEmptyString(assertion.reference)
        && !isNonEmptyString(value.context)
      ) {
        return `${JSON.stringify(assertion.type)} requires sample "context" or assertion "reference"`;
      }
    }
  }
  if (value.mocks !== undefined) {
    if (!Array.isArray(value.mocks)) return '"mocks" must be an array';
    for (const [index, mock] of value.mocks.entries()) {
      const error = mockValidationError(mock);
      if (error) return `"mocks[${index}]": ${error}`;
    }
  }
  const mockHitError = mockHitReferenceValidationError(
    value.assertions,
    sampleMockReferenceKeys(value.mocks),
  );
  if (mockHitError) return mockHitError;
  if (value.mocksStrict !== undefined && typeof value.mocksStrict !== 'boolean') {
    return '"mocksStrict" must be boolean when present';
  }
  if (value.mocksStrict !== undefined && !Array.isArray(value.mocks)) {
    return '"mocksStrict" requires a non-empty "mocks" array';
  }
  for (const field of ['allowedTools', 'capability'] as const) {
    if (value[field] !== undefined && !isStringArray(value[field])) {
      return `"${field}" must be an array of non-empty strings`;
    }
  }
  if (
    value.environment !== undefined
    && (
      !isRecord(value.environment)
      || !hasOnlyKeys(value.environment, ['cli_available', 'files_available', 'notes'])
      || (
        value.environment.cli_available !== undefined
        && !isStringArray(value.environment.cli_available)
      )
      || (
        value.environment.files_available !== undefined
        && !isStringArray(value.environment.files_available)
      )
      || (
        value.environment.notes !== undefined
        && typeof value.environment.notes !== 'string'
      )
    )
  ) return '"environment" has an invalid shape';
  if (
    value.difficulty !== undefined
    && value.difficulty !== 'easy'
    && value.difficulty !== 'medium'
    && value.difficulty !== 'hard'
  ) return '"difficulty" has an unsupported value';
  if (value.construct !== undefined && typeof value.construct !== 'string') {
    return '"construct" must be string when present';
  }
  if (
    value.provenance !== undefined
    && value.provenance !== 'human'
    && value.provenance !== 'llm-generated'
    && value.provenance !== 'production-trace'
  ) return '"provenance" has an unsupported value';
  if (value.tripwire !== undefined && typeof value.tripwire !== 'boolean') {
    return '"tripwire" must be boolean when present';
  }
  if (value.covers === undefined) return undefined;
  const targetKinds = new Set([
    'skill',
    'skill_file',
    'frontmatter',
    'reference',
    'script',
    'hard_rule',
    'workflow',
    'workflow_node',
  ]);
  return Array.isArray(value.covers)
    && value.covers.every((target) =>
      isRecord(target)
      && typeof target.targetKind === 'string'
      && targetKinds.has(target.targetKind)
      && isNonEmptyString(target.ref)
    )
    ? undefined
    : '"covers" contains an invalid coverage target';
}

export const SYNC_ASSERTION_TYPE_NAMES = [
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
  'rouge_n_min',
  'levenshtein_max',
  'bleu_min',
  'assert-set',
] as const;

export const ASYNC_ASSERTION_TYPE_NAMES = [
  'semantic_similarity',
  'custom',
  'faithfulness',
  'answer_relevancy',
  'context_recall',
] as const;

export type SyncAssertionType = typeof SYNC_ASSERTION_TYPE_NAMES[number];
export type AsyncAssertionType = typeof ASYNC_ASSERTION_TYPE_NAMES[number];
export type SupportedAssertionType = SyncAssertionType | AsyncAssertionType;

export const SYNC_ASSERTION_TYPES: ReadonlySet<string> = new Set(SYNC_ASSERTION_TYPE_NAMES);
export const ASYNC_ASSERTION_TYPES: ReadonlySet<string> = new Set(ASYNC_ASSERTION_TYPE_NAMES);
export const SUPPORTED_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  ...SYNC_ASSERTION_TYPE_NAMES,
  ...ASYNC_ASSERTION_TYPE_NAMES,
]);

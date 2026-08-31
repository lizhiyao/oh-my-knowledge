import type { Assertion } from '../../types/index.js';

/** Leaf assertion construct classification. `assert-set` is resolved from its leaves. */
export const ASSERTION_LAYER: Readonly<Record<string, 'fact' | 'behavior'>> = Object.freeze({
  contains: 'fact',
  not_contains: 'fact',
  regex: 'fact',
  json_valid: 'fact',
  json_schema: 'fact',
  equals: 'fact',
  not_equals: 'fact',
  contains_all: 'fact',
  contains_any: 'fact',
  semantic_similarity: 'fact',
  tool_output_contains: 'fact',
  tool_input_contains: 'fact',
  tool_input_not_contains: 'fact',
  rouge_n_min: 'fact',
  bleu_min: 'fact',
  levenshtein_max: 'fact',
  faithfulness: 'fact',
  answer_relevancy: 'fact',
  context_recall: 'fact',
  starts_with: 'behavior',
  ends_with: 'behavior',
  min_length: 'behavior',
  max_length: 'behavior',
  word_count_min: 'behavior',
  word_count_max: 'behavior',
  cost_max: 'behavior',
  latency_max: 'behavior',
  turns_min: 'behavior',
  turns_max: 'behavior',
  tools_called: 'behavior',
  tools_not_called: 'behavior',
  tools_count_min: 'behavior',
  tools_count_max: 'behavior',
  custom: 'behavior',
  mock_hit: 'behavior',
});

/** Mixed, empty, or unknown assertion sets deliberately have no layer. */
export function resolveAssertionLayer(
  assertion: Assertion,
): 'fact' | 'behavior' | undefined {
  const layers = new Set<'fact' | 'behavior' | 'unknown'>();
  const collect = (candidate: Assertion): void => {
    if (candidate.type === 'assert-set') {
      for (const child of candidate.children ?? []) collect(child);
      return;
    }
    layers.add(ASSERTION_LAYER[candidate.type] ?? 'unknown');
  };
  collect(assertion);
  if (layers.size !== 1) return undefined;
  const [only] = [...layers];
  return only === 'unknown' ? undefined : only;
}

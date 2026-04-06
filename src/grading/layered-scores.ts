import type { AssertionDetail, LayeredScores } from '../types.js';

const FACTUAL_ASSERTION_TYPES = new Set([
  'contains',
  'not_contains',
  'regex',
  'json_valid',
  'json_schema',
  'equals',
  'not_equals',
  'contains_all',
  'contains_any',
  'semantic_similarity',
  'tool_output_contains',
  'tool_input_contains',
]);

const BEHAVIORAL_ASSERTION_TYPES = new Set([
  'starts_with',
  'ends_with',
  'min_length',
  'max_length',
  'word_count_min',
  'word_count_max',
  'cost_max',
  'latency_max',
  'turns_min',
  'turns_max',
  'tools_called',
  'tools_not_called',
  'tools_count_min',
  'tools_count_max',
  'custom',
]);

function ratioToScore(ratio: number): number {
  return Number((1 + ratio * 4).toFixed(2));
}

function scoreFromDetails(details: AssertionDetail[]): number | null {
  if (details.length === 0) return null;
  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  if (totalWeight === 0) return null;
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  return ratioToScore(passedWeight / totalWeight);
}

interface CompositeInput {
  assertions?: { details?: AssertionDetail[] };
  llmScore?: number;
}

export function computeLayeredScores(results: CompositeInput): { compositeScore: number; layeredScores: LayeredScores } {
  const layered: LayeredScores = {};

  if (results.assertions?.details) {
    const factDetails = results.assertions.details.filter((d) => FACTUAL_ASSERTION_TYPES.has(d.type));
    const behaviorDetails = results.assertions.details.filter((d) => BEHAVIORAL_ASSERTION_TYPES.has(d.type));
    layered.factScore = scoreFromDetails(factDetails) ?? undefined;
    layered.behaviorScore = scoreFromDetails(behaviorDetails) ?? undefined;
  }

  if (typeof results.llmScore === 'number' && results.llmScore > 0) {
    layered.qualityScore = results.llmScore;
  }

  const scores = [layered.factScore, layered.behaviorScore, layered.qualityScore].filter((s): s is number => s != null && s > 0);
  const compositeScore = scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;

  return { compositeScore, layeredScores: layered };
}

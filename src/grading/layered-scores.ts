import type { AssertionDetail, LayeredScores } from '../types/index.js';

/**
 * 每个 assertion 类型归到事实层 / 行为层。**单一来源**:`computeLayeredScores` 据此把 assertion 明细拆进
 * fact / behavior 两层算分。
 *   - **事实层(fact)**:测输出内容对不对 —— 命中 / 匹配 / 结构合法 / 与参考的文本相似度。
 *   - **行为层(behavior)**:测做事的方式 —— 长度 / 成本 / 轮次 / 工具调用 / 必经里程碑,不看内容本身。
 *
 * 不变量:**runner 支持的每个 assertion 类型都必须能被归层**,否则该类型的 pass/fail 会被 computeLayeredScores
 * 从 fact 与 behavior 同时漏掉 —— 既不报错也不进 composite,静默丢分(曾漏掉七类:mock_hit / rouge_n_min /
 * bleu_min / levenshtein_max + RAG 三件套 faithfulness / answer_relevancy / context_recall)。叶子断言在此静态
 * 分类;组合器 `assert-set` 没有静态层,由 `assertions.ts` 的 resolveAssertSetLayer 在 grading 期按其叶子 children
 * 解析(同层→归层、混层→不计),结果落 detail.layer。`test/grading/layered-scores-exhaustiveness.test.ts` 扫
 * runner 源(evalAssertion 的 case ∪ `assertion.type ===` 组合器 ∪ ASYNC_ASSERTION_TYPES)守住:新增类型既不在本
 * 映射、又不是已知组合器,即 CI 失败。
 */
export const ASSERTION_LAYER: Record<string, 'fact' | 'behavior'> = {
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
  // 文本相似度指标:衡量输出与参考答案的内容贴合度 = 内容保真 → 事实层。
  rouge_n_min: 'fact',
  bleu_min: 'fact',
  levenshtein_max: 'fact',
  // RAG 评委指标:都评输出内容质量(忠实度 / 答非所问 / 关键事实召回),= 内容正确性 → 事实层。
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
  // 必经工具 / 步骤里程碑(value 形如 "Tool:N"):测"有没有走到那一步" = 做事方式 → 行为层(类同 tools_called)。
  mock_hit: 'behavior',
};

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
    // 优先用 detail.layer(组合器如 assert-set 在 grading 期按 children 解析出的层;混层组合器无 layer → 两层都不计,
    // 见 assertions.ts resolveAssertSetLayer);叶子断言无 layer,退回静态 ASSERTION_LAYER[type]。
    const layerOf = (d: AssertionDetail): 'fact' | 'behavior' | undefined => d.layer ?? ASSERTION_LAYER[d.type];
    const factDetails = results.assertions.details.filter((d) => layerOf(d) === 'fact');
    const behaviorDetails = results.assertions.details.filter((d) => layerOf(d) === 'behavior');
    layered.factScore = scoreFromDetails(factDetails) ?? undefined;
    layered.behaviorScore = scoreFromDetails(behaviorDetails) ?? undefined;
  }

  // 评委分量表是 1-5(见 judge.ts prompt),`score <= 0` 是失败哨兵(非 JSON / parse / executor 错),
  // 是**缺测**不是「0 分内容」—— 当缺层排除,绝不让基础设施失败当内容分污染 composite。上游(grading/index.ts
  // 单评委路径 + 多维度 filter(s>0) + 多轮 validSamples)已保证失败不进 llmScore;这里再 `> 0` 防御一层,
  // 与全管线"0=失败=排除"口径一致(fact/behavior 经 ratioToScore 恒 ≥ 1,有效评委分亦 ≥ 1)。
  if (typeof results.llmScore === 'number' && results.llmScore > 0) {
    layered.judgeScore = results.llmScore;
  }

  const scores = [layered.factScore, layered.behaviorScore, layered.judgeScore].filter((s): s is number => s != null);
  const compositeScore = scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;

  return { compositeScore, layeredScores: layered };
}

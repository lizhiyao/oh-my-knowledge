/**
 * assertion 类型分层穷尽性 gate。
 *
 * `computeLayeredScores` 按 `ASSERTION_LAYER` 把每条 assertion 明细拆进 fact / behavior 两层。runner
 * (`assertions.ts`)支持的某个类型若不在 `ASSERTION_LAYER` 里,它的 pass/fail 会被两层同时漏掉 —— 既不
 * 报错、也不进 composite,静默丢分。曾因此漏掉七类:mock_hit / rouge_n_min / bleu_min / levenshtein_max +
 * RAG 三件套 faithfulness / answer_relevancy / context_recall。
 *
 * 机制:扫 runner 真源拿到"实际支持的全部类型" = evalAssertion 的 `case '<type>':` ∪ ASYNC_ASSERTION_TYPES,
 * 断言每一个都在 `ASSERTION_LAYER` 有分类。新增 case 而忘了分类 → 本测试失败,挡在合并前。
 * 与 `doc-constants-drift.test.ts` 同属"扫源防漂移"一类 gate。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSERTION_LAYER, computeLayeredScores } from '../../src/grading/layered-scores.js';
import { ASYNC_ASSERTION_TYPES } from '../../src/grading/assertions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSERTIONS_SRC = join(__dirname, '..', '..', 'src', 'grading', 'assertions.ts');

/** runner 实际支持的全部 assertion 类型:evalAssertion 的 case 字面量 ∪ 异步类型集。 */
function supportedAssertionTypes(): string[] {
  const src = readFileSync(ASSERTIONS_SRC, 'utf8');
  const syncCases = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  assert.ok(syncCases.length >= 25, `evalAssertion 的 case 没扫到(实得 ${syncCases.length}),正则或源结构可能变了`);
  return [...new Set([...syncCases, ...ASYNC_ASSERTION_TYPES])];
}

describe('assertion 类型分层穷尽性', () => {
  it('runner 支持的每个 assertion 类型都在 ASSERTION_LAYER 分类(fact|behavior),无静默漏层', () => {
    const unclassified = supportedAssertionTypes().filter((t) => ASSERTION_LAYER[t] !== 'fact' && ASSERTION_LAYER[t] !== 'behavior');
    assert.deepEqual(unclassified, [], `这些 runner 支持的类型未分层,会被 computeLayeredScores 静默丢分:${unclassified.join(', ')}`);
  });

  it('曾被漏掉的七类如今进 composite(回归):文本相似度 + RAG 三件套→fact,mock_hit→behavior', () => {
    const detail = (type: string) => ({ type, value: '', weight: 1, passed: true });
    // 文本相似度 + RAG 内容质量都判事实层。
    for (const t of ['rouge_n_min', 'bleu_min', 'levenshtein_max', 'faithfulness', 'answer_relevancy', 'context_recall']) {
      const { layeredScores, compositeScore } = computeLayeredScores({ assertions: { details: [detail(t)] } });
      assert.equal(layeredScores.factScore, 5, `${t} 应进事实层(全通过 → 5)`);
      assert.equal(layeredScores.behaviorScore, undefined, `${t} 不应进行为层`);
      assert.equal(compositeScore, 5, `${t} 应计入 composite,而非被丢成 0`);
    }
    const mock = computeLayeredScores({ assertions: { details: [detail('mock_hit')] } });
    assert.equal(mock.layeredScores.behaviorScore, 5, 'mock_hit 应进行为层');
    assert.equal(mock.layeredScores.factScore, undefined, 'mock_hit 不应进事实层');
    assert.equal(mock.compositeScore, 5, 'mock_hit 应计入 composite');
  });
});

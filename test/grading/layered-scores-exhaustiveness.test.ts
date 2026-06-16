/**
 * assertion 类型分层穷尽性 gate。
 *
 * `computeLayeredScores` 按 `ASSERTION_LAYER` 把每条 assertion 明细拆进 fact / behavior 两层。runner
 * (`assertions.ts`)支持的某个类型若不在 `ASSERTION_LAYER` 里,它的 pass/fail 会被两层同时漏掉 —— 既不
 * 报错、也不进 composite,静默丢分。曾因此漏掉七类:mock_hit / rouge_n_min / bleu_min / levenshtein_max +
 * RAG 三件套 faithfulness / answer_relevancy / context_recall。
 *
 * 机制:扫 runner 真源拿到"实际支持的全部类型" = evalAssertion 的 `case '<type>':` ∪ pre-switch 组合器
 * (`assertion.type === '<type>'`,如 assert-set)∪ ASYNC_ASSERTION_TYPES,断言每一个**要么在 ASSERTION_LAYER
 * 静态分类、要么是已知组合器**(运行时按 children 解析层,见 resolveAssertSetLayer)。新增类型两者都不沾 → 失败,
 * 挡在合并前。曾因只扫 `case` 漏掉 pre-switch 的 assert-set(复审 P2)。与 `doc-constants-drift.test.ts` 同属
 * "扫源防漂移"一类 gate。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSERTION_LAYER, computeLayeredScores } from '../../src/grading/layered-scores.js';
import { ASYNC_ASSERTION_TYPES, runAssertions } from '../../src/grading/assertions.js';
import type { Assertion } from '../../src/types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSERTIONS_SRC = join(__dirname, '..', '..', 'src', 'grading', 'assertions.ts');

/**
 * 组合器类型:无静态层,由 grading 期按 children 解析(resolveAssertSetLayer)。穷尽性 gate 认它们「已处理」,
 * 但仍要求被扫描覆盖(否则又成盲区)。
 */
const LAYER_COMBINATORS = new Set(['assert-set']);

/** runner 实际支持的全部 assertion 类型:case 字面量 ∪ pre-switch 组合器比较 ∪ 异步类型集(含连字符)。 */
function supportedAssertionTypes(): string[] {
  const src = readFileSync(ASSERTIONS_SRC, 'utf8');
  const caseTypes = [...src.matchAll(/case '([a-z_-]+)':/g)].map((m) => m[1]);
  const eqTypes = [...src.matchAll(/assertion\.type === '([a-z_-]+)'/g)].map((m) => m[1]);
  assert.ok(caseTypes.length >= 25, `evalAssertion 的 case 没扫到(实得 ${caseTypes.length}),正则或源结构可能变了`);
  return [...new Set([...caseTypes, ...eqTypes, ...ASYNC_ASSERTION_TYPES])];
}

describe('assertion 类型分层穷尽性', () => {
  it('runner 支持的每个 assertion 类型都能归层(静态分类或已知组合器),无静默漏层', () => {
    const unhandled = supportedAssertionTypes().filter(
      (t) => ASSERTION_LAYER[t] !== 'fact' && ASSERTION_LAYER[t] !== 'behavior' && !LAYER_COMBINATORS.has(t),
    );
    assert.deepEqual(unhandled, [], `这些 runner 支持的类型既未静态分层、又非已知组合器,会被静默丢分:${unhandled.join(', ')}`);
  });

  it('扫描确实抓到了 pre-switch 组合器 assert-set(防回归:复审 P2 的盲区)', () => {
    assert.ok(supportedAssertionTypes().includes('assert-set'), 'assert-set 必须进入待校验集,否则 gate 又有盲区');
  });

  it('assert-set 同层 children → 聚合归该层进 composite;混层 → 不计入分层(无口径偏差)', () => {
    const layered = (a: Assertion) => computeLayeredScores({ assertions: { details: runAssertions('hello world foo', [a]).details } });
    // 同为事实层(contains / equals):归事实层。
    const allFact = layered({ type: 'assert-set', mode: 'all', children: [{ type: 'contains', value: 'hello' }, { type: 'contains', value: 'world' }] });
    assert.equal(allFact.layeredScores.factScore, 5, '同层(fact)assert-set 全通过 → 事实层 5');
    assert.equal(allFact.layeredScores.behaviorScore, undefined, '不应进行为层');
    assert.equal(allFact.compositeScore, 5, '同层 assert-set 必须计入 composite,而非被丢成 0');
    // 同为行为层(min_length / max_length):归行为层。
    const allBehavior = layered({ type: 'assert-set', mode: 'all', children: [{ type: 'min_length', value: 1 }, { type: 'max_length', value: 999 }] });
    assert.equal(allBehavior.layeredScores.behaviorScore, 5, '同层(behavior)assert-set → 行为层 5');
    assert.equal(allBehavior.layeredScores.factScore, undefined, '不应进事实层');
    // 混层(contains=fact + max_length=behavior):不归任何层 → 不计入 composite(无单层可诚实归属)。
    const mixed = layered({ type: 'assert-set', mode: 'all', children: [{ type: 'contains', value: 'hello' }, { type: 'max_length', value: 999 }] });
    assert.equal(mixed.layeredScores.factScore, undefined, '混层 assert-set 不进事实层');
    assert.equal(mixed.layeredScores.behaviorScore, undefined, '混层 assert-set 不进行为层');
    assert.equal(mixed.compositeScore, 0, '混层组合器无单层可归 → 不计入分层(诚实,不塞单层引偏差)');
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

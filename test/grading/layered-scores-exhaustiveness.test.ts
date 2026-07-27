/**
 * assertion 类型分层穷尽性 gate。
 *
 * `computeLayeredScores` 按 `ASSERTION_LAYER` 把每条 assertion 明细拆进 fact / behavior 两层。runner
 * (`assertions.ts`)支持的某个类型若不在 `ASSERTION_LAYER` 里,它的 pass/fail 会被两层同时漏掉 —— 既不
 * 报错、也不进 composite,静默丢分。曾因此漏掉七类:mock_hit / rouge_n_min / bleu_min / levenshtein_max +
 * RAG 三件套 faithfulness / answer_relevancy / context_recall。
 *
 * 机制:从共享注册表 `SUPPORTED_ASSERTION_TYPES` 读取支持的完整集合，断言每一个**要么在
 * ASSERTION_LAYER 静态分类、要么是已知组合器**(运行时按 children 解析层,见 resolveAssertSetLayer)。
 * 新增类型两者都不沾 → 失败,挡在合并前。支持列表不再靠正则扫描 runner 实现细节。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { ASSERTION_LAYER, computeLayeredScores } from '../../src/grading/layered-scores.js';
import { runAssertions } from '../../src/grading/assertions.js';
import { SUPPORTED_ASSERTION_TYPES } from '../../src/shared/assertion-types.js';
import type { Assertion } from '../../src/types/index.js';

/**
 * 组合器类型:无静态层,由 grading 期按 children 解析(resolveAssertSetLayer)。穷尽性 gate 认它们「已处理」,
 * 但仍要求被扫描覆盖(否则又成盲区)。
 */
const LAYER_COMBINATORS = new Set(['assert-set']);

describe('assertion 类型分层穷尽性', () => {
  it('runner 支持的每个 assertion 类型都能归层(静态分类或已知组合器),无静默漏层', () => {
    const unhandled = [...SUPPORTED_ASSERTION_TYPES].filter(
      (t) => ASSERTION_LAYER[t] !== 'fact' && ASSERTION_LAYER[t] !== 'behavior' && !LAYER_COMBINATORS.has(t),
    );
    assert.deepEqual(unhandled, [], `这些 runner 支持的类型既未静态分层、又非已知组合器,会被静默丢分:${unhandled.join(', ')}`);
  });

  it('共享注册表包含组合器 assert-set', () => {
    assert.ok(SUPPORTED_ASSERTION_TYPES.has('assert-set'), 'assert-set 必须进入共享 assertion 类型注册表');
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

  it('detail.layer 契约:仅同层组合器明细带 layer(随报告持久化为归属溯源);叶子 / 混层 / 非组合器一律不带', () => {
    // layer 是 assert-set 唯一的「层」载体(聚合明细是 grading→持久化的同一对象,叶子 children 不单独成明细),
    // 故有意落到 detail 上。本用例钉死它「只在同层组合器明细出现」的契约,把它从偶发字段变成受测的对外 schema 面。
    const layerOfFirst = (a: Assertion): unknown => runAssertions('hello world', [a]).details[0].layer;
    assert.equal(layerOfFirst({ type: 'assert-set', mode: 'all', children: [{ type: 'contains', value: 'hello' }, { type: 'contains', value: 'world' }] }), 'fact', '同层(fact)组合器 → layer=fact');
    assert.equal(layerOfFirst({ type: 'assert-set', mode: 'all', children: [{ type: 'min_length', value: 1 }, { type: 'max_length', value: 99 }] }), 'behavior', '同层(behavior)组合器 → layer=behavior');
    assert.equal(layerOfFirst({ type: 'assert-set', mode: 'all', children: [{ type: 'contains', value: 'hello' }, { type: 'max_length', value: 99 }] }), undefined, '混层组合器 → 不带 layer(交由静态映射,而它无 assert-set 条目 → 不计)');
    assert.equal(layerOfFirst({ type: 'contains', value: 'hello' }), undefined, '叶子断言绝不带 layer(按静态 ASSERTION_LAYER 归层)');
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

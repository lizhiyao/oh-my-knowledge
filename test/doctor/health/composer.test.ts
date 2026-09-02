import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  makeSkillHealthComposer,
  SKILL_HEALTH_COMPOSER_ID,
  type ExecutorFactory,
} from '../../../src/doctor/health/composer.js';
import {
  registerHealthDimension,
  __resetHealthDimensionsForTest,
} from '../../../src/doctor/health/dimension-registry.js';
import type { Artifact } from '../../../src/knowledge-artifacts/contracts.js';
import type { ExecutorFn } from '../../../src/executors/contracts/ports.js';
import type { ExecResult } from '../../../src/executors/contracts/result.js';
import type { DoctorContext } from '../../../src/doctor/contracts.js';
import type { HealthDimensionSpec } from '../../../src/doctor/health/dimension-spec.js';

const stubDim = (id: string, severity: 'fatal' | 'warn' | 'info' = 'warn'): HealthDimensionSpec => ({
  id,
  displayName: id,
  labelKey: `cli.doctor.health.dim.${id}`,
  severity,
  promptSection: `${id} prompt`,
});

function ctxWith(artifact: Artifact, overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    artifact,
    executorName: 'mock',
    model: 'sonnet',
    cwd: '/tmp',
    lang: 'zh',
    timeoutMs: 60000,
    runHealthCheck: true,
    ...overrides,
  };
}

const sampleSkill = (overrides: Partial<Artifact> = {}): Artifact => ({
  name: 'sample',
  kind: 'skill',
  source: 'file-path',
  content: '你是一个测试 skill 助手,负责简短回答用户问题,不超过 200 字。',
  ...overrides,
});

function mockExecutor(output: string, opts: Partial<ExecResult> = {}): ExecutorFn {
  return async () => ({
    ok: true,
    output,
    durationMs: 10,
    durationApiMs: 10,
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0, stopReason: 'end_turn', numTurns: 1,
    ...opts,
  });
}

const factory = (exec: ExecutorFn): ExecutorFactory => () => exec;

function buildLlmReport(opts: {
  dims: Array<{ id: string; level: '健康' | '亚健康' | '不健康' | '不适用'; findings?: Array<{ level: '错误' | '警告' | '建议' }> }>;
  overall?: '良好' | '部分缺陷' | '严重缺陷';
  topSuggestions?: string[];
}): string {
  return JSON.stringify({
    skill_name: 'sample',
    feature_points: [],
    checklist: opts.dims.map((d) => ({
      dim_id: d.id,
      level: d.level,
      findings: (d.findings ?? []).map((f) => ({
        level: f.level, subtype: '', evidence: 'L1', description: 'desc',
      })),
      suggestions: [],
    })),
    summary: {
      overall_health: opts.overall ?? '良好',
      top_suggestions: opts.topSuggestions ?? [],
    },
  });
}

describe('skill_health composer', () => {
  beforeEach(() => __resetHealthDimensionsForTest());

  it('returns single skipped outcome when runHealthCheck=false', async () => {
    registerHealthDimension(stubDim('a'));
    const composer = makeSkillHealthComposer(factory(mockExecutor('{}')));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { runHealthCheck: false }));
    assert.equal(out.length, 1);
    assert.equal(out[0].subId, '_summary');
    assert.equal(out[0].status, 'skipped');
  });

  it('returns single skipped outcome when no dimensions registered', async () => {
    const composer = makeSkillHealthComposer(factory(mockExecutor('{}')));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    assert.equal(out.length, 1);
    assert.equal(out[0].subId, '_summary');
    assert.equal(out[0].status, 'skipped');
  });

  it('returns single skipped outcome when artifact.content empty', async () => {
    registerHealthDimension(stubDim('a'));
    const composer = makeSkillHealthComposer(factory(mockExecutor('{}')));
    const out = await composer.checkAll(ctxWith(sampleSkill({ content: null })));
    assert.equal(out.length, 1);
    assert.equal(out[0].subId, '_summary');
    assert.equal(out[0].status, 'skipped');
  });

  it('produces N+1 outcomes (N dims + 1 summary) for full run', async () => {
    registerHealthDimension(stubDim('a'));
    registerHealthDimension(stubDim('b'));
    registerHealthDimension(stubDim('c'));
    const llm = buildLlmReport({
      dims: [
        { id: 'a', level: '健康' },
        { id: 'b', level: '亚健康', findings: [{ level: '警告' }] },
        { id: 'c', level: '不健康', findings: [{ level: '错误' }] },
      ],
      overall: '严重缺陷',
      topSuggestions: ['fix1', 'fix2'],
    });
    const composer = makeSkillHealthComposer(factory(mockExecutor(llm)));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    assert.equal(out.length, 4);
    const dimOutcomes = out.filter((o) => o.subId !== '_summary');
    const summary = out.find((o) => o.subId === '_summary');
    assert.equal(dimOutcomes.length, 3);
    assert.ok(summary);
  });

  it('maps dim levels to status: 不健康→fail, 亚健康→warn, 健康→pass, 不适用→skipped', async () => {
    registerHealthDimension(stubDim('a'));
    registerHealthDimension(stubDim('b'));
    registerHealthDimension(stubDim('c'));
    registerHealthDimension(stubDim('d'));
    const llm = buildLlmReport({
      dims: [
        { id: 'a', level: '不健康', findings: [{ level: '错误' }] },
        { id: 'b', level: '亚健康', findings: [{ level: '警告' }] },
        { id: 'c', level: '健康' },
        { id: 'd', level: '不适用' },
      ],
    });
    const composer = makeSkillHealthComposer(factory(mockExecutor(llm)));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    const map = new Map(out.map((o) => [o.subId, o.status]));
    assert.equal(map.get('a'), 'fail');
    assert.equal(map.get('b'), 'warn');
    assert.equal(map.get('c'), 'pass');
    assert.equal(map.get('d'), 'skipped');
  });

  it('marks outcome as skipped + missing message when LLM omits a dim', async () => {
    registerHealthDimension(stubDim('a'));
    registerHealthDimension(stubDim('b'));
    // LLM 只输出 a,漏报 b
    const llm = buildLlmReport({ dims: [{ id: 'a', level: '健康' }] });
    const composer = makeSkillHealthComposer(factory(mockExecutor(llm)));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    const bOutcome = out.find((o) => o.subId === 'b');
    assert.ok(bOutcome);
    assert.equal(bOutcome!.status, 'skipped');
    assert.equal((bOutcome!.detail as { missing?: boolean }).missing, true);
  });

  it('uses dim.severity for outcome (lets fatal dims fail doctor outcome)', async () => {
    registerHealthDimension(stubDim('crit', 'fatal'));
    registerHealthDimension(stubDim('soft', 'warn'));
    const llm = buildLlmReport({
      dims: [
        { id: 'crit', level: '健康' },
        { id: 'soft', level: '健康' },
      ],
    });
    const composer = makeSkillHealthComposer(factory(mockExecutor(llm)));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    const crit = out.find((o) => o.subId === 'crit');
    const soft = out.find((o) => o.subId === 'soft');
    assert.equal(crit!.severity, 'fatal');
    assert.equal(soft!.severity, 'warn');
  });

  it('embeds top_suggestions and overall in summary outcome', async () => {
    registerHealthDimension(stubDim('a'));
    const llm = buildLlmReport({
      dims: [{ id: 'a', level: '健康' }],
      overall: '良好',
      topSuggestions: ['sugg-1', 'sugg-2'],
    });
    const composer = makeSkillHealthComposer(factory(mockExecutor(llm)));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    const summary = out.find((o) => o.subId === '_summary');
    assert.ok(summary!.hint?.includes('sugg-1'));
    const detail = summary!.detail as { overall?: string; topSuggestions?: string[] };
    assert.equal(detail.overall, '良好');
    assert.deepEqual(detail.topSuggestions, ['sugg-1', 'sugg-2']);
  });

  it('returns single fail summary when executor throws', async () => {
    registerHealthDimension(stubDim('a'));
    const failExec: ExecutorFn = async () => { throw new Error('rate limited'); };
    const composer = makeSkillHealthComposer(factory(failExec));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    assert.equal(out.length, 1);
    assert.equal(out[0].subId, '_summary');
    assert.equal(out[0].status, 'fail');
    assert.equal((out[0].detail as { phase?: string }).phase, 'executor');
  });

  it('returns single fail summary when LLM output has no JSON', async () => {
    registerHealthDimension(stubDim('a'));
    const composer = makeSkillHealthComposer(factory(mockExecutor('I cannot help')));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    assert.equal(out.length, 1);
    assert.equal((out[0].detail as { phase?: string }).phase, 'extract');
  });

  it('composer id is exposed for engine to use as ruleId prefix / groupId', () => {
    assert.equal(SKILL_HEALTH_COMPOSER_ID, 'skill_health');
    const composer = makeSkillHealthComposer();
    assert.equal(composer.id, 'skill_health');
    assert.equal(composer.ruleKind, 'composer');
  });
});

// ---------------------------------------------------------------------------
// 多采样共识(healthSamples > 1)
// ---------------------------------------------------------------------------

/** 每次调用返回序列里下一个输出(用尽后固定返回最后一个)。模拟 N 次采样的不同结果。 */
function mockExecutorSeq(outputs: string[], opts: Partial<ExecResult> = {}): ExecutorFn {
  let i = 0;
  return async () => {
    const output = outputs[Math.min(i, outputs.length - 1)];
    i += 1;
    return {
      ok: true, output, durationMs: 10, durationApiMs: 10,
      inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0.01, stopReason: 'end_turn', numTurns: 1,
      ...opts,
    };
  };
}

/** 构造一份带具体 finding 描述的 LLM 报告 JSON。 */
function reportJson(dims: Array<{
  id: string;
  level: '健康' | '亚健康' | '不健康' | '不适用';
  findings?: Array<{ level: '错误' | '警告'; description: string; suggestion?: string }>;
}>): string {
  return JSON.stringify({
    skill_name: 'sample',
    feature_points: [],
    checklist: dims.map((d) => ({
      dim_id: d.id,
      level: d.level,
      findings: (d.findings ?? []).map((f) => ({
        level: f.level, subtype: '', evidence: '', description: f.description, suggestion: f.suggestion ?? '',
      })),
    })),
    summary: { overall_health: '部分缺陷', top_suggestions: [] },
  });
}

interface DimDetail { findings: Array<{ level: string; description: string; support?: { k: number; n: number } }>; }

describe('skill_health composer — multi-sample consensus', () => {
  beforeEach(() => __resetHealthDimensionsForTest());

  it('unions findings across N samples and tags k/n support', async () => {
    registerHealthDimension(stubDim('a'));
    registerHealthDimension(stubDim('b'));
    const outputs = [
      // 采样 1:a 报 foo.sh(警告);b 健康
      reportJson([
        { id: 'a', level: '亚健康', findings: [{ level: '警告', description: '缺少 `foo.sh`' }] },
        { id: 'b', level: '健康' },
      ]),
      // 采样 2:a 报 foo.sh(错误,同锚点);b 报"缺少示例"
      reportJson([
        { id: 'a', level: '不健康', findings: [{ level: '错误', description: '`foo.sh` 引用不存在,必失败' }] },
        { id: 'b', level: '亚健康', findings: [{ level: '警告', description: '缺少示例' }] },
      ]),
      // 采样 3:a 健康;b 报"缺少示例"(同根因)
      reportJson([
        { id: 'a', level: '健康' },
        { id: 'b', level: '亚健康', findings: [{ level: '警告', description: '缺少示例' }] },
      ]),
    ];
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(outputs)));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 3 }));

    const a = out.find((o) => o.subId === 'a')!;
    const aDet = a.detail as unknown as DimDetail;
    assert.equal(aDet.findings.length, 1, 'foo.sh 跨采样合并成一条');
    assert.deepEqual(aDet.findings[0].support, { k: 2, n: 3 });
    assert.equal(aDet.findings[0].level, '错误', '取最严重 level');
    assert.equal(a.status, 'fail');

    const b = out.find((o) => o.subId === 'b')!;
    const bDet = b.detail as unknown as DimDetail;
    assert.equal(bDet.findings.length, 1);
    assert.deepEqual(bDet.findings[0].support, { k: 2, n: 3 });
    assert.equal(b.status, 'warn');
  });

  it('records sample count in summary detail and message', async () => {
    registerHealthDimension(stubDim('a'));
    const outputs = [
      reportJson([{ id: 'a', level: '健康' }]),
      reportJson([{ id: 'a', level: '健康' }]),
    ];
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(outputs)));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2 }));
    const summary = out.find((o) => o.subId === '_summary')!;
    assert.deepEqual((summary.detail as { samples?: unknown }).samples, { requested: 2, succeeded: 2, concurrency: 2, degraded: false });
    assert.match(summary.message, /2\/2/);
  });

  it('aggregates tokens / cost across samples', async () => {
    registerHealthDimension(stubDim('a'));
    const outputs = [reportJson([{ id: 'a', level: '健康' }]), reportJson([{ id: 'a', level: '健康' }])];
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(outputs)));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2 }));
    const det = out.find((o) => o.subId === '_summary')!.detail as { tokens?: { input: number }; costUSD?: number };
    assert.equal(det.tokens!.input, 10, '5 + 5 累加');
    assert.equal(det.costUSD, 0.02);
  });

  it('runs samples in parallel by default; records concurrency; support spans all samples', async () => {
    registerHealthDimension(stubDim('a'));
    const one = reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '缺少 `foo.sh`' }] }]);
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq([one, one, one])));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 3 }));
    const summary = out.find((o) => o.subId === '_summary')!;
    assert.equal((summary.detail as { samples?: { concurrency?: number } }).samples!.concurrency, 3, '默认并发=采样数');
    const a = out.find((o) => o.subId === 'a')!;
    assert.deepEqual((a.detail as unknown as DimDetail).findings[0].support, { k: 3, n: 3 });
  });

  it('--concurrency 1 forces serial, same merged result', async () => {
    registerHealthDimension(stubDim('a'));
    const one = reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '缺少 `foo.sh`' }] }]);
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq([one, one, one])));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 3, healthConcurrency: 1 }));
    const summary = out.find((o) => o.subId === '_summary')!;
    assert.equal((summary.detail as { samples?: { concurrency?: number } }).samples!.concurrency, 1);
    const a = out.find((o) => o.subId === 'a')!;
    assert.deepEqual((a.detail as unknown as DimDetail).findings[0].support, { k: 3, n: 3 });
  });

  it('survives partial sample failure (≥1 success still produces report)', async () => {
    registerHealthDimension(stubDim('a'));
    const outputs = [
      'I cannot help with that',                          // 采样 1:抽不出 JSON
      reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '`x` 缺失' }] }]),
    ];
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(outputs)));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2 }));
    const summary = out.find((o) => o.subId === '_summary')!;
    assert.equal(summary.status, 'warn');
    assert.deepEqual((summary.detail as { samples?: unknown }).samples, { requested: 2, succeeded: 1, concurrency: 2, degraded: true });
    assert.match(summary.message, /仅成功解析 1\/2 次/);
    const a = out.find((o) => o.subId === 'a')!;
    assert.equal(a.status, 'fail');
    assert.deepEqual((a.detail as unknown as DimDetail).findings[0].support, { k: 1, n: 1 });
  });

  it('all samples failing → single fail summary', async () => {
    registerHealthDimension(stubDim('a'));
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(['nope', 'still nope'])));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2 }));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'fail');
    assert.equal((out[0].detail as { phase?: string }).phase, 'extract');
  });

  it('default (healthSamples undefined) runs exactly once', async () => {
    registerHealthDimension(stubDim('a'));
    let calls = 0;
    const exec: ExecutorFn = async () => {
      calls += 1;
      return {
        ok: true, output: reportJson([{ id: 'a', level: '健康' }]),
        durationMs: 10, durationApiMs: 10,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, stopReason: 'end_turn', numTurns: 1,
      };
    };
    const composer = makeSkillHealthComposer(factory(exec));
    const out = await composer.checkAll(ctxWith(sampleSkill()));
    assert.equal(calls, 1);
    // 单次采样不追加 samples 说明
    assert.doesNotMatch(out.find((o) => o.subId === '_summary')!.message, /采样/);
  });
});

// ---------------------------------------------------------------------------
// LLM 归并 pass(--health-merge llm)
// ---------------------------------------------------------------------------

const clustersJson = (clusters: Array<{ dim_id: string; finding_ids: string[]; level?: string; description?: string; suggestion?: string }>): string =>
  JSON.stringify({ clusters });

describe('skill_health composer — llm merge', () => {
  beforeEach(() => __resetHealthDimensionsForTest());

  it('llm merge clusters cross-anchor findings into one (2/2) that string merge would split', async () => {
    registerHealthDimension(stubDim('a'));
    const outputs = [
      reportJson([{ id: 'a', level: '亚健康', findings: [{ level: '警告', description: '模板 `t1.tmpl.md` 缺失' }] }]),
      reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '模板 `t2.tmpl.md` 不存在' }] }]),
      // 第 3 次调用 = merge pass:把 f0/f1 归一组
      clustersJson([{ dim_id: 'a', finding_ids: ['f0', 'f1'], level: '错误', description: '模板目录缺失', suggestion: '补 templates' }]),
    ];
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(outputs)));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2, healthMerge: 'llm' }));
    const a = out.find((o) => o.subId === 'a')!;
    const aDet = a.detail as unknown as DimDetail;
    assert.equal(aDet.findings.length, 1, '跨措辞合并成一条');
    assert.deepEqual(aDet.findings[0].support, { k: 2, n: 2 });
    assert.equal((out.find((o) => o.subId === '_summary')!.detail as { mergeMode?: string }).mergeMode, 'llm');
  });

  it('falls back to string merge when merge output is unparseable', async () => {
    registerHealthDimension(stubDim('a'));
    const outputs = [
      reportJson([{ id: 'a', level: '亚健康', findings: [{ level: '警告', description: '模板 `t1.tmpl.md` 缺失' }] }]),
      reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '模板 `t2.tmpl.md` 不存在' }] }]),
      'sorry, no json',
    ];
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq(outputs)));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2, healthMerge: 'llm' }));
    const a = out.find((o) => o.subId === 'a')!;
    assert.equal((a.detail as unknown as DimDetail).findings.length, 2, '锚点不同 → 字符串键不合并 → 2 条');
    assert.equal((out.find((o) => o.subId === '_summary')!.detail as { mergeMode?: string }).mergeMode, 'string(llm-fallback)');
  });

  it('skips the merge call when nothing is mergeable (≤1 finding per dim)', async () => {
    registerHealthDimension(stubDim('a'));
    let calls = 0;
    const outputs = [
      reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '`x` 缺失' }] }]),
      reportJson([{ id: 'a', level: '健康' }]),
    ];
    const seq = mockExecutorSeq(outputs);
    const exec: ExecutorFn = async (input) => { calls += 1; return seq(input); };
    const composer = makeSkillHealthComposer(factory(exec));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2, healthMerge: 'llm' }));
    assert.equal(calls, 2, '只跑 2 次采样,不发起 merge 调用');
    assert.equal((out.find((o) => o.subId === '_summary')!.detail as { mergeMode?: string }).mergeMode, 'string');
  });
});

describe('skill_health composer — CR regression', () => {
  beforeEach(() => __resetHealthDimensionsForTest());

  it('llm merge skips when findings are 1-per-dim across dims (max per dim < 2)', async () => {
    registerHealthDimension(stubDim('a'));
    registerHealthDimension(stubDim('b'));
    let calls = 0;
    const outputs = [
      reportJson([{ id: 'a', level: '不健康', findings: [{ level: '错误', description: '`x` 缺' }] }, { id: 'b', level: '健康' }]),
      reportJson([{ id: 'a', level: '健康' }, { id: 'b', level: '不健康', findings: [{ level: '错误', description: '`y` 缺' }] }]),
    ];
    const seq = mockExecutorSeq(outputs);
    const exec: ExecutorFn = async (input) => { calls += 1; return seq(input); };
    const composer = makeSkillHealthComposer(factory(exec));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2, healthMerge: 'llm' }));
    assert.equal(calls, 2, '总 finding=2 但每维度只 1 条 → 不该发起 merge 调用');
    assert.equal((out.find((o) => o.subId === '_summary')!.detail as { mergeMode?: string }).mergeMode, 'string');
  });

  it('healthSamples=0 floors to a single sample (no zero-sample run)', async () => {
    registerHealthDimension(stubDim('a'));
    let calls = 0;
    const seq = mockExecutorSeq([reportJson([{ id: 'a', level: '健康' }])]);
    const exec: ExecutorFn = async (input) => { calls += 1; return seq(input); };
    const composer = makeSkillHealthComposer(factory(exec));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 0 }));
    assert.equal(calls, 1, 'healthSamples=0 兜底为 1 次');
    assert.equal((out.find((o) => o.subId === '_summary')!.detail as { samples?: { requested?: number } }).samples!.requested, 1);
  });

  it('concurrency clamps to requested (--concurrency 10 with repeat 2 → 2)', async () => {
    registerHealthDimension(stubDim('a'));
    const one = reportJson([{ id: 'a', level: '健康' }]);
    const composer = makeSkillHealthComposer(factory(mockExecutorSeq([one, one])));
    const out = await composer.checkAll(ctxWith(sampleSkill(), { healthSamples: 2, healthConcurrency: 10 }));
    assert.equal((out.find((o) => o.subId === '_summary')!.detail as { samples?: { concurrency?: number } }).samples!.concurrency, 2);
  });
});

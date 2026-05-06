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
import type { Artifact } from '../../../src/types/index.js';
import type { DoctorContext } from '../../../src/types/doctor.js';
import type { ExecResult, ExecutorFn } from '../../../src/types/executor.js';
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
    assert.equal(composer.kind, 'composer');
  });
});

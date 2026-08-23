import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { executorVendor } from '../../src/executors/core/registry.js';
import { analyzeJudgeIndependence } from '../../src/eval-core/judge-independence.js';
import type { JudgeConfig, Report } from '../../src/types/index.js';

describe('executorVendor', () => {
  it('Anthropic 家族', () => {
    for (const e of ['claude', 'claude-sdk', 'anthropic-api']) assert.equal(executorVendor(e), 'anthropic');
  });
  it('OpenAI 家族(含 codex —— codex 是 OpenAI 模型)', () => {
    for (const e of ['codex', 'codex-sdk', 'openai-api']) assert.equal(executorVendor(e), 'openai');
  });
  it('Google', () => {
    assert.equal(executorVendor('gemini'), 'google');
  });
  it('未知 / 自定义 script → unknown', () => {
    assert.equal(executorVendor('my-script.sh'), 'unknown');
    assert.equal(executorVendor(''), 'unknown');
  });
});

const mkReport = (
  judges: JudgeConfig[],
  outputExecutor: string,
  opts: { gold?: boolean; runtimes?: Record<string, string>; noJudge?: boolean } = {},
): Report => ({
  kind: 'evaluation',
  id: 'r',
  results: [],
  summary: {},
  meta: {
    variants: ['baseline', 'skill'],
    model: 'm',
    judgeModels: judges,
    executor: outputExecutor,
    sampleCount: 1, taskCount: 1, totalCostUSD: 0,
    timestamp: 't', cliVersion: 't', nodeVersion: 't', artifactHashes: {},
    ...(opts.noJudge ? { noJudge: true } : {}),
    ...(opts.runtimes
      ? { executorRuntimes: Object.fromEntries(Object.entries(opts.runtimes).map(([v, e]) => [v, { executor: e }])) as never }
      : {}),
    ...(opts.gold ? { humanAgreement: { alpha: 0.7 } as never } : {}),
  } as never,
} as Report);

describe('analyzeJudgeIndependence', () => {
  it('同厂商评委(claude 评 claude 输出)→ sameVendorJudge,无 gold = 敞口', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'claude', model: 'haiku' }], 'claude'));
    assert.equal(r.sameVendorJudge, true);
    assert.equal(r.crossVendorJudgePresent, false);
    assert.equal(r.goldCalibrated, false);
  });

  it('跨厂商评委(openai 评 claude 输出)→ 非 sameVendor、有独立评委', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'openai-api', model: 'gpt-4o' }], 'claude'));
    assert.equal(r.sameVendorJudge, false);
    assert.equal(r.crossVendorJudgePresent, true);
  });

  it('单厂商 ensemble(2 个 claude)→ singleVendorEnsemble', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'claude', model: 'opus' }, { executor: 'claude', model: 'haiku' }], 'claude'));
    assert.equal(r.singleVendorEnsemble, true);
  });

  it('跨厂商 ensemble(claude + openai)→ 非单厂商、有独立评委', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'claude', model: 'opus' }, { executor: 'openai-api', model: 'gpt-4o' }], 'claude'));
    assert.equal(r.singleVendorEnsemble, false);
    assert.equal(r.crossVendorJudgePresent, true);
  });

  it('同厂商 + gold 校准 → 仍 sameVendorJudge,但 goldCalibrated=true(消费方据此软化)', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'claude', model: 'haiku' }], 'claude', { gold: true }));
    assert.equal(r.sameVendorJudge, true);
    assert.equal(r.goldCalibrated, true);
  });

  it('codex 评 claude 输出 = 跨厂商(codex 属 OpenAI)', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'codex', model: 'gpt-5-codex' }], 'claude'));
    assert.equal(r.sameVendorJudge, false);
  });

  it('自定义 script(unknown 厂商)→ 跳过,不误报', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'my-script.sh', model: 'x' }], 'claude'));
    assert.equal(r.sameVendorJudge, false);
    assert.equal(r.singleVendorEnsemble, false);
  });

  it('noJudge(judgeModels 空)→ 全 false', () => {
    const r = analyzeJudgeIndependence(mkReport([], 'claude'));
    assert.equal(r.sameVendorJudge, false);
    assert.equal(r.singleVendorEnsemble, false);
  });

  it('noJudge=true(judgeModels 为审计保留但没跑评委)→ 不报,自我偏好 moot', () => {
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'claude', model: 'haiku' }], 'claude', { noJudge: true }));
    assert.equal(r.sameVendorJudge, false);
    assert.equal(r.singleVendorEnsemble, false);
  });

  it('per-variant executorRuntimes 优先于 meta.executor 取被测厂商', () => {
    // 评委 claude;输出实际由 openai 跑(runtimes)→ 跨厂商,不该判同厂商。
    const r = analyzeJudgeIndependence(mkReport([{ executor: 'claude', model: 'haiku' }], 'claude', { runtimes: { baseline: 'openai-api', skill: 'openai-api' } }));
    assert.equal(r.sameVendorJudge, false);
    assert.equal(r.crossVendorJudgePresent, true);
  });
});

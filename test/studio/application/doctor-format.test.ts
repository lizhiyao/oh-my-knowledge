/**
 * 体检结果的呈现口径：规则排序、`:_summary` 伪规则剔除、finding 分级与 k/n 支持度门槛。
 *
 * 这些都是「同一条 finding 在详情／终端里必须读成同一种颜色」的口径，与 React 的措辞无关，
 * 所以在 application 层直接锁；页面能渲染出什么由 web/knowledge-doctor-tab.test.tsx 负责。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { DoctorRuleResult, DoctorRuleStatus } from '../../../src/knowledge-artifacts/doctor/contracts.js';
import { projectDoctorRules, projectDoctorSampling } from '../../../src/studio/application/doctor-format.js';

function rule(
  ruleId: string,
  status: DoctorRuleStatus,
  detail: Record<string, unknown> = {},
): DoctorRuleResult {
  return {
    ruleId,
    groupId: ruleId.split(':')[0],
    severity: status === 'fail' ? 'fatal' : 'info',
    labelKey: `cli.doctor.${ruleId}`,
    status,
    message: `${ruleId} message`,
    detail,
    durationMs: 10,
  };
}

function finding(level: string, description: string, extra: Record<string, unknown> = {}) {
  return { level, description, ...extra };
}

describe('体检规则的呈现排序', () => {
  it('fail → warn → pass → skipped，组内保持引擎产出顺序', () => {
    const rules = projectDoctorRules([
      rule('r:pass-a', 'pass'),
      rule('r:fail-a', 'fail'),
      rule('r:skip-a', 'skipped'),
      rule('r:warn-a', 'warn'),
      rule('r:fail-b', 'fail'),
    ]);
    assert.deepEqual(rules.map((item) => item.ruleId), ['r:fail-a', 'r:fail-b', 'r:warn-a', 'r:pass-a', 'r:skip-a']);
  });

  it('信息性的 `:_summary`（pass／warn）是采样元数据载体，不作为一条体检规则出现', () => {
    const rules = projectDoctorRules([
      rule('skill_health:a', 'warn', { displayName: '文档清晰度' }),
      rule('skill_health:_summary', 'warn', { samples: { requested: 2, succeeded: 1 } }),
      rule('skill_health:_summary', 'pass', {}),
    ]);
    assert.deepEqual(rules.map((item) => item.ruleId), ['skill_health:a']);
  });

  it('全部采样失败时 `:_summary` 是唯一的失败记录，必须留在列表里', () => {
    // composer 的 errorSummaryOutcome：这一轮只有它，剔掉就没人能解释为什么报红。
    const rules = projectDoctorRules([
      rule('skill_health:_summary', 'fail', {
        displayName: '汇总',
        findings: [],
      }),
    ]);
    assert.deepEqual(rules.map((item) => item.ruleId), ['skill_health:_summary']);
    assert.equal(rules[0]?.status, 'fail');
  });

  it('标题优先用维度 displayName，缺失时回退 ruleId 而不是留空', () => {
    const rules = projectDoctorRules([
      rule('r:a', 'fail', { displayName: '引用完整性' }),
      rule('r:b', 'fail', { displayName: '' }),
      rule('r:c', 'fail', {}),
    ]);
    assert.deepEqual(rules.map((item) => item.title), ['引用完整性', 'r:b', 'r:c']);
  });
});

describe('finding 分级与支持度', () => {
  it('同一条规则内按错误 → 警告 → 建议排列，引擎给的未知级别不丢弃', () => {
    const [only] = projectDoctorRules([rule('r:a', 'warn', { findings: [
      finding('建议', 'tip'), finding('未知分级', 'info'), finding('警告', 'warning'), finding('错误', 'error'),
    ] })]);
    assert.deepEqual(only?.findings.map((item) => [item.tone, item.description]), [
      ['error', 'error'], ['warning', 'warning'], ['tip', 'tip'], ['info', 'info'],
    ]);
  });

  it('k/n 支持度只在 n>1 时呈现，缺字段或非法值按无支持度处理', () => {
    const rules = projectDoctorRules([rule('r:a', 'warn', { findings: [
      finding('警告', 'consensus', { support: { k: 3, n: 3 } }),
      finding('警告', 'single'),
      finding('警告', 'once', { support: { k: 1, n: 1 } }),
      finding('警告', 'broken', { support: { k: 'x' } }),
    ] })]);
    assert.deepEqual(rules[0]?.findings.map((item) => item.support), [{ k: 3, n: 3 }, undefined, undefined, undefined]);
  });

  it('修复建议只在引擎真的给了非空字符串时呈现', () => {
    const rules = projectDoctorRules([rule('r:a', 'warn', { findings: [
      finding('警告', 'a', { suggestion: '补一段回滚说明' }),
      finding('警告', 'b', { suggestion: '' }),
    ] })]);
    assert.equal(rules[0]?.findings[0]?.suggestion, '补一段回滚说明');
    assert.equal(rules[0]?.findings[1]?.suggestion, undefined);
  });
});

describe('采样降级判定', () => {
  const sampling = (samples: unknown): DoctorRuleResult[] => [rule('skill_health:_summary', 'warn', { samples })];

  it('请求 n 次只成功 k<n 次才算降级，完整解析与单次采样都不报警', () => {
    assert.deepEqual(projectDoctorSampling(sampling({ requested: 2, succeeded: 1 })), { requested: 2, succeeded: 1 });
    assert.equal(projectDoctorSampling(sampling({ requested: 2, succeeded: 2 })), null);
    assert.equal(projectDoctorSampling(sampling({ requested: 1, succeeded: 1 })), null);
    assert.equal(projectDoctorSampling(sampling(undefined)), null);
    assert.equal(projectDoctorSampling(sampling({ requested: 'two', succeeded: 1 })), null);
    assert.equal(projectDoctorSampling([rule('skill_health:a', 'warn')]), null);
  });
});

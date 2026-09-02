import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAndRegisterCustomDimensions } from '../../../src/doctor/health/load-custom-dimensions.js';
import {
  getRegisteredHealthDimensions,
  __resetHealthDimensionsForTest,
} from '../../../src/doctor/health/dimension-registry.js';
import { getRegisteredRules, __resetCustomRulesForTest } from '../../../src/doctor/rules.js';
import type { DoctorContext, DoctorRule } from '../../../src/doctor/contracts.js';
import { isComposerRule } from '../../../src/doctor/rule-kind.js';
import type { Artifact } from '../../../src/knowledge-artifacts/contracts.js';

let dir: string;
const writeYaml = (body: string): string => {
  const p = join(dir, 'dims.yaml');
  writeFileSync(p, body, 'utf-8');
  return p;
};

// endpoint 维度注册为普通 DoctorRule(带 check);按 id 取出并收窄掉 ComposerRule。
const registeredDoctorRule = (id: string): DoctorRule => {
  const r = getRegisteredRules().find((x) => x.id === id);
  assert.ok(r && !isComposerRule(r), `rule ${id} not found or is a composer`);
  return r;
};

describe('load-custom-dimensions', () => {
  beforeEach(() => {
    __resetHealthDimensionsForTest();
    __resetCustomRulesForTest();
    dir = mkdtempSync(join(tmpdir(), 'omk-dims-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('registers a promptSection dimension into the health registry', () => {
    const count = loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: my-llm-dim
    displayName: LLM 维度
    promptSection: 检查 X
`));
    assert.equal(count, 1);
    assert.deepEqual(getRegisteredHealthDimensions().map((d) => d.id), ['my-llm-dim']);
    // 不应注册成 endpoint rule
    assert.equal(getRegisteredRules().some((r) => r.id === 'my-llm-dim'), false);
  });

  it('registers an endpoint dimension as a doctor rule, not a health dimension', () => {
    const count = loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: api-audit
    displayName: 接口审查
    severity: fatal
    endpoint: https://x/audit
`));
    assert.equal(count, 1);
    assert.equal(getRegisteredHealthDimensions().length, 0);
    const rule = getRegisteredRules().find((r) => r.id === 'api-audit');
    assert.ok(rule);
    assert.equal((rule as { external?: boolean }).external, true);
  });

  it('throws when a dimension sets both endpoint and promptSection', () => {
    assert.throws(() => loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: bad
    displayName: 冲突
    endpoint: https://x
    promptSection: 也写了 prompt
`)), /二选一/);
  });

  it('throws when a dimension has neither endpoint nor promptSection', () => {
    assert.throws(() => loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: bare
    displayName: 空
`)), /endpoint 或 promptSection/);
  });

  it('throws on invalid severity instead of silently downgrading to warn', () => {
    assert.throws(() => loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: sec
    displayName: 审查
    severity: critical
    endpoint: https://example.com/audit
`)), /severity 非法.*fatal \/ warn \/ info/);
  });

  it('omitted severity still defaults to warn', () => {
    loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: no-sev
    displayName: 缺省档位
    endpoint: https://example.com/audit
`));
    const rule = getRegisteredRules().find((r) => r.id === 'no-sev');
    assert.equal(rule?.severity, 'warn');
  });

  it('passes allowPrivateHost through to the endpoint rule', async () => {
    loadAndRegisterCustomDimensions(writeYaml(`
dimensions:
  - id: private-default
    displayName: 默认拒绝
    endpoint: http://127.0.0.1:1/audit
  - id: private-allowed
    displayName: 显式放行
    endpoint: http://127.0.0.1:1/audit
    allowPrivateHost: true
`));
    const artifact: Artifact = { name: 's', kind: 'skill', source: 'file-path', content: 'c' };
    const ctx: DoctorContext = {
      artifact, executorName: 'claude', model: 'sonnet', cwd: '/tmp', lang: 'zh', timeoutMs: 3000,
    };
    // 未放行:私网地址在请求组装前被拒,message 提示 allowPrivateHost。
    const refused = await registeredDoctorRule('private-default').check(ctx);
    assert.equal(refused.status, 'fail');
    assert.match(refused.message, /allowPrivateHost/);
    // 已放行:不再因 SSRF 被拒(端口 1 无服务,落到网络层失败,但不是私网拒绝文案)。
    const allowed = await registeredDoctorRule('private-allowed').check(ctx);
    assert.equal(allowed.status, 'fail');
    assert.doesNotMatch(allowed.message, /allowPrivateHost/);
  });
});

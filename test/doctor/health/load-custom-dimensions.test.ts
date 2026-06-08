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

let dir: string;
const writeYaml = (body: string): string => {
  const p = join(dir, 'dims.yaml');
  writeFileSync(p, body, 'utf-8');
  return p;
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
});

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  skillReadableRule,
  skillMetadataRule,
  dependenciesPresentRule,
  samplesContractAlignedRule,
  BUILTIN_RULES,
  registerRule,
  getRegisteredRules,
  __resetCustomRulesForTest,
} from '../../../src/knowledge-artifacts/doctor/rules.js';
import type { Artifact } from '../../../src/knowledge-artifacts/contracts.js';
import type { Sample } from '../../../src/inputs/contracts/sample.js';
import type { DoctorContext, DoctorRule } from '../../../src/knowledge-artifacts/doctor/contracts.js';

function ctxWith(artifact: Artifact, overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    artifact,
    executorName: 'mock',
    model: 'sonnet',
    cwd: '/tmp',
    lang: 'zh',
    timeoutMs: 8000,
    ...overrides,
  };
}

const sampleSkill = (overrides: Partial<Artifact> = {}): Artifact => ({
  name: 'v1',
  kind: 'skill',
  source: 'file-path',
  content: '你是一个测试助手。请简短回答用户问题。',
  ...overrides,
});

describe('skillReadableRule', () => {
  it('passes for normal-length skill content', async () => {
    const r = await skillReadableRule.check(ctxWith(sampleSkill()));
    assert.equal(r.status, 'pass');
  });

  it('fails when content is null', async () => {
    const r = await skillReadableRule.check(ctxWith(sampleSkill({ content: null })));
    assert.equal(r.status, 'fail');
    assert.ok(r.message.length > 0);
    assert.ok(r.hint && r.hint.length > 0);
  });

  it('fails when content is empty string after trim', async () => {
    const r = await skillReadableRule.check(ctxWith(sampleSkill({ content: '   \n  \t  ' })));
    assert.equal(r.status, 'fail');
  });

  it('fails when content is shorter than minimum length', async () => {
    const r = await skillReadableRule.check(ctxWith(sampleSkill({ content: 'hi' })));
    assert.equal(r.status, 'fail');
    assert.ok(r.message.includes('2'));
  });

  it('passes for a single-line 28-char skill', async () => {
    // 单行 28 字符的最小 skill(典型的最简代码审查 prompt)必须 pass
    const r = await skillReadableRule.check(ctxWith(sampleSkill({
      content: '你是一个代码审查助手。请审查用户提供的代码,指出潜在问题。',
    })));
    assert.equal(r.status, 'pass');
  });

  it('echoes the file path in the hint and detail when content is missing', async () => {
    const r = await skillReadableRule.check(ctxWith(sampleSkill({
      content: null,
      locator: '/tmp/missing/skills/v1.md',
    })));
    assert.equal(r.status, 'fail');
    assert.ok(r.hint?.includes('/tmp/missing/skills/v1.md'),
      `hint should echo the tried path; got: ${r.hint}`);
    assert.equal((r.detail as { triedPath?: string })?.triedPath, '/tmp/missing/skills/v1.md');
  });

  it('falls back to inline marker in the hint when artifact has no locator', async () => {
    const r = await skillReadableRule.check(ctxWith(sampleSkill({
      name: 'inline-anon',
      source: 'inline',
      content: null,
      locator: undefined,
    })));
    assert.equal(r.status, 'fail');
    assert.match(r.hint ?? '', /<inline:inline-anon>/);
  });
});

describe('skillMetadataRule', () => {
  it('passes for pure markdown skill without front-matter', async () => {
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({
      content: '你是一个代码审查助手。',
    })));
    assert.equal(r.status, 'pass');
  });

  it('passes for skill with valid YAML front-matter', async () => {
    const content = `---
name: v1
description: code review skill
preflight:
  - echo ok
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'pass');
  });

  it('passes and reports structured hardRules when front-matter hardRules are valid', async () => {
    const content = `---
name: v1
description: code review skill
hardRules:
  - id: must-run-tests
    rule: Run the project tests before finalizing code changes.
    expectedBehavior: Invoke the configured test command or explain why it cannot run.
  - id: cite-files
    rule: Reference changed files in the final response.
    expectedBehavior: Final response includes concrete file paths.
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.detail, {
      hardRulesDeclared: true,
      hardRulesCount: 2,
      workflowsDeclared: false,
      workflowsCount: 0,
      workflowNodeCount: 0,
    });
  });

  it('passes and reports structured workflows when front-matter workflows are valid', async () => {
    const content = `---
name: v1
description: workflow skill
workflows:
  - id: figma-route
    description: Restore a component from design input.
    nodes:
      - id: read-design
        action: Read the design source.
      - id: render-draft
        action: Render the draft component.
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.detail, {
      hardRulesDeclared: false,
      hardRulesCount: 0,
      workflowsDeclared: true,
      workflowsCount: 1,
      workflowNodeCount: 2,
    });
  });

  it('fails when workflows is present but not a list', async () => {
    const content = `---
name: v1
workflows: use the happy path
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
    assert.match(r.message, /workflows/);
  });

  it('fails when workflow nodes are missing action', async () => {
    const content = `---
name: v1
workflows:
  - id: figma-route
    nodes:
      - id: read-design
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
    assert.match(r.message, /action/);
  });

  it('fails when hardRules is present but not a list', async () => {
    const content = `---
name: v1
hardRules: must run tests
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
    assert.match(r.message, /hardRules/);
    assert.ok(Array.isArray((r.detail as { errors?: unknown[] }).errors));
  });

  it('fails when hardRules entries miss expectedBehavior', async () => {
    const content = `---
name: v1
hardRules:
  - id: must-run-tests
    rule: Run tests before finalizing.
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
    assert.match(r.message, /expectedBehavior/);
  });

  it('fails when hardRules ids are duplicated', async () => {
    const content = `---
name: v1
hardRules:
  - id: must-run-tests
    rule: Run tests before finalizing.
    expectedBehavior: Invoke the test command.
  - id: must-run-tests
    rule: Run lint before finalizing.
    expectedBehavior: Invoke the lint command.
---

skill body content here.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
    assert.match(r.message, /duplicates/);
  });

  it('fails for skill with malformed front-matter (unterminated YAML flow)', async () => {
    // js-yaml will reject unterminated flow collections like `[unterminated`
    const content = `---
name: [unterminated
---

body.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
    assert.ok(r.message.length > 0);
    assert.ok(r.hint && r.hint.length > 0);
  });

  it('fails for skill with malformed front-matter (illegal indentation)', async () => {
    // mixed-tab/space mapping — real YAML parsers reject this; hand-written
    // pattern check before this fix would have let it pass.
    const content = `---
foo: bar
  bad: indent
back: top
---

body.`;
    const r = await skillMetadataRule.check(ctxWith(sampleSkill({ content })));
    assert.equal(r.status, 'fail');
  });

  it('fails when directory-skill is missing SKILL.md', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-skill-'));
    try {
      const r = await skillMetadataRule.check(ctxWith(sampleSkill({
        skillRoot: tmp,
      })));
      assert.equal(r.status, 'fail');
      assert.ok(r.message.length > 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes when directory-skill has SKILL.md present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-skill-'));
    try {
      writeFileSync(join(tmp, 'SKILL.md'), 'skill body');
      const r = await skillMetadataRule.check(ctxWith(sampleSkill({
        skillRoot: tmp,
      })));
      assert.equal(r.status, 'pass');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('dependenciesPresentRule', () => {
  it('passes when skill content has no external dependencies', async () => {
    const r = await dependenciesPresentRule.check(ctxWith(sampleSkill()));
    assert.equal(r.status, 'pass');
  });

  it('fails when skill content references a non-existent CLI tool', async () => {
    const r = await dependenciesPresentRule.check(ctxWith(sampleSkill({
      content: '请运行 nonexistent-fake-cli 命令来分析数据。',
    })));
    assert.equal(r.status, 'fail');
    assert.ok(Array.isArray((r.detail as { missing?: unknown[] }).missing));
  });

  it('hint mentions tool-fix advice when only a tool is missing (no file/env noise)', async () => {
    const r = await dependenciesPresentRule.check(ctxWith(sampleSkill({
      content: '请运行 nonexistent-fake-cli 命令来分析数据。',
    })));
    assert.equal(r.status, 'fail');
    assert.match(r.hint ?? '', /requires\.tools|工具缺失|missing tool/);
    // Should not surface unrelated category fixes when those categories have 0 items.
    assert.doesNotMatch(r.hint ?? '', /requires\.files|文件缺失|missing file/);
    assert.doesNotMatch(r.hint ?? '', /requires\.env|环境变量缺失|missing env/);
  });

  it('hint mentions env-fix advice when only an env var is required and missing', async () => {
    // Surface env-only path: declare a required env var that isn't set.
    const envName = `OMK_DOCTOR_TEST_NOT_SET_${Date.now()}`;
    delete process.env[envName];
    const r = await dependenciesPresentRule.check(ctxWith(sampleSkill(), {
      requires: { env: [envName] },
    }));
    assert.equal(r.status, 'fail');
    assert.match(r.hint ?? '', /shell profile|CI secrets|环境变量缺失|missing env/);
    assert.doesNotMatch(r.hint ?? '', /requires\.tools|工具缺失|missing tool/);
  });

  it('preflight failure surfaces command + reasonCode in localized hint', async () => {
    // dep-checker emits structured DependencyIssue { category: 'preflight',
    // reasonCode: 'preflight_failed', reasonDetail: <stderr> }. Doctor localizes
    // it via ctx.lang. Generic "install on PATH" advice would mislead away from
    // the real cause (the command itself failed, not a missing binary).
    const skill = sampleSkill({
      content: `---\npreflight:\n  - "false"\n---\n\n你是一个测试 skill,内容长度足够通过 readable rule。`,
      metadata: { preflight: ['false'] },
    });
    const r = await dependenciesPresentRule.check(ctxWith(skill));
    assert.equal(r.status, 'fail');
    assert.match(r.hint ?? '', /preflight 命令 "false" 执行失败/);
    const missing = (r.detail as { missing?: Array<{ category?: string; reasonCode?: string }> }).missing;
    assert.ok(Array.isArray(missing) && missing.length > 0);
    const pf = missing!.find((m) => m.reasonCode === 'preflight_failed');
    assert.ok(pf, 'should carry preflight_failed reasonCode');
    assert.equal(pf!.category, 'preflight');
  });

  it('preflight stderr is preserved in reasonDetail (not just truncated to "Command failed:")', async () => {
    // execSync's err.message is "Command failed: <cmd>\n<stderr>" — splitting and
    // keeping line 0 used to drop the actual stderr. Now we read err.stderr
    // directly so the real cause reaches the user.
    const stderrMarker = `OMK_PREFLIGHT_STDERR_TOKEN_${Date.now()}`;
    const skill = sampleSkill({
      content: '你是一个测试 skill,内容长度足够通过 readable rule。',
      metadata: { preflight: [`sh -c 'echo ${stderrMarker} >&2; exit 2'`] },
    });
    const r = await dependenciesPresentRule.check(ctxWith(skill));
    assert.equal(r.status, 'fail');
    assert.ok(r.hint?.includes(stderrMarker),
      `hint should carry the stderr line "${stderrMarker}"; got: ${r.hint}`);
    const missing = (r.detail as { missing?: Array<{ reasonDetail?: string }> }).missing;
    assert.ok(missing?.some((m) => m.reasonDetail?.includes(stderrMarker)));
  });

  it('--lang en hint contains no Chinese characters (i18n is structural, not pass-through)', async () => {
    // Catches the bug where dep-checker leaked Chinese hint strings into doctor's
    // localized hint. With reasonCode-driven translation, en stays pure-en.
    const skill = sampleSkill({
      content: '请运行 nonexistent-fake-cli-en 命令来分析数据。',
    });
    const r = await dependenciesPresentRule.check(ctxWith(skill, { lang: 'en' }));
    assert.equal(r.status, 'fail');
    assert.doesNotMatch(r.hint ?? '', /[一-鿿]/,
      `en hint should contain no CJK chars; got: ${r.hint}`);
    assert.doesNotMatch(r.message ?? '', /[一-鿿]/,
      `en message should contain no CJK chars; got: ${r.message}`);
  });
});

describe('samplesContractAlignedRule', () => {
  const goodSample: Sample = { sample_id: 's1', prompt: 'review this code' };

  it('skips when no samples are provided', async () => {
    const r = await samplesContractAlignedRule.check(ctxWith(sampleSkill()));
    assert.equal(r.status, 'skipped');
  });

  it('warns when samples array is empty', async () => {
    const r = await samplesContractAlignedRule.check(ctxWith(sampleSkill(), { samples: [] }));
    assert.equal(r.status, 'warn');
  });

  it('warns when some samples are missing prompt', async () => {
    const r = await samplesContractAlignedRule.check(ctxWith(sampleSkill(), {
      samples: [goodSample, { sample_id: 's2', prompt: '' }],
    }));
    assert.equal(r.status, 'warn');
    assert.ok(r.message.includes('1'));
  });

  it('passes when all samples have non-empty prompt', async () => {
    const r = await samplesContractAlignedRule.check(ctxWith(sampleSkill(), {
      samples: [goodSample, { sample_id: 's2', prompt: 'another' }],
    }));
    assert.equal(r.status, 'pass');
  });
});

describe('rules registry', () => {
  it('BUILTIN_RULES exposes the registered rules in stable order', () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    assert.deepEqual(ids, [
      'skill_readable',
      'skill_metadata',
      'dependencies_present',
      'samples_contract_aligned',
    ]);
  });

  it('registerRule adds custom rule', () => {
    __resetCustomRulesForTest();
    const myRule: DoctorRule = {
      id: 'custom_test',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_readable', // any valid key
      async check() {
        return { status: 'pass', message: 'ok' };
      },
    };
    registerRule(myRule);
    const all = getRegisteredRules();
    assert.ok(all.some((r) => r.id === 'custom_test'));
    __resetCustomRulesForTest();
  });

  it('registerRule rejects collision with built-in rule id', () => {
    __resetCustomRulesForTest();
    const dup: DoctorRule = {
      id: 'skill_readable',
      severity: 'fatal',
      labelKey: 'cli.doctor.rule.skill_readable',
      async check() {
        return { status: 'pass', message: 'ok' };
      },
    };
    assert.throws(() => registerRule(dup), /collision/);
    __resetCustomRulesForTest();
  });
});

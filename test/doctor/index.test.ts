import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDoctor, resolveDoctorTargets } from '../../src/doctor/index.js';
import { registerRule, __resetCustomRulesForTest } from '../../src/doctor/rules.js';
import type { Artifact } from '../../src/types/index.js';
import type { DoctorRule } from '../../src/types/doctor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_SKILLS_DIR = join(__dirname, '..', '..', 'examples', 'code-review', 'skills');

const passingRule: DoctorRule = {
  id: 'test_pass',
  severity: 'info',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check() {
    return { status: 'pass', message: 'all good' };
  },
};

const failingRule: DoctorRule = {
  id: 'test_fail',
  severity: 'fatal',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check() {
    return { status: 'fail', message: 'broken', hint: 'fix it' };
  },
};

const warningRule: DoctorRule = {
  id: 'test_warn',
  severity: 'warn',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check() {
    return { status: 'warn', message: 'mild concern' };
  },
};

const crashingRule: DoctorRule = {
  id: 'test_crash',
  severity: 'fatal',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check() {
    throw new Error('rule logic exploded');
  },
};

describe('resolveDoctorTargets', () => {
  it('resolves all variants in a directory', () => {
    const artifacts = resolveDoctorTargets(EXAMPLE_SKILLS_DIR, '/tmp');
    const names = artifacts.map((a) => a.name);
    assert.ok(names.length >= 2);
    assert.ok(names.some((n) => n === 'v1' || n === 'v2'));
  });

  it('resolves a single .md file', () => {
    const v1Path = join(EXAMPLE_SKILLS_DIR, 'v1.md');
    const artifacts = resolveDoctorTargets(v1Path, '/tmp');
    assert.equal(artifacts.length, 1);
    assert.ok(artifacts[0].content && artifacts[0].content.length > 0);
  });

  it('throws for non-existent target', () => {
    assert.throws(() => resolveDoctorTargets('/tmp/nonexistent-doctor-target.md', '/tmp'));
  });

  it('returns empty array for directory with no skills', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
    try {
      const artifacts = resolveDoctorTargets(tmp, '/tmp');
      assert.equal(artifacts.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to cwd/skills when target is null', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-cwd-'));
    try {
      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir);
      writeFileSync(join(skillsDir, 'a.md'), 'this is skill a content for testing.');
      writeFileSync(join(skillsDir, 'b.md'), 'this is skill b content for testing.');
      const artifacts = resolveDoctorTargets(null, tmp);
      assert.equal(artifacts.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runDoctor', () => {
  it('runs all custom rules per skill and aggregates totals', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
    });
    assert.equal(report.kind, 'doctor');
    assert.ok(report.skills.length >= 2);
    assert.equal(report.failed, false);
    assert.equal(report.warned, false);
    assert.equal(report.totals.pass, report.skills.length);
    for (const skill of report.skills) {
      assert.equal(skill.status, 'pass');
      assert.equal(skill.results.length, 1);
      assert.equal(skill.results[0].ruleId, 'test_pass');
    }
  });

  it('marks report.failed=true when any rule fails fatally', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [failingRule],
    });
    assert.equal(report.failed, true);
    assert.equal(report.warned, false);
    assert.ok(report.totals.fail >= 1);
  });

  it('marks report.warned=true (not failed) when only warn rules trigger', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [warningRule],
    });
    assert.equal(report.failed, false);
    assert.equal(report.warned, true);
  });

  it('catches rule exceptions and marks as fail rather than crashing the engine', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [crashingRule],
    });
    assert.equal(report.failed, true);
    for (const skill of report.skills) {
      assert.equal(skill.results[0].status, 'fail');
      assert.ok(skill.results[0].message.includes('rule crashed'));
      assert.ok((skill.results[0].detail as { ruleCrash?: boolean }).ruleCrash);
    }
  });

  it('continues running remaining rules after a fatal-fail', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [failingRule, passingRule],
    });
    for (const skill of report.skills) {
      assert.equal(skill.results.length, 2, 'both rules should run even after first fails');
      assert.equal(skill.results[0].status, 'fail');
      assert.equal(skill.results[1].status, 'pass');
    }
  });

  it('skipSmoke=true filters out executor_smoke rule from BUILTIN_RULES', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      skipSmoke: true,
      // 用 BUILTIN_RULES — 不传 rules 就走默认
    });
    for (const skill of report.skills) {
      const ruleIds = skill.results.map((r) => r.ruleId);
      assert.ok(!ruleIds.includes('executor_smoke'), 'executor_smoke should be filtered out');
    }
  });

  it('emits empty skills array (no crash) for empty target dir', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
    try {
      const report = await runDoctor({
        target: tmp,
        cwd: '/tmp',
        executorName: 'claude',
        model: 'sonnet',
        timeoutMs: 8000,
        lang: 'zh',
        rules: [passingRule],
      });
      assert.equal(report.skills.length, 0);
      assert.equal(report.failed, false);
      assert.equal(report.warned, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('produces machine-readable report with stable shape', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
    });
    assert.equal(typeof report.id, 'string');
    assert.ok(report.id.startsWith('doctor-'));
    assert.equal(typeof report.timestamp, 'string');
    assert.equal(typeof report.cliVersion, 'string');
    for (const skill of report.skills) {
      assert.equal(typeof skill.skillName, 'string');
      assert.equal(typeof skill.skillPath, 'string');
      for (const r of skill.results) {
        assert.equal(typeof r.ruleId, 'string');
        assert.equal(typeof r.message, 'string');
        assert.equal(typeof r.durationMs, 'number');
      }
    }
  });

  it('opts.artifacts overrides target resolution', async () => {
    // 用 artifacts 直传, 不论 target 指哪里, doctor 只检查传入的这一个 artifact
    const inlineArtifact: Artifact = {
      name: 'inline-fixture',
      kind: 'skill',
      source: 'inline',
      content: '你是一个内联测试 skill,内容足够长以通过 skill_readable rule。',
    };
    const report = await runDoctor({
      target: '/tmp/some/non-existent/path',  // 故意指错, 应被忽略
      artifacts: [inlineArtifact],
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
    });
    assert.equal(report.skills.length, 1);
    assert.equal(report.skills[0].skillName, 'inline-fixture');
    assert.equal(report.failed, false);
  });

  it('default rules include both BUILTIN_RULES and registerRule()-injected custom rules', async () => {
    __resetCustomRulesForTest();
    const customRule: DoctorRule = {
      id: 'custom_marker',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_readable',
      async check() {
        return { status: 'pass', message: 'custom rule ran' };
      },
    };
    registerRule(customRule);
    try {
      // 不传 opts.rules — 默认应该走 getRegisteredRules() = BUILTIN + custom
      const report = await runDoctor({
        target: EXAMPLE_SKILLS_DIR,
        cwd: '/tmp',
        executorName: 'claude',
        model: 'sonnet',
        timeoutMs: 8000,
        lang: 'zh',
        skipSmoke: true,
      });
      // 每个 skill 都应包含 custom_marker rule 的执行结果
      for (const skill of report.skills) {
        const ids = skill.results.map((r) => r.ruleId);
        assert.ok(ids.includes('custom_marker'), `expected custom_marker in skill.results: got ${ids.join(',')}`);
      }
    } finally {
      __resetCustomRulesForTest();
    }
  });

  it('passes samples to samples_contract_aligned via top-level option', async () => {
    const inlineArtifact: Artifact = {
      name: 'inline-with-samples',
      kind: 'skill',
      source: 'inline',
      content: '你是一个测试 skill 内容足够长足够长。',
    };
    const report = await runDoctor({
      artifacts: [inlineArtifact],
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      skipSmoke: true,
      samples: [],  // 空数组应触发 warn
    });
    const samplesResult = report.skills[0].results.find((r) => r.ruleId === 'samples_contract_aligned');
    assert.ok(samplesResult);
    assert.equal(samplesResult.status, 'warn');  // 不是 skipped
  });

  it('opts.artifacts: [] yields empty skills (no fallback to target scan)', async () => {
    // 显式空数组 = "本次评测无 skill" (e.g. baseline-only run); doctor 不应再扫 cwd/skills
    // 找无关草稿。target 故意指 EXAMPLE_SKILLS_DIR 也应被忽略。
    const report = await runDoctor({
      artifacts: [],
      target: EXAMPLE_SKILLS_DIR,  // 故意误导, 应被忽略
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
    });
    assert.equal(report.skills.length, 0);
    assert.equal(report.failed, false);
    assert.equal(report.warned, false);
  });

  it('opts.artifacts undefined falls back to target resolution (preserves omk doctor [path] UX)', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
    });
    assert.ok(report.skills.length >= 2);
  });

  it('result.labelKey is propagated from rule into DoctorRuleResult', async () => {
    const customRule: DoctorRule = {
      id: 'custom_label_test',
      severity: 'info',
      labelKey: 'cli.doctor.rule.executor_smoke',  // 任意已注册 key
      async check() {
        return { status: 'pass', message: 'ok' };
      },
    };
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [customRule],
    });
    for (const skill of report.skills) {
      const result = skill.results[0];
      assert.equal(result.ruleId, 'custom_label_test');
      assert.equal(result.labelKey, 'cli.doctor.rule.executor_smoke');
    }
  });

  it('passes top-level requires through to dependencies_present rule', async () => {
    // 显式 requires.tools 包一个不存在的工具, dependencies_present 应该 fail
    const inlineArtifact: Artifact = {
      name: 'inline-with-requires',
      kind: 'skill',
      source: 'inline',
      content: '你是一个测试 skill, 没有自动检出的依赖。',
    };
    const report = await runDoctor({
      artifacts: [inlineArtifact],
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      skipSmoke: true,
      requires: { tools: ['definitely-not-installed-cli-xyz123'] },
    });
    const depsResult = report.skills[0].results.find((r) => r.ruleId === 'dependencies_present');
    assert.ok(depsResult);
    assert.equal(depsResult.status, 'fail', 'doctor should reject missing required tool from samples wrapper requires');
  });
});

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDoctor, resolveDoctorTargets } from '../../src/doctor/index.js';
import { registerRule, __resetCustomRulesForTest } from '../../src/doctor/rules.js';
import type { Artifact } from '../../src/types/index.js';
import type { ComposerRule, DoctorRule, DoctorProgressInfo } from '../../src/types/doctor.js';

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

const skippedRule: DoctorRule = {
  id: 'test_skipped',
  severity: 'warn',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check() {
    return { status: 'skipped', message: 'preconditions not met' };
  },
};

// 关键回归夹具:severity=warn 但 status=fail。
// 老 classifySkillStatus 只把 severity=fatal && status=fail 算 fail、status=warn
// 算 warn,这种组合会被吃成 pass,gate 静默放行。修复后必须至少 roll 到 warn。
const warnSeverityFailingRule: DoctorRule = {
  id: 'test_warn_fail',
  severity: 'warn',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check() {
    return { status: 'fail', message: 'warn-severity dimension reported fail' };
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

  it('directory target containing SKILL.md is resolved as a single directory-skill (preserves skillRoot)', () => {
    // 关键回归: 目录自身就是 directory-skill 时, 必须按单 skill 解析,
    // 而非 discoverVariants 把 SKILL.md 当成名为 SKILL 的 variant。
    // 后者会让 skillRoot 丢失, 导致 SKILL.md 里的相对依赖 (assets/foo.md)
    // 锚到 doctor 的 cwd 而不是 skill 目录, 误报缺文件。
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-dirskill-'));
    try {
      const skillRoot = join(tmp, 'my-dir-skill');
      mkdirSync(skillRoot);
      mkdirSync(join(skillRoot, 'assets'));
      writeFileSync(join(skillRoot, 'SKILL.md'), '你是一个 directory-skill 的测试夹具,内容足够长。');
      writeFileSync(join(skillRoot, 'assets', 'foo.md'), 'asset content');

      const artifacts = resolveDoctorTargets(skillRoot, '/tmp');
      assert.equal(artifacts.length, 1, 'directory-skill 必须解析为单个 artifact');
      assert.equal(artifacts[0].name, 'my-dir-skill');
      assert.equal(artifacts[0].kind, 'skill');
      assert.equal(artifacts[0].skillRoot, skillRoot, 'skillRoot 必须指向 skill 根目录');
      assert.ok(artifacts[0].content && artifacts[0].content.includes('directory-skill'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('directory target without SKILL.md still falls back to batch variant discovery', () => {
    // 反向验证: 不是 directory-skill 的目录走老路径 (discoverVariants 批量)。
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-batch-'));
    try {
      writeFileSync(join(tmp, 'a.md'), 'this is skill a content for testing.');
      writeFileSync(join(tmp, 'b.md'), 'this is skill b content for testing.');
      const artifacts = resolveDoctorTargets(tmp, '/tmp');
      assert.equal(artifacts.length, 2);
      const names = artifacts.map((a) => a.name).sort();
      assert.deepEqual(names, ['a', 'b']);
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
    assert.equal(report.outcome, 'passed');
    assert.equal(report.totals.pass, report.skills.length);
    for (const skill of report.skills) {
      assert.equal(skill.status, 'pass');
      assert.equal(skill.results.length, 1);
      assert.equal(skill.results[0].ruleId, 'test_pass');
    }
  });

  it('emits per-skill onProgress (skill_start + skill_done) for batch', async () => {
    const events: DoctorProgressInfo[] = [];
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
      onProgress: (info) => events.push(info),
    });
    const n = report.skills.length;
    assert.ok(n >= 2);
    // 每个 skill 一对 start/done,且 start 紧跟 done。
    assert.equal(events.length, n * 2);
    assert.equal(events[0].phase, 'skill_start');
    assert.equal(events[1].phase, 'skill_done');
    assert.equal(events[0].skillName, events[1].skillName);
    const starts = events.filter((e) => e.phase === 'skill_start');
    const dones = events.filter((e) => e.phase === 'skill_done');
    assert.equal(starts.length, n);
    assert.equal(dones.length, n);
    // index 1..n 递增,total 恒为 n。
    starts.forEach((e, i) => {
      assert.equal(e.index, i + 1);
      assert.equal(e.total, n);
    });
    // skill_done 带 status + durationMs,且 skillName 能在报告里找到。
    for (const d of dones) {
      assert.equal(d.status, 'pass');
      assert.equal(typeof d.durationMs, 'number');
      assert.ok(report.skills.some((s) => s.skillName === d.skillName));
    }
  });

  it('does not emit onProgress for empty target (no skills)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-doctor-empty-'));
    try {
      const events: DoctorProgressInfo[] = [];
      await runDoctor({
        target: dir,
        cwd: dir,
        executorName: 'claude',
        model: 'sonnet',
        timeoutMs: 8000,
        lang: 'zh',
        rules: [passingRule],
        onProgress: (info) => events.push(info),
      });
      assert.equal(events.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks outcome=failed when any rule fails fatally', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [failingRule],
    });
    assert.equal(report.outcome, 'failed');
    assert.ok(report.totals.fail >= 1);
  });

  it('marks outcome=warnings_only when only warn rules trigger (no fatal-fail)', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [warningRule],
    });
    assert.equal(report.outcome, 'warnings_only');
  });

  it('rolls warn-severity status=fail up to skill warn (not pass) — regression for gate-silent bug', async () => {
    // 没修复前:health composer 对 warn 级维度(doc-clarity / instr-precision /
    // tool-conventions / examples)判"不健康"会产 status=fail,但
    // classifySkillStatus 只接 fatal-fail 当 fail、status=warn 当 warn,
    // 这条结果两边都不挂,skill 被判 pass,doctor --gate exit 0 静默放行。
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [warnSeverityFailingRule],
    });
    assert.equal(report.outcome, 'warnings_only', 'warn-severity fail must surface as warnings_only outcome');
    for (const skill of report.skills) {
      assert.equal(skill.status, 'warn', 'skill status must roll up to warn, not pass');
    }
    assert.equal(report.totals.pass, 0, 'no skill should be classified pass when a warn-severity rule fails');
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
    assert.equal(report.outcome, 'failed');
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
      assert.equal(report.outcome, 'passed');
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
    assert.equal(report.outcome, 'passed');
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
    assert.equal(report.outcome, 'passed');
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

      requires: { tools: ['definitely-not-installed-cli-xyz123'] },
    });
    const depsResult = report.skills[0].results.find((r) => r.ruleId === 'dependencies_present');
    assert.ok(depsResult);
    assert.equal(depsResult.status, 'fail', 'doctor should reject missing required tool from samples wrapper requires');
  });

  it('resolves requires.files relative to dependencyCwd, matching evaluation preflight rule', async () => {
    // 准备一个真实文件,放在临时 dependencyCwd 下;
    // dependencies_present 必须能在 dependencyCwd 找到它,而不是 opts.cwd。
    const tmpDepDir = mkdtempSync(join(tmpdir(), 'doctor-depcwd-'));
    const tmpOtherCwd = mkdtempSync(join(tmpdir(), 'doctor-other-cwd-'));
    try {
      writeFileSync(join(tmpDepDir, 'fixture.txt'), 'fixture content');
      const inlineArtifact: Artifact = {
        name: 'inline',
        kind: 'skill',
        source: 'inline',
        content: '你是一个测试 skill 内容足够长。',
      };
      // requires.files 显式指相对路径 fixture.txt; 必须在 dependencyCwd 下解析才能找到
      const reportPass = await runDoctor({
        artifacts: [inlineArtifact],
        cwd: tmpOtherCwd,        // 文件不在这里
        dependencyCwd: tmpDepDir, // 文件在这里 — 应被 rule 用作 base
        executorName: 'claude',
        model: 'sonnet',
        timeoutMs: 8000,
        lang: 'zh',
  
        requires: { files: ['fixture.txt'] },
      });
      const depsPass = reportPass.skills[0].results.find((r) => r.ruleId === 'dependencies_present');
      assert.ok(depsPass);
      assert.equal(depsPass.status, 'pass', 'should resolve fixture.txt against dependencyCwd');

      // 反向验证: 不传 dependencyCwd 时退回 cwd, fixture.txt 在 cwd 下找不到 → fail
      const reportFail = await runDoctor({
        artifacts: [inlineArtifact],
        cwd: tmpOtherCwd,
        executorName: 'claude',
        model: 'sonnet',
        timeoutMs: 8000,
        lang: 'zh',
  
        requires: { files: ['fixture.txt'] },
      });
      const depsFail = reportFail.skills[0].results.find((r) => r.ruleId === 'dependencies_present');
      assert.ok(depsFail);
      assert.equal(depsFail.status, 'fail', 'without dependencyCwd, falls back to cwd which lacks the file');
    } finally {
      rmSync(tmpDepDir, { recursive: true, force: true });
      rmSync(tmpOtherCwd, { recursive: true, force: true });
    }
  });

  it('artifact.cwd takes priority over opts.dependencyCwd for dependency resolution', async () => {
    const tmpArtifactCwd = mkdtempSync(join(tmpdir(), 'doctor-artifact-cwd-'));
    const tmpOptsDepCwd = mkdtempSync(join(tmpdir(), 'doctor-opts-dep-cwd-'));
    try {
      // fixture 只在 artifact.cwd 下; 验证 artifact.cwd 优先级最高
      writeFileSync(join(tmpArtifactCwd, 'fixture.txt'), 'a');
      const artifactWithCwd: Artifact = {
        name: 'inline',
        kind: 'skill',
        source: 'inline',
        content: '你是一个测试 skill 内容足够长。',
        cwd: tmpArtifactCwd, // 优先于 opts.dependencyCwd
      };
      const report = await runDoctor({
        artifacts: [artifactWithCwd],
        cwd: '/tmp',
        dependencyCwd: tmpOptsDepCwd, // 没 fixture, 应被 artifact.cwd 覆盖
        executorName: 'claude',
        model: 'sonnet',
        timeoutMs: 8000,
        lang: 'zh',
  
        requires: { files: ['fixture.txt'] },
      });
      const deps = report.skills[0].results.find((r) => r.ruleId === 'dependencies_present');
      assert.equal(deps?.status, 'pass', 'artifact.cwd priority should win and locate fixture there');
    } finally {
      rmSync(tmpArtifactCwd, { recursive: true, force: true });
      rmSync(tmpOptsDepCwd, { recursive: true, force: true });
    }
  });
});

describe('DoctorReport — CI-friendly schema fields', () => {
  it('stamps schemaVersion on every report (CI can pin/check)', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
    });
    assert.equal(typeof report.schemaVersion, 'string');
    assert.match(report.schemaVersion, /^\d+\.\d+\.\d+$/);
  });

  it('outcome="passed" when all skills pass cleanly', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule],
    });
    assert.equal(report.outcome, 'passed');
  });

  it('outcome="warnings_only" when only warn rules trigger (no fatal-fail)', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [warningRule],
    });
    assert.equal(report.outcome, 'warnings_only');
  });

  it('outcome="failed" when any rule fails fatally (dominates warns)', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [failingRule, warningRule],
    });
    assert.equal(report.outcome, 'failed');
  });

  it('ruleStats counts each rule outcome across all skills, including skipped', async () => {
    const report = await runDoctor({
      target: EXAMPLE_SKILLS_DIR,
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule, warningRule, skippedRule],
    });
    const skillCount = report.skills.length;
    assert.equal(report.ruleStats.pass, skillCount);
    assert.equal(report.ruleStats.warn, skillCount);
    assert.equal(report.ruleStats.skipped, skillCount);
    assert.equal(report.ruleStats.fail, 0);
    assert.equal(report.ruleStats.total, skillCount * 3);
    assert.equal(
      report.ruleStats.total,
      report.ruleStats.pass + report.ruleStats.warn + report.ruleStats.fail + report.ruleStats.skipped,
      'total must equal sum of statuses',
    );
  });

  it('totals (per-skill) and ruleStats (per-rule) report different granularities', async () => {
    // 1 skill with 1 pass + 1 warn rule:
    //   - per-skill outcome = warn (the worst non-fail outcome on the skill)
    //   - per-rule stats: pass=1, warn=1
    // This test pins the contract that totals != ruleStats by design.
    const inlineArtifact: Artifact = {
      name: 'inline-mixed',
      kind: 'skill',
      source: 'inline',
      content: '你是一个测试 skill,内容长度足够通过 readable rule。',
    };
    const report = await runDoctor({
      artifacts: [inlineArtifact],
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [passingRule, warningRule],
    });
    assert.equal(report.skills.length, 1);
    assert.equal(report.totals.pass, 0, 'skill outcome rolls up to warn, not pass');
    assert.equal(report.totals.warn, 1);
    assert.equal(report.ruleStats.pass, 1, 'per-rule pass count is unaffected by roll-up');
    assert.equal(report.ruleStats.warn, 1);
    assert.equal(report.ruleStats.total, 2);
    assert.equal(report.outcome, 'warnings_only');
  });

  it('expands ComposerRule outcomes into multiple results sharing groupId', async () => {
    const inlineArtifact: Artifact = {
      name: 'inline-composer',
      kind: 'skill',
      source: 'inline',
      content: '你是一个测试 skill,内容足够长以通过 readable 检测。',
    };
    const composer: ComposerRule = {
      id: 'test_composer',
      ruleKind: 'composer',
      severity: 'fatal',
      labelKey: 'cli.doctor.rule.skill_readable',
      async checkAll() {
        return [
          { subId: 'd1', status: 'fail',  message: 'd1 failed',  severity: 'fatal' },
          { subId: 'd2', status: 'warn',  message: 'd2 warning', severity: 'warn' },
          { subId: 'd3', status: 'pass',  message: 'd3 ok' },
          { subId: '_summary', status: 'pass', message: 'overall summary', severity: 'info' },
        ];
      },
    };
    const report = await runDoctor({
      artifacts: [inlineArtifact],
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [composer],
    });
    const results = report.skills[0].results;
    assert.equal(results.length, 4, 'composer 4 outcomes should expand to 4 results');
    const ids = results.map((r) => r.ruleId);
    assert.deepEqual(ids, [
      'test_composer:d1',
      'test_composer:d2',
      'test_composer:d3',
      'test_composer:_summary',
    ]);
    for (const r of results) assert.equal(r.groupId, 'test_composer');
    // skill 状态应该 roll up 到 fail (因为 d1 是 fatal+fail)
    assert.equal(report.skills[0].status, 'fail');
    assert.equal(report.outcome, 'failed');
    // ruleStats 应该统计每条 sub-result(4 条)
    assert.equal(report.ruleStats.total, 4);
    assert.equal(report.ruleStats.fail, 1);
    assert.equal(report.ruleStats.warn, 1);
    assert.equal(report.ruleStats.pass, 2);
  });

  it('catches composer crashes and emits a single fail summary', async () => {
    const inlineArtifact: Artifact = {
      name: 'inline-crash',
      kind: 'skill',
      source: 'inline',
      content: '你是一个测试 skill,长度足够。',
    };
    const crashing: ComposerRule = {
      id: 'crash_composer',
      ruleKind: 'composer',
      severity: 'fatal',
      labelKey: 'cli.doctor.rule.skill_readable',
      async checkAll() { throw new Error('composer exploded'); },
    };
    const report = await runDoctor({
      artifacts: [inlineArtifact],
      cwd: '/tmp',
      executorName: 'claude',
      model: 'sonnet',
      timeoutMs: 8000,
      lang: 'zh',
      rules: [crashing],
    });
    const results = report.skills[0].results;
    assert.equal(results.length, 1);
    assert.equal(results[0].ruleId, 'crash_composer:_summary');
    assert.equal(results[0].status, 'fail');
    assert.ok(results[0].message.includes('composer crashed'));
    assert.equal((results[0].detail as { ruleCrash?: boolean }).ruleCrash, true);
  });
});

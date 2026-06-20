import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');
const EXAMPLE_SKILL = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'skills', 'v1.md');
const EXAMPLE_SKILLS_DIR = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'skills');
// Fixture executor bypasses real LLM calls; outcome is steered via
// OMK_DOCTOR_FIXTURE_OUTCOME env (pass/fail).
const DOCTOR_FIXTURE = `node ${join(PROJECT_ROOT, 'test', 'fixtures', 'doctor-fixture-executor.mjs')}`;

interface ExecError extends Error {
  code: number;
  stdout: string;
  stderr: string;
}

describe('omk doctor CLI', () => {
  it('--help shows usage with key flags and check items', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help']);
    assert.ok(stdout.includes('omk doctor'));
    assert.ok(stdout.includes('健康度'));
    assert.ok(stdout.includes('--json'));
    assert.ok(stdout.includes('--gate'));
    assert.ok(stdout.includes('--samples'));
  });

  it('--help --lang en shows English usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('omk doctor'));
    assert.ok(stdout.includes('health audit'));
    assert.ok(!stdout.includes('健康度'));
  });

  it('--json on example skill outputs valid DoctorReport with kind=doctor', async () => {
    const { stdout } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
      '--json',
      '--executor', DOCTOR_FIXTURE,
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'doctor');
    assert.ok(Array.isArray(parsed.skills));
    assert.ok(parsed.skills.length >= 1);
    assert.equal(parsed.outcome, 'passed');
  });

  it('--json on directory batches all skills', async () => {
    const { stdout } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILLS_DIR,
      '--json',
      '--executor', DOCTOR_FIXTURE,
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'doctor');
    assert.ok(parsed.skills.length >= 2, 'should batch multiple skills from the dir');
  });

  it('--gate exits 1 on non-existent target', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'doctor', '/tmp/__nonexistent_doctor_target__', '--gate']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1);
        return true;
      },
    );
  });

  it('--gate exits 0 on passing skill', async () => {
    const { stderr } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
      '--gate',
      '--executor', DOCTOR_FIXTURE,
    ]);
    // Pass case: stdout silent, stderr should not contain "doctor failed:"
    assert.ok(!stderr.includes('doctor failed:'));
  });

  it('exits 1 when doctor reports failed (LLM audit returns unhealthy)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-cli-fail-'));
    try {
      const skillPath = join(tmp, 'broken.md');
      writeFileSync(skillPath, '一个内容足够长但被 fixture 标记为不健康的 skill 文件。');
      await assert.rejects(
        () => execFileAsync('node', [CLI, 'doctor', skillPath, '--gate', '--executor', DOCTOR_FIXTURE], {
          env: { ...process.env, OMK_DOCTOR_FIXTURE_OUTCOME: 'fail' },
        }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'));
          return true;
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('default (no flags) renders human-readable text to stderr', async () => {
    const { stderr } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
      '--executor', DOCTOR_FIXTURE,
    ]);
    assert.ok(stderr.includes('健康检查'));
    assert.ok(stderr.includes('总览:'));
  });

  it('auto-detects samples from the target project when cwd differs', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-target-samples-'));
    const outside = mkdtempSync(join(tmpdir(), 'doctor-outside-cwd-'));
    try {
      const project = join(tmp, 'project');
      const skillRoot = join(project, 'skills', 'review');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), '你是一个测试用的代码审查 skill，内容足够长。');
      writeFileSync(join(project, 'eval-samples.json'), JSON.stringify([
        { sample_id: 's1', prompt: 'review this code' },
      ]));

      const { stderr } = await execFileAsync('node', [
        CLI,
        'doctor',
        join(project, 'skills'),
        '--lang', 'zh',
        '--executor', DOCTOR_FIXTURE,
      ], { cwd: outside });
      assert.ok(stderr.includes('使用评测用例文件'), stderr);
      assert.ok(stderr.includes('eval-samples.json'), stderr);
      assert.ok(!stderr.includes('未提供 samples'), stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('auto-detects skill-local .omk samples for a directory skill target', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-skill-local-samples-'));
    try {
      const skillRoot = join(tmp, 'skills', 'release-readiness');
      mkdirSync(join(skillRoot, '.omk'), { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), '你是一个测试用的发布检查 skill，内容足够长。');
      writeFileSync(join(skillRoot, '.omk', 'samples.json'), JSON.stringify([
        { sample_id: 's1', prompt: 'review release readiness' },
      ]));

      const { stderr } = await execFileAsync('node', [
        CLI,
        'doctor',
        skillRoot,
        '--static-only',
        '--lang', 'zh',
        '--executor', DOCTOR_FIXTURE,
      ], { cwd: tmp });
      assert.ok(stderr.includes('使用评测用例文件'), stderr);
      assert.ok(stderr.includes(join(skillRoot, '.omk')), stderr);
      assert.ok(stderr.includes('用例 1 条'), stderr);
      assert.ok(!stderr.includes('未提供 samples'), stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('warns when directory skill still uses deprecated eval-samples path', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-deprecated-samples-'));
    try {
      const skillRoot = join(tmp, 'skills', 'review');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), '你是一个测试用的代码审查 skill，内容足够长。');
      writeFileSync(join(skillRoot, 'eval-samples.json'), JSON.stringify([
        { sample_id: 's1', prompt: 'review legacy samples location' },
      ]));

      const { stderr } = await execFileAsync('node', [
        CLI,
        'doctor',
        skillRoot,
        '--static-only',
        '--lang', 'zh',
        '--executor', DOCTOR_FIXTURE,
      ], { cwd: tmp });
      assert.ok(stderr.includes('发现旧的目录 skill 用例位置'), stderr);
      assert.ok(stderr.includes(join(skillRoot, 'eval-samples.json')), stderr);
      assert.ok(stderr.includes(join(skillRoot, '.omk', 'samples.json')), stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--samples overrides auto-detected samples', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-explicit-samples-'));
    try {
      const skillRoot = join(tmp, 'skills', 'review');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), '你是一个测试用的代码审查 skill，内容足够长。');
      writeFileSync(join(tmp, 'eval-samples.json'), JSON.stringify([
        { sample_id: 'auto', prompt: 'auto sample' },
      ]));
      const explicitSamples = join(tmp, 'explicit-samples.json');
      writeFileSync(explicitSamples, JSON.stringify([
        { sample_id: 'e1', prompt: 'explicit sample 1' },
        { sample_id: 'e2', prompt: 'explicit sample 2' },
      ]));

      const { stderr } = await execFileAsync('node', [
        CLI,
        'doctor',
        join(tmp, 'skills'),
        '--samples', explicitSamples,
        '--lang', 'zh',
        '--executor', DOCTOR_FIXTURE,
      ], { cwd: tmp });
      assert.ok(stderr.includes(`使用评测用例文件：${explicitSamples}`), stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--static-only runs offline (no executor needed) and emits DoctorReport with static rule results', async () => {
    // Note: no --executor flag here — --static-only must not require an LLM.
    // The default 'claude' executor in PATH may or may not exist; either way
    // doctor should exit cleanly because no rule actually calls it.
    const { stdout } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
      '--json',
      '--static-only',
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'doctor');
    assert.ok(parsed.skills.length >= 1);
    // Static rules present, composer (skill_health) absent under --static-only.
    const staticRuleIds = parsed.skills[0].results.map((r: { ruleId: string }) => r.ruleId);
    assert.ok(staticRuleIds.includes('skill_readable'), `expected skill_readable, got: ${staticRuleIds.join(',')}`);
    assert.ok(staticRuleIds.includes('skill_metadata'), `expected skill_metadata, got: ${staticRuleIds.join(',')}`);
    assert.ok(!staticRuleIds.some((id: string) => id.startsWith('skill_health')),
      `expected no skill_health composer results in static-only mode, got: ${staticRuleIds.join(',')}`);
  });

  it('persists doctor graph sidecar and Markdown evidence card', async () => {
    const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-graph-sidecar-'));
    try {
      const skillRoot = join(tmp, 'skills', 'review');
      mkdirSync(join(skillRoot, 'references'), { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), [
        '---',
        'workflows:',
        '  - id: review',
        '    nodes:',
        '      - id: inspect',
        '        action: 检查输入',
        '---',
        '# Review Skill',
        '这个 skill 内容足够长，用于测试 doctor graph sidecar。',
      ].join('\n'));
      writeFileSync(join(skillRoot, 'references', 'rules.md'), 'rules');

      const outputDir = join(tmp, '.omk', 'doctors');
      await execFileAsync('node', [
        CLI,
        'doctor',
        skillRoot,
        '--static-only',
        '--output-dir', outputDir,
      ], { cwd: tmp });

      const graphDir = join(tmp, '.omk', 'graphs', 'doctor');
      assert.ok(existsSync(graphDir), 'graph sidecar dir should exist');
      const files = readdirSync(graphDir);
      const jsonFile = files.find((file) => file.endsWith('.graph.json'));
      const mdFile = files.find((file) => file.endsWith('.card.md'));
      assert.ok(jsonFile, `expected graph json, got: ${files.join(', ')}`);
      assert.ok(mdFile, `expected evidence card markdown, got: ${files.join(', ')}`);
      assert.match(jsonFile, /^review-\d{8}T\d{6}-\d+-[a-z0-9]{4}\.graph\.json$/);
      const graph = JSON.parse(readFileSync(join(graphDir, jsonFile), 'utf-8'));
      assert.equal(graph.documentKind, 'artifact-graph');
      assert.equal(graph.source.sourceKind, 'doctor');
      assert.ok(graph.nodes.some((node: { nodeKind: string; label: string }) => node.nodeKind === 'reference' && node.label === 'references/rules.md'));
      assert.ok(!graph.edges.some((edge: { edgeKind: string }) => edge.edgeKind === 'covers'));
      const card = readFileSync(join(graphDir, mdFile), 'utf-8');
      assert.ok(card.includes('Skill Evidence Card'));
      assert.ok(card.includes('eval 未测量'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('product dispatch lists doctor as a top-level command', async () => {
    // omk --help 走 oclif 的 COMMANDS 列表,doctor 出现在其中。
    const { stdout } = await execFileAsync('node', [CLI, '--help']);
    assert.ok(stdout.includes('doctor'), `--help missing 'doctor' command listing:\n${stdout}`);
    assert.ok(/COMMANDS|TOPICS/i.test(stdout), `--help should have oclif COMMANDS / TOPICS block:\n${stdout}`);
  });
});

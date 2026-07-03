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
    assert.ok(stdout.includes('--repeat'));
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
    const ids = (parsed.skills[0].results as Array<{ ruleId: string }>).map((r) => r.ruleId);
    assert.ok(ids.includes('skill_readable'), `default doctor should run static rules, got: ${ids.join(',')}`);
    assert.ok(ids.includes('skill_metadata'));
    assert.ok(ids.includes('dependencies_present'));
    assert.ok(!ids.includes('samples_contract_aligned'), 'samples-contract 不归 CLI 默认 doctor');
    assert.ok(ids.some((id) => id.startsWith('skill_health')), 'default doctor should run LLM health audit');
  });

  it('--static-only runs offline (no executor) with static rules only, no LLM / samples-contract', async () => {
    // 不给 --executor → 证明 --static-only 不需要 LLM
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', EXAMPLE_SKILL, '--static-only', '--json']);
    const ids = (JSON.parse(stdout).skills[0].results as Array<{ ruleId: string }>).map((r) => r.ruleId);
    assert.ok(ids.includes('skill_readable'), `expected skill_readable, got: ${ids.join(',')}`);
    assert.ok(ids.includes('skill_metadata'));
    assert.ok(ids.includes('dependencies_present'));
    assert.ok(!ids.includes('samples_contract_aligned'), 'samples-contract 不归 CLI static-only');
    assert.ok(!ids.some((id) => id.startsWith('skill_health')), '不跑 LLM 健康审计');
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
          assert.ok(e.stderr.includes('修复清单'), e.stderr);
          assert.ok(e.stderr.includes('下一步：先修阻塞项'), e.stderr);
          assert.ok(e.stderr.includes('omk doctor --gate'), e.stderr);
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
    assert.ok(stderr.includes('下一步：doctor 已通过，可以继续运行 `omk eval`。'));
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
        '--repeat', '1',
        '--executor', DOCTOR_FIXTURE,
        '--output-dir', outputDir,
      ], { cwd: tmp });

      const graphDir = join(tmp, '.omk', 'graphs', 'doctor');
      assert.ok(existsSync(graphDir), 'graph sidecar dir should exist');
      const files = readdirSync(graphDir);
      const jsonFile = files.find((file) => file.endsWith('.graph.json'));
      const mdFile = files.find((file) => file.endsWith('.card.md'));
      assert.ok(jsonFile, `expected graph json, got: ${files.join(', ')}`);
      assert.ok(mdFile, `expected evidence card markdown, got: ${files.join(', ')}`);
      assert.match(jsonFile, /^review-\d{8}T\d{6}-[a-z0-9]{4}\.graph\.json$/);
      assert.equal(mdFile, jsonFile.replace(/\.graph\.json$/, '.card.md'));
      const graph = JSON.parse(readFileSync(join(graphDir, jsonFile), 'utf-8'));
      assert.equal(graph.documentKind, 'artifact-graph');
      assert.equal(graph.source.sourceKind, 'doctor');
      assert.ok(graph.nodes.some((node: { nodeKind: string; label: string }) => node.nodeKind === 'reference' && node.label === 'references/rules.md'));
      assert.ok(!graph.edges.some((edge: { edgeKind: string }) => edge.edgeKind === 'covers'));
      const card = readFileSync(join(graphDir, mdFile), 'utf-8');
      assert.ok(card.includes('知识图谱摘要'));
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

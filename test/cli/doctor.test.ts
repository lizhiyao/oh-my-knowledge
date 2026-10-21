import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import DoctorCommand from '../../src/cli/commands/doctor.js';
import { runCommand, type CommandRunError } from '../helpers/run-command.js';
import * as doctorFixer from '../../src/knowledge/artifacts/doctor/fixer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const EXAMPLE_SKILL = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'skills', 'v1.md');
const EXAMPLE_SKILLS_DIR = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'skills');
// Fixture executor bypasses real LLM calls; outcome is steered via
// OMK_DOCTOR_FIXTURE_OUTCOME env (pass/fail).
const DOCTOR_FIXTURE = `node ${join(PROJECT_ROOT, 'test', 'fixtures', 'doctor-fixture-executor.mjs')}`;
let isolatedCwd = '';

beforeEach(() => {
  isolatedCwd = mkdtempSync(join(tmpdir(), 'omk-doctor-cli-test-'));
});

afterEach(() => {
  rmSync(isolatedCwd, { recursive: true, force: true });
  isolatedCwd = '';
});

async function runDoctorCommand(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand(DoctorCommand, args, {
    ...options,
    cwd: options.cwd ?? isolatedCwd,
  });
}

describe('omk doctor command', () => {
  it.each(['zh', 'en'] as const)('offers static-only checks when no model is configured (%s)', async (lang) => {
    await assert.rejects(
      () => runDoctorCommand(['--json', '--lang', lang], { env: {
        HOME: isolatedCwd, USERPROFILE: isolatedCwd, CODEX_HOME: join(isolatedCwd, 'codex'),
        OMK_EXECUTOR: '', OMK_MODEL: '',
      } }),
      (error: unknown) => {
        const result = error as CommandRunError;
        assert.equal(result.code, 2);
        assert.equal(result.stdout, '', 'missing configuration must not produce a report');
        assert.ok(result.stderr.includes('--model <model>') && result.stderr.includes('OMK_MODEL'));
        assert.ok(result.stderr.includes('omk doctor --static-only'));
        assert.ok(result.stderr.includes(lang === 'zh' ? '跳过 LLM 健康度审计' : 'skip the LLM health audit'));
        return true;
      },
    );
    assert.ok(!existsSync(join(isolatedCwd, '.omk')), 'missing configuration must not persist a report');
  });

  it('preserves and shell-quotes the target in the no-model hint, then accepts the static-only command', async () => {
    const target = "-review's $skill.md";
    writeFileSync(join(isolatedCwd, target), 'Review the supplied code and explain any concrete correctness issues.');
    const env = {
      HOME: isolatedCwd, USERPROFILE: isolatedCwd, CODEX_HOME: join(isolatedCwd, 'codex'),
      OMK_EXECUTOR: '', OMK_MODEL: '',
    };
    await assert.rejects(
      () => runDoctorCommand(['--executor', 'openai-api', '--lang', 'en', '--', target], { env }),
      (error: unknown) => {
        const result = error as CommandRunError;
        assert.equal(result.code, 2);
        assert.ok(result.stderr.includes("omk doctor --static-only -- '-review'\\''s $skill.md'"), result.stderr);
        return true;
      },
    );
    assert.ok(!existsSync(join(isolatedCwd, '.omk')));
    const { stdout } = await runDoctorCommand(['--json', '--static-only', '--', target], { env });
    const report = JSON.parse(stdout);
    assert.equal(report.skills.length, 1);
    const ids = (report.skills[0].results as Array<{ ruleId: string }>).map((result) => result.ruleId);
    assert.ok(ids.includes('skill_readable') && ids.includes('skill_metadata') && ids.includes('dependencies_present'));
    assert.ok(!ids.includes('samples_contract_aligned'), 'static-only must not load the samples contract');
    assert.ok(!ids.some((id) => id.startsWith('skill_health')), 'static-only must not run LLM health checks');
    assert.ok(existsSync(join(isolatedCwd, '.omk', 'doctor')));
  });

  it('--fix reaches repair for failed advisory dimensions even when the overall gate does not fail', async () => {
    const repair = vi.spyOn(doctorFixer, 'runDoctorFix').mockResolvedValue(false);
    try {
      await runDoctorCommand([
        EXAMPLE_SKILL, '--fix', '--repeat', '1', '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model',
      ], { env: { ...process.env, OMK_DOCTOR_FIXTURE_OUTCOME: 'advisory' } });
      assert.equal(repair.mock.calls.length, 1);
      assert.notEqual(repair.mock.calls[0][0].report.outcome, 'failed');
      assert.ok(repair.mock.calls[0][0].report.skills[0].results.some((result) => result.status === 'fail'));
    } finally {
      repair.mockRestore();
    }
  });

  it('--json on example skill outputs valid DoctorReport with kind=doctor', async () => {
    const { stdout } = await runDoctorCommand([
      EXAMPLE_SKILL,
      '--json',
      '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model',
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
    assert.ok(
      existsSync(join(isolatedCwd, '.omk', 'doctor')),
      'default doctor persistence should stay inside the isolated test project',
    );
  });

  it('--json on directory batches all skills', async () => {
    const { stdout } = await runDoctorCommand([
      EXAMPLE_SKILLS_DIR,
      '--json',
      '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model',
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'doctor');
    assert.ok(parsed.skills.length >= 2, 'should batch multiple skills from the dir');
  });

  it('--gate exits 1 on non-existent target', async () => {
    await assert.rejects(
      () => runDoctorCommand(['/tmp/__nonexistent_doctor_target__', '--model', 'fixture-model', '--gate']),
      (err: unknown) => {
        const e = err as CommandRunError;
        assert.equal(e.code, 1);
        return true;
      },
    );
  });

  it('--gate exits 0 on passing skill', async () => {
    const { stderr } = await runDoctorCommand([
      EXAMPLE_SKILL,
      '--gate',
      '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model',
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
        () => runDoctorCommand([skillPath, '--gate', '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model'], {
          env: { ...process.env, OMK_DOCTOR_FIXTURE_OUTCOME: 'fail' },
        }),
        (err: unknown) => {
          const e = err as CommandRunError;
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
    const { stderr } = await runDoctorCommand([
      EXAMPLE_SKILL,
      '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model',
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

      const outputDir = join(tmp, '.omk', 'doctor');
      await runDoctorCommand([
        skillRoot,
        '--repeat', '1',
        '--executor', DOCTOR_FIXTURE, '--model', 'fixture-model',
        '--output-dir', outputDir,
      ], { cwd: tmp });

      const doctorDir = join(tmp, '.omk', 'doctor');
      const recordDir = readdirSync(doctorDir).find((entry) => entry.startsWith('review-'));
      assert.ok(recordDir, 'doctor report bundle should exist');
      const graphDir = join(doctorDir, recordDir, 'derived');
      assert.ok(existsSync(graphDir), 'derived sidecar dir should exist');
      const files = readdirSync(graphDir);
      assert.deepEqual(files.sort(), ['card.md', 'graph.json']);
      const graph = JSON.parse(readFileSync(join(graphDir, 'graph.json'), 'utf-8'));
      assert.equal(graph.documentKind, 'artifact-graph');
      assert.equal(graph.source.sourceKind, 'doctor');
      assert.ok(graph.nodes.some((node: { nodeKind: string; label: string }) => node.nodeKind === 'reference' && node.label === 'references/rules.md'));
      assert.ok(!graph.edges.some((edge: { edgeKind: string }) => edge.edgeKind === 'covers'));
      const card = readFileSync(join(graphDir, 'card.md'), 'utf-8');
      assert.ok(card.includes('知识图谱摘要'));
      assert.ok(card.includes('eval 未测量'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

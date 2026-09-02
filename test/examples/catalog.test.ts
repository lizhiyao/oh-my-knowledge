import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import EvalCommand from '../../src/cli/commands/eval/index.js';
import { loadSamples } from '../../src/eval-workflows/inputs/load-samples.js';
import { runCommand } from '../helpers/run-command.js';

const examplesRoot = resolve('examples');
const publicExamples = [
  'agent-runtime',
  'codex-observe-router',
  'codex-task-trajectory',
  'custom-executor',
  'rag-eval',
  'skill-map-showcase',
] as const;

const sampleSets = [
  'examples/agent-runtime/eval-samples.json',
  'examples/custom-executor/eval-samples.json',
  'examples/rag-eval/eval-samples.yaml',
  'examples/skill-map-showcase/skills/release-readiness/.omk/eval-samples.json',
] as const;

describe('public examples catalog', () => {
  it('contains only the curated, indexed example directories', () => {
    const actual = readdirSync(examplesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(actual, [...publicExamples].sort());

    const enIndex = readFileSync(resolve(examplesRoot, 'README.md'), 'utf8');
    const zhIndex = readFileSync(resolve(examplesRoot, 'README.zh.md'), 'utf8');
    for (const name of publicExamples) {
      assert.match(enIndex, new RegExp(`\\./${name}(?:[)/])`), `English index omits ${name}`);
      assert.match(zhIndex, new RegExp(`\\./${name}(?:[)/])`), `Chinese index omits ${name}`);
    }
    assert.match(enIndex, /omk init demo/);
    assert.match(zhIndex, /omk init demo/);
  });

  it('gives every public example bilingual instructions and an evidence boundary', () => {
    for (const name of publicExamples) {
      const enPath = resolve(examplesRoot, name, 'README.md');
      const zhPath = resolve(examplesRoot, name, 'README.zh.md');
      assert.equal(existsSync(enPath), true, `${name} is missing README.md`);
      assert.equal(existsSync(zhPath), true, `${name} is missing README.zh.md`);
      assert.match(readFileSync(enPath, 'utf8'), /## Evidence boundary/);
      assert.match(readFileSync(zhPath, 'utf8'), /## 证据边界/);
    }
  });

  it('keeps every public sample set loadable through the canonical input boundary', () => {
    for (const path of sampleSets) {
      const { samples } = loadSamples(resolve(path));
      assert.ok(samples.length > 0, `${path} must contain at least one sample`);
    }
  });

  it('keeps the documented evaluation dry-runs compilable', async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'omk-example-dry-run-'));
    const offlineExecutor = resolve(examplesRoot, 'custom-executor', 'echo-executor.sh');
    const cases = [
      {
        directory: 'agent-runtime',
        args: ['--control', 'repo-answerer', '--treatment', 'repo-navigator', '--dry-run'],
      },
      {
        directory: 'rag-eval',
        args: ['--control', 'context-answerer', '--treatment', 'rag-answerer', '--dry-run'],
      },
      {
        directory: 'skill-map-showcase',
        args: ['--control', 'release-checklist', '--treatment', 'release-readiness', '--dry-run'],
      },
    ] as const;

    try {
      for (const example of cases) {
        const { stdout } = await runCommand(EvalCommand, [
          ...example.args,
          '--executor', offlineExecutor,
          '--output-dir', outputDirectory,
        ], {
          cwd: resolve(examplesRoot, example.directory),
        });
        assert.match(stdout, /"projectionKind": "core-cli-dry-run"/);
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('runs the documented echo executor through the sealed exchange', async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'omk-example-output-'));
    try {
      const { stdout } = await runCommand(EvalCommand, [
        '--control', 'baseline',
        '--treatment', 'echo-assistant',
        '--executor', './echo-executor.sh',
        '--no-judge',
        '--no-diagnostic',
        '--no-serve',
        '--no-cache',
        '--bootstrap-samples', '100',
        '--output-dir', outputDirectory,
        '--report-only',
      ], { cwd: resolve(examplesRoot, 'custom-executor') });
      assert.match(stdout, /"runStatus": "completed"/);
      assert.match(stdout, /"succeeded": 4/);
      assert.match(stdout, /"failed": 0/);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkFacts,
  extractPathClaims,
} from '../../src/eval-core/fact-checker.js';
import { executeTasks } from '../../src/eval-core/evaluation-execution.js';
import { buildTasksFromArtifacts } from '../../src/eval-core/task-planner.js';
import type { Artifact, ExecutorFn, Sample } from '../../src/types/index.js';

describe('fact-checker path extraction', () => {
  it('does not treat method calls as file paths', () => {
    const claims = extractPathClaims('const data = await res.json(); return data;');
    assert.ok(!claims.includes('res.json'));
  });

  it('still extracts real file paths with known extensions', () => {
    const claims = extractPathClaims('Update eval-samples.json and src/cli/index.ts.');
    assert.ok(claims.includes('eval-samples.json'));
    assert.ok(claims.includes('src/cli/index.ts'));
  });

  it('does not treat Node.js as a file path', () => {
    const claims = extractPathClaims('The Node.js service sends traces to app.ts.');
    assert.deepEqual(claims, ['app.ts']);
  });

  it('extracts neutral and provider-compatible agent paths', () => {
    const claims = extractPathClaims(
      'Read .agents/skills/review/SKILL.md, .codex/skills/a/SKILL.md, '
      + '.gemini/skills/b/SKILL.md, and .claude/skills/c/SKILL.md.',
    );
    assert.deepEqual(claims, [
      '.agents/skills/review/SKILL.md',
      '.codex/skills/a/SKILL.md',
      '.gemini/skills/b/SKILL.md',
      '.claude/skills/c/SKILL.md',
    ]);
  });

  it('never verifies a path claim outside the evaluation cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-fact-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'omk-fact-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'secret');
      const result = checkFacts(
        'The file is at .agents/../../'
        + `${outside.split('/').at(-1)}/secret.md`,
        root,
      );

      assert.equal(result.totalCount, 1);
      assert.equal(result.verifiedCount, 0);
      assert.match(result.claims[0].evidence || '', /outside the evaluation cwd/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('labels facts supplied by the shared sample context', () => {
    const result = checkFacts(
      'Initialize Sentry in src/app.ts.',
      { context: 'The confirmed application entry is src/app.ts.' },
    );

    assert.equal(result.verifiedCount, 1);
    assert.equal(result.claims[0].evidence, 'source=context(sample.context)');
  });

  it('labels declarative fixture evidence', () => {
    const result = checkFacts(
      'Run scripts/verify.sh.',
      { declaredFiles: ['$SKILL_DIR/scripts/verify.sh'] },
    );

    assert.equal(result.verifiedCount, 1);
    assert.equal(
      result.claims[0].evidence,
      'source=fixture(sample.environment.files_available)',
    );
  });

  it('does not turn an uncheckable path into a failed fact', () => {
    const result = checkFacts(
      'Consider adding src/optional.ts.',
      { context: 'The confirmed application entry is src/app.ts.' },
    );

    assert.equal(result.totalCount, 0);
  });

  it('does not equate different relative paths by basename alone', () => {
    const result = checkFacts(
      'Use src/app.ts.',
      { context: 'The legacy entry is app.ts.' },
    );

    assert.equal(result.totalCount, 0);
  });

  it('labels checks against the shared sample filesystem', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-fact-fixture-'));
    try {
      writeFileSync(join(root, 'app.js'), 'App({});');
      const result = checkFacts('Use app.js.', { cwd: root });

      assert.equal(result.verifiedCount, 1);
      assert.match(
        result.claims[0].evidence || '',
        /^source=runtime-filesystem\(sample\.cwd\); .*\/app\.js exists$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the same shared evidence for control and treatment arms', async () => {
    const sample: Sample = {
      sample_id: 'symmetric-facts',
      prompt: 'Describe the integration.',
      context: 'app.js is the confirmed application entry.',
    };
    const artifacts: Artifact[] = [
      { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
      {
        name: 'treatment',
        kind: 'skill',
        source: 'custom',
        content: 'Use the project entry.',
        skillRoot: '/tmp/arm-specific-skill-tree',
      },
    ];
    const executor: ExecutorFn = async () => ({
      ok: true,
      output: 'Update app.js for the Node.js service.',
      durationMs: 1,
      durationApiMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      stopReason: 'end_turn',
      numTurns: 1,
    });
    const tasks = buildTasksFromArtifacts([sample], artifacts);

    const { results } = await executeTasks({
      tasks,
      executor,
      executorName: 'test',
      model: 'test-model',
      noJudge: true,
      samplesPath: '/tmp/samples.json',
      concurrency: 1,
      noCache: true,
      verbose: false,
      judgeModels: [{ executor: 'test', model: 'test-judge' }],
      judgeExecutors: { test: executor },
    });

    const baseline = results['symmetric-facts'].baseline.factCheck;
    const treatment = results['symmetric-facts'].treatment.factCheck;
    assert.deepEqual(treatment, baseline);
    assert.deepEqual(baseline?.claims, [{
      type: 'file-path',
      value: 'app.js',
      verified: true,
      evidence: 'source=context(sample.context)',
    }]);
  });
});

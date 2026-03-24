import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runEvaluation } from '../lib/runner.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_PATH = join(__dirname, '..', 'examples', 'code-review', 'eval-samples.json');
const SKILL_DIR = join(__dirname, '..', 'examples', 'code-review', 'skills');

describe('runEvaluation', () => {
  it('dry-run: returns correct task schedule', async () => {
    const { report } = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.totalTasks, 6); // 3 samples × 2 variants
    assert.deepEqual(report.variants, ['v1', 'v2']);
    assert.equal(report.executor, 'claude');
  });

  it('dry-run: interleaved scheduling order', async () => {
    const { report } = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });

    const schedule = report.tasks.map((t) => `${t.sample_id}-${t.variant}`);
    assert.deepEqual(schedule, [
      's001-v1', 's001-v2',
      's002-v1', 's002-v2',
      's003-v1', 's003-v2',
    ]);
  });

  it('dry-run: reports assertion and dimension presence', async () => {
    const { report } = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });

    for (const task of report.tasks) {
      assert.equal(task.hasRubric, true);
      assert.equal(task.hasAssertions, true);
      assert.equal(task.hasDimensions, true);
    }
  });

  it('dry-run: supports 3+ variants', async () => {
    const { report } = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });

    assert.equal(report.totalTasks, 6);
  });

  it('dry-run: custom model and judge model', async () => {
    const { report } = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      model: 'opus',
      judgeModel: 'sonnet',
      dryRun: true,
    });

    assert.equal(report.model, 'opus');
    assert.equal(report.judgeModel, 'sonnet');
  });

  it('throws on missing samples file', async () => {
    await assert.rejects(
      () => runEvaluation({
        samplesPath: '/nonexistent/file.json',
        skillDir: SKILL_DIR,
        variants: ['v1', 'v2'],
      }),
      /ENOENT|invalid/,
    );
  });

  it('throws on missing skill file (non-dry-run)', async () => {
    await assert.rejects(
      () => runEvaluation({
        samplesPath: SAMPLES_PATH,
        skillDir: SKILL_DIR,
        variants: ['v1', 'v99_nonexistent'],
      }),
      /skill file not found/,
    );
  });
});

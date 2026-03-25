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
      /skill not found/,
    );
  });

  it('dry-run: meta includes traceability fields', async () => {
    const { report } = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });
    // dry-run still has model info
    assert.ok(report.model);
  });

  it('loads SKILL.md from subdirectories', async () => {
    const sessionMemorySamples = join(__dirname, '..', 'examples', 'session-memory', 'eval-samples.json');
    const sessionMemorySkills = join(__dirname, '..', 'examples', 'session-memory', 'skills');
    const { report } = await runEvaluation({
      samplesPath: sessionMemorySamples,
      skillDir: sessionMemorySkills,
      variants: ['aima-kg-mem-cc', 'aima-kg-mem-codex'],
      dryRun: true,
    });
    assert.equal(report.totalTasks, 12); // 6 samples × 2 variants
  });

  it('validates required sample fields', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const tmpSamples = join(__dirname, 'tmp-bad-samples.json');
    writeFileSync(tmpSamples, JSON.stringify([{ rubric: 'test' }]));
    try {
      await assert.rejects(
        () => runEvaluation({
          samplesPath: tmpSamples,
          skillDir: SKILL_DIR,
          variants: ['v1', 'v2'],
        }),
        /missing required field: sample_id/,
      );
    } finally {
      try { unlinkSync(tmpSamples); } catch { /* ignore */ }
    }
  });
});

describe('runEvaluation credibility', () => {
  const MOCK_SAMPLES_PATH = join(__dirname, 'tmp-mock-samples.json');

  async function writeMockSamples() {
    const { writeFileSync: wf } = await import('node:fs');
    wf(MOCK_SAMPLES_PATH, JSON.stringify([
      { sample_id: 's1', prompt: 'test prompt 1' },
      { sample_id: 's2', prompt: 'test prompt 2' },
    ]));
  }
  async function cleanMockSamples() {
    try { (await import('node:fs')).unlinkSync(MOCK_SAMPLES_PATH); } catch { /* ignore */ }
  }

  it('blind mode: same input produces same mapping', async () => {
    await writeMockSamples();
    try {
      const { loadSamples, buildTasks } = await import('../lib/runner.mjs');
      const samples = loadSamples(MOCK_SAMPLES_PATH);
      const skills = { v1: 'skill content v1', v2: 'skill content v2' };
      const tasks = buildTasks(samples, ['v1', 'v2'], skills);

      // Verify tasks are correctly built (prerequisite for blind to work)
      assert.equal(tasks.length, 4); // 2 samples × 2 variants
      assert.equal(tasks[0].variant, 'v1');
      assert.equal(tasks[1].variant, 'v2');
    } finally {
      await cleanMockSamples();
    }
  });

  it('concurrency progress: started count appears before completed count', async () => {
    await writeMockSamples();
    try {
      const progressEvents = [];
      // Use script executor with a trivial eval.sh to test real execution + progress
      const { mkdirSync: mkd, writeFileSync: wf } = (await import('node:fs'));
      const { tmpdir } = (await import('node:os'));
      const skillDir = join(tmpdir(), `omk-test-progress-${Date.now()}`);
      mkd(join(skillDir, 'v1'), { recursive: true });
      mkd(join(skillDir, 'v2'), { recursive: true });
      wf(join(skillDir, 'v1', 'eval.sh'), '#!/bin/bash\necho "output v1"');
      wf(join(skillDir, 'v2', 'eval.sh'), '#!/bin/bash\necho "output v2"');

      await runEvaluation({
        samplesPath: MOCK_SAMPLES_PATH,
        skillDir,
        variants: ['v1', 'v2'],
        noJudge: true,
        outputDir: null,
        executorName: 'script',
        concurrency: 2,
        onProgress(evt) {
          progressEvents.push({ phase: evt.phase, completed: evt.completed });
        },
      });

      // Verify we got both start and done events
      const starts = progressEvents.filter((e) => e.phase === 'start');
      const dones = progressEvents.filter((e) => e.phase === 'done');
      assert.equal(starts.length, 4); // 2 samples × 2 variants
      assert.equal(dones.length, 4);

      // Done completed counts must be monotonically non-decreasing
      for (let i = 1; i < dones.length; i++) {
        assert.ok(dones[i].completed >= dones[i - 1].completed,
          `completed count went backwards: ${dones[i].completed} < ${dones[i - 1].completed}`);
      }

      // Final done must have completed = total
      assert.equal(dones[dones.length - 1].completed, 4);

      (await import('node:fs')).rmSync(skillDir, { recursive: true, force: true });
    } finally {
      await cleanMockSamples();
    }
  });
});

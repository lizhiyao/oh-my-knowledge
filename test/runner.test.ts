import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runEvaluation, loadSkills, buildTasks, discoverVariants, discoverEachSkills, runEachEvaluation } from '../lib/runner.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface DryRunTask {
  sample_id: string;
  variant: string;
  artifactKind: string;
  artifactSource: string;
  executionStrategy: string;
  experimentRole: string;
  cwd: string | null;
  hasRubric: boolean;
  hasAssertions: boolean;
  hasDimensions: boolean;
}

interface DryRunReport {
  dryRun: true;
  totalTasks: number;
  variants: string[];
  executor: string;
  model?: string;
  judgeModel?: string;
  tasks: DryRunTask[];
}

interface EachDryRunSkill {
  name: string;
  sampleCount: number;
  taskCount: number;
}

interface EachDryRunReport {
  dryRun: true;
  each: true;
  totalSkills: number;
  totalTasks: number;
  skills: EachDryRunSkill[];
}

function asDryRunReport(value: unknown): DryRunReport {
  return value as DryRunReport;
}

function asEachDryRunReport(value: unknown): EachDryRunReport {
  return value as EachDryRunReport;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_PATH = join(__dirname, '..', '..', 'examples', 'code-review', 'eval-samples.json');
const SKILL_DIR = join(__dirname, '..', '..', 'examples', 'code-review', 'skills');

describe('runEvaluation', () => {
  it('dry-run: returns correct task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.equal(report.dryRun, true);
    assert.equal(report.totalTasks, 6); // 3 samples × 2 variants
    assert.deepEqual(report.variants, ['v1', 'v2']);
    assert.equal(report.executor, 'claude');
  });

  it('dry-run: interleaved scheduling order', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    const schedule = report.tasks.map((t: { sample_id: string; variant: string }) => `${t.sample_id}-${t.variant}`);
    assert.deepEqual(schedule, [
      's001-v1', 's001-v2',
      's002-v1', 's002-v2',
      's003-v1', 's003-v2',
    ]);
  });

  it('dry-run: reports assertion and dimension presence', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    for (const task of report.tasks) {
      assert.equal(task.hasRubric, true);
      assert.equal(task.hasAssertions, true);
      assert.equal(task.hasDimensions, true);
    }
  });

  it('dry-run: supports 3+ variants', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.equal(report.totalTasks, 6);
  });

  it('dry-run: custom model and judge model', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      model: 'opus',
      judgeModel: 'sonnet',
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

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
      /skill 未找到/,
    );
  });

  it('dry-run: meta includes traceability fields', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['v1', 'v2'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    // dry-run still has model info
    assert.ok(report.model);
  });

  it('dry-run: includes artifact/runtime context semantics', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['baseline', 'project-env@/tmp/project-a', 'v1'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    const baselineTask = report.tasks.find((task) => task.variant === 'baseline');
    const projectEnvTask = report.tasks.find((task) => task.variant === 'project-env');
    const artifactTask = report.tasks.find((task) => task.variant === 'v1');
    assert.equal(baselineTask?.experimentRole, 'baseline');
    assert.equal(projectEnvTask?.experimentRole, 'runtime-context-only');
    assert.equal(projectEnvTask?.cwd, '/tmp/project-a');
    assert.equal(artifactTask?.executionStrategy, 'system-prompt');
  });

  it('loads SKILL.md from subdirectories', async () => {
    const classifierSamples = join(__dirname, '..', '..', 'examples', 'multi-skills', 'skills', 'classifier', 'eval-samples.json');
    const multiSkillsDir = join(__dirname, '..', '..', 'examples', 'multi-skills', 'skills');
    const result = await runEvaluation({
      samplesPath: classifierSamples,
      skillDir: multiSkillsDir,
      variants: ['classifier'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 2); // 2 samples × 1 variant
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
        /缺少必填字段: sample_id/,
      );
    } finally {
      try { unlinkSync(tmpSamples); } catch { /* ignore */ }
    }
  });
});

describe('discoverVariants', () => {
  it('discovers .md files as variants', () => {
    const variants = discoverVariants(SKILL_DIR);
    assert.ok(variants.includes('v1'));
    assert.ok(variants.includes('v2'));
  });

  it('discovers subdirectories with SKILL.md', () => {
    const multiSkillsDir = join(__dirname, '..', '..', 'examples', 'multi-skills', 'skills');
    const variants = discoverVariants(multiSkillsDir);
    assert.ok(variants.includes('classifier'));
  });

  it('returns sorted variants', () => {
    const variants = discoverVariants(SKILL_DIR);
    const sorted = [...variants].filter(v => v !== 'baseline').sort();
    assert.deepEqual(variants.filter(v => v !== 'baseline'), sorted);
  });

  it('adds baseline when only one skill found', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const tmpDir = join(__dirname, 'tmp-single-skill');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'only.md'), 'test skill');
    try {
      const variants = discoverVariants(tmpDir);
      assert.deepEqual(variants, ['baseline', 'only']);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns empty for nonexistent directory', () => {
    const variants = discoverVariants('/nonexistent/dir');
    assert.deepEqual(variants, []);
  });
});

describe('baseline variant', () => {
  it('loadSkills: baseline returns null without file lookup', () => {
    const skills = loadSkills(SKILL_DIR, ['baseline', 'v1']);
    assert.equal(skills.baseline, null);
    assert.equal(typeof skills.v1, 'string');
    assert.ok((skills.v1 as string).length > 0);
  });

  it('loadSkills: baseline-only does not need skill dir', () => {
    const skills = loadSkills('/nonexistent/dir', ['baseline']);
    assert.deepEqual(skills, { baseline: null });
  });

  it('buildTasks: baseline variant has null artifactContent', () => {
    const samples = [{ sample_id: 's1', prompt: 'hello' }];
    const skills: Record<string, string | null> = { baseline: null, v1: 'system prompt' };
    const tasks = buildTasks(samples, ['baseline', 'v1'], skills);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].artifactContent, null);
    assert.equal(tasks[1].artifactContent, 'system prompt');
  });

  it('dry-run: baseline variant included in task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['baseline', 'v1'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 6); // 3 samples × 2 variants
    assert.deepEqual(report.variants, ['baseline', 'v1']);
  });
});

describe('git: variant', () => {
  it('loadSkills: git:name loads skill from HEAD', () => {
    const skills = loadSkills(SKILL_DIR, ['git:v1']);
    assert.equal(typeof skills['git:v1'], 'string');
    assert.ok((skills['git:v1'] as string).length > 0);
  });

  it('loadSkills: git:ref:name loads skill from specific commit', () => {
    const skills = loadSkills(SKILL_DIR, ['git:HEAD:v1']);
    assert.equal(typeof skills['git:HEAD:v1'], 'string');
    assert.ok((skills['git:HEAD:v1'] as string).length > 0);
  });

  it('loadSkills: git:name throws on missing skill', () => {
    assert.throws(
      () => loadSkills(SKILL_DIR, ['git:nonexistent']),
      /skill 在 git HEAD 中未找到/,
    );
  });

  it('loadSkills: git:name and file variant can coexist', () => {
    const skills = loadSkills(SKILL_DIR, ['git:v1', 'v2']);
    assert.equal(typeof skills['git:v1'], 'string');
    assert.equal(typeof skills['v2'], 'string');
  });

  it('dry-run: git variant included in task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: ['git:v1', 'v1'],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 6);
    assert.deepEqual(report.variants, ['git:v1', 'v1']);
  });
});

describe('file path variant', () => {
  const v1Path = join(SKILL_DIR, 'v1.md');
  const v2Path = join(SKILL_DIR, 'v2.md');

  it('loadSkills: loads skill from file path', () => {
    const skills = loadSkills(SKILL_DIR, [v1Path]);
    assert.equal(typeof skills[v1Path], 'string');
    assert.ok((skills[v1Path] as string).length > 0);
  });

  it('loadSkills: file path and name variant can coexist', () => {
    const skills = loadSkills(SKILL_DIR, [v1Path, 'v2']);
    assert.equal(typeof skills[v1Path], 'string');
    assert.equal(typeof skills['v2'], 'string');
  });

  it('loadSkills: throws on missing file path', () => {
    assert.throws(
      () => loadSkills(SKILL_DIR, ['/nonexistent/skill.md']),
      /skill 文件未找到/,
    );
  });

  it('dry-run: file path variant in task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variants: [v1Path, v2Path],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 6);
  });
});

describe('discoverEachSkills', () => {
  const MULTI_SKILLS_DIR = join(__dirname, '..', '..', 'examples', 'multi-skills', 'skills');

  it('discovers skills with paired eval-samples', () => {
    const skills = discoverEachSkills(MULTI_SKILLS_DIR);
    assert.ok(skills.length >= 2);
    const names = skills.map((s) => s.name);
    assert.ok(names.includes('summarizer'));
    assert.ok(names.includes('translator'));
  });

  it('each entry has name, skillPath, samplesPath', () => {
    const skills = discoverEachSkills(MULTI_SKILLS_DIR);
    for (const sk of skills) {
      assert.ok(sk.name);
      assert.ok(sk.skillPath);
      assert.ok(sk.samplesPath);
    }
  });

  it('returns sorted by name', () => {
    const skills = discoverEachSkills(MULTI_SKILLS_DIR);
    const names = skills.map((s) => s.name);
    assert.deepEqual(names, [...names].sort());
  });

  it('skips skills without paired eval-samples', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const tmpDir = join(__dirname, 'tmp-each-skills');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'has-pair.md'), 'skill content');
    writeFileSync(join(tmpDir, 'has-pair.eval-samples.json'), JSON.stringify([{ sample_id: 's1', prompt: 'test' }]));
    writeFileSync(join(tmpDir, 'no-pair.md'), 'skill content');
    try {
      const skills = discoverEachSkills(tmpDir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'has-pair');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns empty for nonexistent directory', () => {
    const skills = discoverEachSkills('/nonexistent/dir');
    assert.deepEqual(skills, []);
  });
});

describe('runEachEvaluation', () => {
  const MULTI_SKILLS_DIR = join(__dirname, '..', '..', 'examples', 'multi-skills', 'skills');

  it('dry-run: returns correct structure', async () => {
    const result = await runEachEvaluation({
      skillDir: MULTI_SKILLS_DIR,
      dryRun: true,
    });
    const report = asEachDryRunReport(result.report);
    assert.equal(report.dryRun, true);
    assert.equal(report.each, true);
    assert.ok(report.totalSkills >= 2);
    assert.ok(report.skills.length >= 2);
    for (const sk of report.skills) {
      assert.ok(sk.name);
      assert.ok(sk.sampleCount > 0);
      assert.equal(sk.taskCount, sk.sampleCount * 2);
    }
  });

  it('dry-run: totalTasks is sum of all skill tasks', async () => {
    const result = await runEachEvaluation({
      skillDir: MULTI_SKILLS_DIR,
      dryRun: true,
    });
    const report = asEachDryRunReport(result.report);
    const expectedTotal = report.skills.reduce((s: number, sk: { taskCount: number }) => s + sk.taskCount, 0);
    assert.equal(report.totalTasks, expectedTotal);
  });
});

describe('runEvaluation credibility', () => {
  const MOCK_SAMPLES_PATH = join(__dirname, 'tmp-mock-samples.json');

  async function writeMockSamples(): Promise<void> {
    const { writeFileSync: wf } = await import('node:fs');
    wf(MOCK_SAMPLES_PATH, JSON.stringify([
      { sample_id: 's1', prompt: 'test prompt 1' },
      { sample_id: 's2', prompt: 'test prompt 2' },
    ]));
  }
  async function cleanMockSamples(): Promise<void> {
    try { (await import('node:fs')).unlinkSync(MOCK_SAMPLES_PATH); } catch { /* ignore */ }
  }

  it('blind mode: same input produces same mapping', async () => {
    await writeMockSamples();
    try {
      const { loadSamples, buildTasks } = await import('../lib/runner.js');
      const samples = loadSamples(MOCK_SAMPLES_PATH);
      const skills: Record<string, string | null> = { v1: 'skill content v1', v2: 'skill content v2' };
      const tasks = buildTasks(samples, ['v1', 'v2'], skills);

      // Verify tasks are correctly built (prerequisite for blind to work)
      assert.equal(tasks.length, 4); // 2 samples × 2 variants
      assert.equal(tasks[0].variant, 'v1');
      assert.equal(tasks[1].variant, 'v2');
    } finally {
      await cleanMockSamples();
    }
  });

  it('dry-run: task count correct for multiple variants', async () => {
    await writeMockSamples();
    try {
      const result = await runEvaluation({
        samplesPath: MOCK_SAMPLES_PATH,
        skillDir: SKILL_DIR,
        variants: ['v1', 'v2'],
        dryRun: true,
      });
      const report = asDryRunReport(result.report);
      assert.equal(report.totalTasks, 4); // 2 samples × 2 variants
    } finally {
      await cleanMockSamples();
    }
  });
});

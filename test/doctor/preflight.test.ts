import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildDoctorPreflightContext } from '../../src/doctor/preflight.js';
import type { Artifact } from '../../src/knowledge-artifacts/contracts.js';
import type { Sample } from '../../src/inputs/contracts/sample.js';

const skillArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  name: overrides.name ?? 'v1',
  kind: 'skill',
  source: 'variant-name',
  content: 'sample skill content sufficiently long.',
  ...overrides,
});

const baselineArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  name: overrides.name ?? 'baseline',
  kind: 'baseline',
  source: 'baseline',
  content: null,
  ...overrides,
});

describe('buildDoctorPreflightContext', () => {
  it('returns null for baseline-only run (no skill to check)', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [baselineArtifact()],
      skillDir: '/tmp/skills',
    });
    assert.equal(ctx, null);
  });

  it('returns null for empty artifacts list', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [],
      skillDir: '/tmp/skills',
    });
    assert.equal(ctx, null);
  });

  it('filters baseline-kind out, keeps only skills', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [baselineArtifact(), skillArtifact({ name: 'v1' }), skillArtifact({ name: 'v2' })],
      skillDir: '/tmp/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.doctorArtifacts.length, 2);
    assert.deepEqual(ctx.doctorArtifacts.map((a) => a.name), ['v1', 'v2']);
  });

  it('falls back to skillDir when no artifact carries cwd', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [skillArtifact()],
      skillDir: 'examples/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.dependencyCwd, resolve('examples/skills'));
  });

  it('artifact.cwd takes priority over skillDir for dependencyCwd (matches Core preflight)', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [skillArtifact({ name: 'v1', cwd: '/tmp/explicit-cwd' }), skillArtifact({ name: 'v2' })],
      skillDir: '/tmp/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.dependencyCwd, '/tmp/explicit-cwd');
  });

  it('runtime-context-only baseline (project-env@/repo) contributes cwd even after baseline filter', () => {
    // 关键回归: `project-env@/repo` 在 skill-loader 会被生成成 kind:'baseline' 且带 cwd。
    // 早版 builder 先过滤 baseline 再 find cwd, 把这个 cwd 丢了, 让 requires.files
    // 错锚到 skillDir。修复: dependencyCwd 看完整 input.artifacts, doctorArtifacts 仅
    // 决定 doctor 检查哪些(仍排 baseline)。
    const ctx = buildDoctorPreflightContext({
      artifacts: [
        baselineArtifact({ name: 'project-env', cwd: '/repo/proj' }),
        skillArtifact({ name: 'v1' }),
      ],
      skillDir: '/tmp/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.dependencyCwd, '/repo/proj', 'baseline 的 cwd 必须被采纳为路径基准');
    assert.equal(ctx.doctorArtifacts.length, 1, 'doctor 仍只检查 non-baseline');
    assert.equal(ctx.doctorArtifacts[0].name, 'v1');
  });

  it('passes through samples and requires unchanged', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'hello' }];
    const requires = { tools: ['ripgrep'], files: ['fixture.txt'] };
    const ctx = buildDoctorPreflightContext({
      artifacts: [skillArtifact()],
      samples,
      requires,
      skillDir: '/tmp/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.samples, samples);
    assert.equal(ctx.requires, requires);
  });

  it('omits samples and requires when not provided', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [skillArtifact()],
      skillDir: '/tmp/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.samples, undefined);
    assert.equal(ctx.requires, undefined);
  });
});

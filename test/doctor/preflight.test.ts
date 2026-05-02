import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildDoctorPreflightContext } from '../../src/doctor/preflight.js';
import type { Artifact, Sample } from '../../src/types/index.js';

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

  it('artifact.cwd takes priority over skillDir for dependencyCwd (matches evaluation-pipeline rule)', () => {
    const ctx = buildDoctorPreflightContext({
      artifacts: [skillArtifact({ name: 'v1', cwd: '/tmp/explicit-cwd' }), skillArtifact({ name: 'v2' })],
      skillDir: '/tmp/skills',
    });
    assert.ok(ctx);
    assert.equal(ctx.dependencyCwd, '/tmp/explicit-cwd');
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

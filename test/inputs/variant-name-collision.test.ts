import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUniqueVariantNames, resolveArtifacts } from '../../src/inputs/skill-loader.js';
import { resolveVariantSpecs } from '../../src/cli/lib/parse-run-config/variant-resolution.js';
import { prepareEvaluationRun } from '../../src/eval-workflows/evaluation-preparation.js';
import type { Artifact } from '../../src/types/eval.js';

const skill = (name: string, over: Partial<Artifact> = {}): Artifact => ({
  name,
  kind: 'skill',
  source: 'file-path',
  content: 'x',
  ...over,
});

describe('ensureUniqueVariantNames', () => {
  it('leaves already-unique names untouched', () => {
    const arts = [skill('greeter', { locator: '/a/greeter.md' }), skill('helper', { locator: '/a/helper.md' })];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['greeter', 'helper']);
  });

  it('disambiguates same-basename file variants by parent dir', () => {
    const arts = [
      skill('greeter', { locator: '/repo/v1/greeter.md' }),
      skill('greeter', { locator: '/repo/v2/greeter.md' }),
    ];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['v1/greeter', 'v2/greeter']);
  });

  it('disambiguates SKILL.md dir skills by the dir above the skill root', () => {
    const arts = [
      skill('greeter', { locator: '/repo/v1/greeter/SKILL.md', skillRoot: '/repo/v1/greeter' }),
      skill('greeter', { locator: '/repo/v2/greeter/SKILL.md', skillRoot: '/repo/v2/greeter' }),
    ];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['v1/greeter', 'v2/greeter']);
  });

  it('walks further up the path when the immediate parent also collides', () => {
    const arts = [
      skill('greeter', { locator: '/repo/a/v1/greeter.md' }),
      skill('greeter', { locator: '/repo/b/v1/greeter.md' }),
    ];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['a/v1/greeter', 'b/v1/greeter']);
  });

  it('falls back to a numeric suffix when no path is available (e.g. baseline)', () => {
    const arts = [
      skill('x', { kind: 'baseline', source: 'baseline', content: null }),
      skill('x', { kind: 'baseline', source: 'baseline', content: null }),
    ];
    ensureUniqueVariantNames(arts);
    const names = arts.map((a) => a.name);
    assert.equal(new Set(names).size, 2, `expected unique names, got ${names.join(',')}`);
    assert.ok(names.includes('x') && names.includes('x#2'), names.join(','));
  });
});

describe('resolveArtifacts — same-basename variants in different dirs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-variant-'));
    for (const v of ['v1', 'v2']) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, 'greeter.md'), `# greeter ${v}\n`);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does not collapse two same-named skills into one (regression)', () => {
    const arts = resolveArtifacts(root, [join(root, 'v1', 'greeter.md'), join(root, 'v2', 'greeter.md')]);
    assert.equal(arts.length, 2);
    const names = arts.map((a) => a.name);
    assert.equal(new Set(names).size, 2, `variant names must stay distinct, got ${names.join(',')}`);
    assert.deepEqual(names, ['v1/greeter', 'v2/greeter']);
    // 内容确实是两份不同的 skill,没有被覆盖
    assert.notEqual(arts[0].content, arts[1].content);
  });
});

describe('CLI dry-run — --control / --treatment same-basename in different dirs', () => {
  let root: string;
  let samplesPath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-variant-cli-'));
    for (const v of ['v1', 'v2']) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, 'greeter.md'), `# greeter ${v}\n`);
    }
    samplesPath = join(root, 'samples.json');
    writeFileSync(samplesPath, JSON.stringify([{ sample_id: 's1', prompt: '你好' }]));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolveVariantSpecs does not flag two different paths as a duplicate variant', () => {
    const specs = resolveVariantSpecs(
      { control: join(root, 'v1', 'greeter.md'), treatment: join(root, 'v2', 'greeter.md') },
      null,
      root,
    );
    assert.equal(specs.length, 2);
    assert.deepEqual(specs.map((s) => s.role), ['control', 'treatment']);
  });

  it('resolveVariantSpecs still rejects the same expr in control and treatment', () => {
    const same = join(root, 'v1', 'greeter.md');
    assert.throws(() => resolveVariantSpecs({ control: same, treatment: same }, null, root), /重复出现/);
  });

  it('prepareEvaluationRun assigns distinct names AND a role to each variant (regression)', async () => {
    const variantSpecs = resolveVariantSpecs(
      { control: join(root, 'v1', 'greeter.md'), treatment: join(root, 'v2', 'greeter.md') },
      null,
      root,
    );
    const prepared = await prepareEvaluationRun({ samplesPath, skillDir: root, variantSpecs, dryRun: true });
    assert.equal(prepared.artifacts.length, 2);
    assert.deepEqual(prepared.variantNames, ['v1/greeter', 'v2/greeter']);
    // 两个 artifact 都拿到了 experimentRole(否则 buildVariantConfig 会抛 “缺少 experimentRole”)
    assert.deepEqual(prepared.artifacts.map((a) => a.experimentRole), ['control', 'treatment']);
    // spec.name 已同步成消歧后的唯一名,与 report / variantNames 一致
    assert.deepEqual(variantSpecs.map((s) => s.name), ['v1/greeter', 'v2/greeter']);
  });
});

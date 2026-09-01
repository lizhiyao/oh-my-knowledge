import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { materializeCoreEvolveSnapshot } from '../../src/authoring/core-evolver.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe('Core evolve artifact snapshots', () => {
  it('preserves a directory skill construct while excluding OMK-owned state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-core-evolve-snapshot-'));
    temporaryDirectories.push(root);
    const skillDirectory = join(root, 'review');
    const evolveDirectory = join(skillDirectory, 'evolve');
    mkdirSync(join(skillDirectory, 'references'), { recursive: true });
    mkdirSync(join(skillDirectory, '.omk'), { recursive: true });
    mkdirSync(join(evolveDirectory, 'review.r1'), { recursive: true });
    writeFileSync(join(skillDirectory, 'SKILL.md'), 'old skill');
    writeFileSync(join(skillDirectory, 'references', 'rules.md'), 'rules');
    writeFileSync(join(skillDirectory, '.omk', 'samples.json'), '[]');
    writeFileSync(join(evolveDirectory, 'review.r1', 'stale.md'), 'stale');

    const snapshot = materializeCoreEvolveSnapshot({
      skillDirectory,
      evolveDirectory,
      skillName: 'review',
      round: 1,
      content: 'new skill',
      isDirectorySkill: true,
    });

    assert.equal(readFileSync(snapshot.contentPath, 'utf8'), 'new skill');
    assert.equal(readFileSync(join(snapshot.root, 'references', 'rules.md'), 'utf8'), 'rules');
    assert.equal(existsSync(join(snapshot.root, '.omk')), false);
    assert.equal(existsSync(join(snapshot.root, 'evolve')), false);
    assert.equal(existsSync(join(snapshot.root, 'stale.md')), false);
  });

  it('keeps a flat-file skill as a standalone markdown candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-core-evolve-flat-'));
    temporaryDirectories.push(root);
    const evolveDirectory = join(root, 'evolve');
    mkdirSync(evolveDirectory, { recursive: true });
    const snapshot = materializeCoreEvolveSnapshot({
      skillDirectory: root,
      evolveDirectory,
      skillName: 'review',
      round: 2,
      content: 'flat candidate',
      isDirectorySkill: false,
    });
    assert.equal(snapshot.root, join(evolveDirectory, 'review.r2.md'));
    assert.equal(readFileSync(snapshot.root, 'utf8'), 'flat candidate');
  });
});

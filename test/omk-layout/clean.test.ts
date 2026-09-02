import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import { applyClean, planClean } from '../../src/omk-layout/clean.js';
import { projectLayout } from '../../src/omk-layout/index.js';

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'data');
}

describe('OMK clean lifecycle policy', () => {
  it('cleans only state by default', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-clean-state-'));
    const layout = projectLayout(cwd);
    touch(join(layout.stateDir, 'tmp', 'a'));
    touch(join(layout.evalDir, 'run', 'report.json'));
    const plan = planClean({ cwd });
    assert.deepEqual(plan.targets.map((target) => target.category), ['state']);
    assert.equal(plan.requiresForce, false);
    assert.equal(applyClean(plan), 1);
    assert.equal(existsSync(layout.stateDir), false);
    assert.equal(existsSync(layout.evalDir), true);
  });

  it('marks observation and governance deletion as force-required', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-clean-sensitive-'));
    const layout = projectLayout(cwd);
    touch(join(layout.observeInboxDir, 'report.json'));
    touch(join(layout.managedDir, 'record.json'));
    const plan = planClean({ cwd, categories: ['observations', 'governance'] });
    assert.equal(plan.requiresForce, true);
    assert.equal(plan.targets.length, 2);
  });

  it('rejects a tampered target outside the OMK root', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-clean-unsafe-'));
    const outside = join(cwd, 'outside');
    touch(join(outside, 'keep'));
    const plan = {
      scope: 'project' as const,
      root: projectLayout(cwd).root,
      targets: [{ category: 'state' as const, path: outside, bytes: 4 }],
      totalBytes: 4,
      requiresForce: false,
    };
    assert.throws(() => applyClean(plan), /unsafe OMK clean target/);
    assert.equal(existsSync(outside), true);
  });
});

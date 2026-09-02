import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  globalLayout,
  projectLayout,
} from '../../src/shared/storage-layout.js';

describe('OMK storage layout', () => {
  it('derives every project v2 path from one root', () => {
    const actual = projectLayout('/repo');
    assert.equal(actual.root, join('/repo', '.omk'));
    assert.equal(actual.evalDir, join('/repo', '.omk', 'eval'));
    assert.equal(actual.doctorDir, join('/repo', '.omk', 'doctor'));
    assert.equal(actual.observeHealthDir, join('/repo', '.omk', 'observe', 'health'));
    assert.equal(actual.observeInboxDir, join('/repo', '.omk', 'observe', 'inbox'));
    assert.equal(actual.observeInboxReportsDir, join('/repo', '.omk', 'observe', 'inbox', 'reports'));
    assert.equal(actual.observeInboxCapturesDir, join('/repo', '.omk', 'observe', 'inbox', 'captures'));
    assert.equal(actual.managedDir, join('/repo', '.omk', 'governance', 'managed'));
    assert.equal(actual.jobsDir, join('/repo', '.omk', 'state', 'jobs'));
    assert.equal(actual.tmpDir, join('/repo', '.omk', 'state', 'tmp'));
    for (const machineOnly of [
      'cacheDir',
      'toolsDir',
      'tunnelsDir',
      'treesDir',
      'isolatedCwdDir',
      'resolvedInputsDir',
      'artifactIndexDir',
      'resourceLeasesDir',
    ]) {
      assert.equal(machineOnly in actual, false, `${machineOnly} must not exist in project layout`);
    }
  });

  it('mirrors the durable global domains and keeps machine state under state', () => {
    const actual = globalLayout('/omk-home');
    assert.equal(actual.evalDir, join('/omk-home', 'eval'));
    assert.equal(actual.doctorDir, join('/omk-home', 'doctor'));
    assert.equal(actual.observeHealthDir, join('/omk-home', 'observe', 'health'));
    assert.equal(actual.observeInboxDir, join('/omk-home', 'observe', 'inbox'));
    assert.equal(actual.managedDir, join('/omk-home', 'governance', 'managed'));
    assert.equal(actual.toolsDir, join('/omk-home', 'state', 'tools'));
    assert.equal(actual.tunnelsDir, join('/omk-home', 'state', 'tunnels'));
    assert.equal(actual.resolvedInputsDir, join(
      '/omk-home',
      'state',
      'isolated-cwd',
      'resolved-inputs',
    ));
    assert.equal(actual.resourceLeasesDir, join(
      '/omk-home',
      'state',
      'tmp',
      'resource-leases',
    ));
  });
});

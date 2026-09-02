import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  OMK_LAYOUT_VERSION,
  ensureLayoutMarker,
  globalLayout,
  legacyGlobalLayout,
  legacyProjectLayout,
  projectLayout,
  readLayoutMarker,
} from '../../src/omk-layout/index.js';

describe('OMK layout', () => {
  it('derives every project v2 path from one root', () => {
    const actual = projectLayout('/repo');
    assert.equal(actual.root, join('/repo', '.omk'));
    assert.equal(actual.markerPath, join('/repo', '.omk', 'layout.json'));
    assert.equal(actual.evalDir, join('/repo', '.omk', 'eval'));
    assert.equal(actual.doctorDir, join('/repo', '.omk', 'doctor'));
    assert.equal(actual.observeHealthDir, join('/repo', '.omk', 'observe', 'health'));
    assert.equal(actual.observeInboxDir, join('/repo', '.omk', 'observe', 'inbox'));
    assert.equal(actual.observeInboxReportsDir, join('/repo', '.omk', 'observe', 'inbox', 'reports'));
    assert.equal(actual.observeInboxCapturesDir, join('/repo', '.omk', 'observe', 'inbox', 'captures'));
    assert.equal(actual.managedDir, join('/repo', '.omk', 'governance', 'managed'));
    assert.equal(actual.jobsDir, join('/repo', '.omk', 'state', 'jobs'));
    assert.equal(actual.tmpDir, join('/repo', '.omk', 'state', 'tmp'));
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
  });

  it('keeps all legacy path knowledge in the compatibility layout', () => {
    const project = legacyProjectLayout('/repo');
    assert.equal(project.evalDir, join('/repo', '.omk', 'reports'));
    assert.equal(project.doctorDir, join('/repo', '.omk', 'doctors'));
    assert.equal(project.observeHealthDir, join('/repo', '.omk', 'observe-health'));
    assert.equal(project.observeInboxDir, join('/repo', '.omk', 'observe-inbox'));
    assert.equal(project.managedDir, join('/repo', '.omk', 'managed'));

    const global = legacyGlobalLayout('/omk-home');
    assert.equal(global.evalDir, join('/omk-home', 'reports'));
    assert.equal(global.toolsDir, join('/omk-home', 'tools'));
  });

  it('writes and validates a minimal layout marker idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-layout-'));
    assert.equal(readLayoutMarker(root), undefined);
    assert.deepEqual(ensureLayoutMarker(root), { layoutVersion: OMK_LAYOUT_VERSION });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'layout.json'), 'utf8')), {
      layoutVersion: OMK_LAYOUT_VERSION,
    });
    assert.deepEqual(ensureLayoutMarker(root), { layoutVersion: OMK_LAYOUT_VERSION });
  });

  it('rejects malformed and unsupported markers before a writer can continue', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-layout-invalid-'));
    writeFileSync(join(root, 'layout.json'), JSON.stringify({ layoutVersion: 3 }));
    assert.throws(() => ensureLayoutMarker(root), /Unsupported OMK layout version/);
    writeFileSync(join(root, 'layout.json'), '{');
    assert.throws(() => readLayoutMarker(root), /Invalid OMK layout marker/);
  });
});

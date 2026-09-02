import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import {
  buildObservationInboxReport,
  loadObservationInboxReports,
  saveObservationInboxReport,
} from '../../src/observability/inbox/index.js';
describe('observe inbox v2 layout', () => {
  it('recognizes a canonical v2 inbox independently of process.cwd()', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-observe-layout-'));
    const inbox = join(root, '.omk', 'observe', 'inbox');
    const traceDir = join(root, 'empty-traces');
    mkdirSync(traceDir);

    const path = saveObservationInboxReport(buildObservationInboxReport(traceDir), inbox);
    assert.equal(dirname(path), join(inbox, 'reports'));
    assert.equal(loadObservationInboxReports(inbox).length, 1);
  });

});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const verifyScript = join(projectRoot, 'examples/codex-observe-router/verify.mjs');
const cli = join(projectRoot, 'dist/cli/index.js');

describe('Codex observe router reproducible case', () => {
  it('round-trips a sanitized parent/subagent rollout through the inbox', async () => {
    const { stdout } = await execFileAsync(process.execPath, [verifyScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OMK_BIN: cli,
        OMK_PACKAGE_ROOT: projectRoot,
      },
    });
    const summary = JSON.parse(stdout) as {
      physicalTraceFiles: number;
      logicalSessions: number;
      observedSkills: string[];
      sourceKind: string;
      externalChildEdges: number;
      edgeEndpointsClosed: boolean;
      routerDownstreamCompleted: number;
      inboxSignals: number;
      inboxSignalTypes: string[];
      compactReportRoundTrip: boolean;
    };

    assert.equal(summary.physicalTraceFiles, 2);
    assert.equal(summary.logicalSessions, 1);
    assert.deepEqual(summary.observedSkills, ['repo-review']);
    assert.equal(summary.sourceKind, 'codex');
    assert.equal(summary.externalChildEdges, 1);
    assert.equal(summary.edgeEndpointsClosed, true);
    assert.equal(summary.routerDownstreamCompleted, 1);
    assert.equal(summary.inboxSignals, 1);
    assert.deepEqual(summary.inboxSignalTypes, ['failed_search']);
    assert.equal(summary.compactReportRoundTrip, true);
  });
});

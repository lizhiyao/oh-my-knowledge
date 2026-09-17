import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { CLI_ENTRY, PROJECT_ROOT, runCli } from '../helpers/cli-process.js';

const verifyScript = join(PROJECT_ROOT, 'examples/codex-observe-router/verify.mjs');

describe('Codex observe router reproducible case', () => {
  it('round-trips a sanitized parent/subagent rollout through the inbox', async () => {
    const { stdout } = await runCli([], {
      entry: verifyScript,
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        OMK_BIN: CLI_ENTRY,
        OMK_PACKAGE_ROOT: PROJECT_ROOT,
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

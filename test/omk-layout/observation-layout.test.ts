import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('stores source-record sidecars in the sibling archive domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-observe-layout-'));
    const inbox = join(root, '.omk', 'observe', 'inbox');
    const trace = join(root, 'rollout.jsonl');
    writeFileSync(trace, [
      JSON.stringify({
        timestamp: '2026-09-02T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'archive-layout', cwd: '/repo' },
      }),
      JSON.stringify({
        timestamp: '2026-09-02T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Observe this run.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-02T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'inspect-layout',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat /repo/.agents/skills/demo/SKILL.md' }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-02T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'inspect-layout',
          output: '# Demo Skill',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-02T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      }),
    ].join('\n'));

    saveObservationInboxReport(buildObservationInboxReport(trace), inbox);
    const [report] = loadObservationInboxReports(inbox);
    const ref = report?.meta.sourceRecordArchives?.[0];
    assert.ok(ref?.relativePath);
    assert.equal(existsSync(join(root, '.omk', 'observe', 'archive', ref.relativePath)), true);
    assert.equal(existsSync(join(inbox, ref.relativePath)), false);
  });

});

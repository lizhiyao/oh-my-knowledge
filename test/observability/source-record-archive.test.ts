import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  buildObservationInboxReport,
  loadObservationInboxReports,
  saveObservationInboxReport,
} from '../../src/observability/inbox.js';
import {
  loadObservationSourceRecordArchive,
  writeObservationSourceRecordArchives,
} from '../../src/observability/source-record-archive.js';
import { forEachNonEmptyUtf8Line } from '../../src/observability/trace-source.js';
import type { ObservationSourceRecordArchiveRef } from '../../src/types/index.js';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('observation source-record archives', () => {
  let root = '';
  let observationsDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-source-record-archive-'));
    observationsDir = join(root, 'observations');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists bounded source records separately and redacts opaque encrypted payloads', () => {
    const tracePath = join(root, 'rollout.jsonl');
    writeFileSync(tracePath, jsonl([
      {
        timestamp: '2026-08-05T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'source-record-test', cwd: '/repo' },
      },
      {
        timestamp: '2026-08-05T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect the trace.' }],
        },
      },
      {
        timestamp: '2026-08-05T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'ciphertext-must-not-leave-the-source',
        },
      },
      {
        timestamp: '2026-08-05T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-skill',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat /repo/.agents/skills/demo/SKILL.md' }),
        },
      },
      {
        timestamp: '2026-08-05T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'read-skill',
          output: '# Demo Skill',
        },
      },
      {
        timestamp: '2026-08-05T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      },
    ]));

    saveObservationInboxReport(buildObservationInboxReport(tracePath), observationsDir);
    const [persisted] = loadObservationInboxReports(observationsDir);
    const ref = persisted.meta.sourceRecordArchives?.[0];
    assert.ok(ref?.relativePath);
    assert.equal(ref.status, 'available');

    const view = loadObservationSourceRecordArchive(ref, observationsDir);
    assert.equal(view.status, 'available');
    assert.equal(view.recordCount, view.records.length);
    assert.ok(view.records.length > 0);
    assert.equal(view.records.some((record) => record.redacted), true);
    assert.doesNotMatch(JSON.stringify(view), /ciphertext-must-not-leave-the-source/);
    assert.match(JSON.stringify(view), /opaque encrypted content omitted/);
    assert.doesNotMatch(
      readFileSync(join(observationsDir, ref.relativePath), 'utf8'),
      /ciphertext-must-not-leave-the-source/,
    );
  });

  it('keeps source indexes aligned when the JSONL contains malformed or non-object records', () => {
    const tracePath = join(root, 'rollout-with-gaps.jsonl');
    writeFileSync(tracePath, [
      JSON.stringify({
        timestamp: '2026-08-05T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'source-index-test', cwd: '/repo' },
      }),
      JSON.stringify({
        timestamp: '2026-08-05T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect the trace.' }],
        },
      }),
      '{ malformed source record',
      JSON.stringify('ignored scalar'),
      JSON.stringify({
        timestamp: '2026-08-05T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'opaque-test-value',
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-05T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'inspect-trace',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat /repo/.agents/skills/demo/SKILL.md' }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-05T00:00:06.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'inspect-trace',
          output: '5 records',
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-05T00:00:07.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      }),
    ].join('\n'));

    saveObservationInboxReport(buildObservationInboxReport(tracePath), observationsDir);
    const [persisted] = loadObservationInboxReports(observationsDir);
    const ref = persisted.meta.sourceRecordArchives?.[0];
    assert.ok(ref);

    const view = loadObservationSourceRecordArchive(ref, observationsDir);
    assert.equal(view.status, 'available');
    assert.deepEqual(view.records.map((record) => record.sourceIndex), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(view.records[1]?.raw, '{ malformed source record');
    assert.equal(view.records[2]?.raw, JSON.stringify('ignored scalar'));
    assert.equal(persisted.meta.ingestion?.malformedRecordCount, 1);
    assert.equal(persisted.meta.ingestion?.ignoredValueCount, 1);
  });

  it('stops scanning after the visitor reaches its source boundary', () => {
    const tracePath = join(root, 'bounded-scan.jsonl');
    writeFileSync(tracePath, 'first\nsecond\nthird\n');
    const visited: string[] = [];

    forEachNonEmptyUtf8Line(tracePath, (line) => {
      visited.push(line);
      return false;
    });

    assert.deepEqual(visited, ['first']);
  });

  it('archives multiple experience sessions from one growing source', () => {
    const tracePath = join(root, 'shared-rollout.jsonl');
    writeFileSync(tracePath, jsonl([
      {
        timestamp: '2026-08-05T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'shared-source-test', cwd: '/repo' },
      },
      {
        timestamp: '2026-08-05T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect the shared trace.' }],
        },
      },
      {
        timestamp: '2026-08-05T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-shared-skill',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat /repo/.agents/skills/shared/SKILL.md' }),
        },
      },
      {
        timestamp: '2026-08-05T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'read-shared-skill',
          output: '# Shared Skill',
        },
      },
      {
        timestamp: '2026-08-05T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      },
    ]));
    const report = buildObservationInboxReport(tracePath);
    const sourceSession = report.experience?.sessions[0];
    assert.ok(sourceSession && report.experience);
    report.experience.sessions.push({ ...sourceSession, id: `${sourceSession.id}:copy` });
    appendFileSync(tracePath, '\n' + jsonl(Array.from({ length: 20 }, (_, index) => ({
      timestamp: `2026-08-05T00:01:${String(index).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: 'future_event', index },
    }))));

    const refs = writeObservationSourceRecordArchives(
      report,
      observationsDir,
      join(observationsDir, 'shared.report.json'),
    );
    assert.equal(refs.length, 2);
    assert.ok(refs.every((ref) => ref.status === 'available'));
    assert.equal(refs[0]?.recordCount, refs[1]?.recordCount);
    assert.equal(refs[0]?.omittedRecordCount, 0);
    assert.equal(refs[1]?.omittedRecordCount, 0);
  });

  it('fails closed when a report points outside the observations directory', () => {
    const ref: ObservationSourceRecordArchiveRef = {
      experienceSessionId: 'session-1',
      status: 'available',
      relativePath: '../outside.json',
      recordCount: 1,
      omittedRecordCount: 0,
      byteCount: 1,
      truncated: false,
    };

    assert.deepEqual(loadObservationSourceRecordArchive(ref, observationsDir), {
      status: 'unavailable',
      recordCount: 0,
      records: [],
      omittedRecordCount: 0,
      byteCount: 0,
      truncated: false,
      reason: 'archive_invalid',
    });
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  captureExplicitObservation,
  loadExplicitObservationCaptureRecords,
} from '../../src/observability/explicit-capture.js';
import {
  findObservationInboxItem,
  formatObservationShow,
  loadLatestObservationInboxReports,
  queryObservationInbox,
  saveObservationInboxReport,
} from '../../src/observability/inbox.js';
import { baseItem } from './inbox/_helpers.js';

describe('explicit observation capture', () => {
  it('persists an append-only record and projects it into the inbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-explicit-capture-'));
    const result = captureExplicitObservation({
      captureSourceKind: 'chatgpt_plugin',
      skillName: 'docs-skill',
      userFeedback: '这个回答遗漏了升级步骤。',
      evidenceSnippet: '用户要求从 1.x 升级到 2.x。',
      artifactVersion: '2.0.0',
      captureId: 'capture-1',
      confirmedByUser: true,
    }, {
      observationsDir: dir,
      now: () => new Date('2026-08-24T01:02:03.000Z'),
    });

    assert.equal(result.created, true);
    assert.equal(result.captureCoverage.coverageStatus, 'partial');
    assert.deepEqual(result.captureCoverage.observedEventKinds, [
      'tool_boundary',
      'user_feedback',
      'submitted_evidence',
    ]);
    assert.deepEqual(result.captureCoverage.unavailableEventKinds, [
      'full_conversation',
      'external_tool_calls',
      'hidden_reasoning',
    ]);
    assert.equal(loadLatestObservationInboxReports(dir).length, 0);

    const [item] = queryObservationInbox(dir);
    assert.ok(item);
    assert.equal(item.id, result.observationId);
    assert.equal(item.signalType, 'user_feedback');
    assert.equal(item.signalSubtype, 'explicit_user_feedback');
    assert.equal(item.evidence.userFeedbackSnippet, '这个回答遗漏了升级步骤。');
    assert.equal(item.evidence.submittedEvidenceSnippet, '用户要求从 1.x 升级到 2.x。');
    assert.equal(findObservationInboxItem(result.observationId, dir)?.id, result.observationId);
    assert.match(formatObservationShow(item), /coverage=partial capture=explicit_tool_call/);
    assert.match(formatObservationShow(item), /unavailable=full_conversation,external_tool_calls,hidden_reasoning/);
    assert.match(formatObservationShow(item), /userFeedback=这个回答遗漏了升级步骤。/);
  });

  it('is idempotent and rejects identity reuse with another payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-explicit-capture-idempotency-'));
    const input = {
      captureSourceKind: 'chatgpt_plugin',
      skillName: 'demo-skill',
      userFeedback: '缺少边界条件。',
      captureId: 'stable-tool-call-id',
      confirmedByUser: true,
    } as const;
    const first = captureExplicitObservation(input, { observationsDir: dir });
    const second = captureExplicitObservation(input, { observationsDir: dir });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.observationId, first.observationId);
    assert.equal(loadExplicitObservationCaptureRecords(dir).length, 1);
    assert.throws(
      () => captureExplicitObservation({
        ...input,
        userFeedback: '同一个 identity 下的另一条反馈。',
      }, { observationsDir: dir }),
      /已用于不同的 observation payload/,
    );
  });

  it('requires explicit user confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-explicit-capture-confirmation-'));
    assert.throws(
      () => captureExplicitObservation({
        captureSourceKind: 'chatgpt_plugin',
        skillName: 'demo-skill',
        userFeedback: '不应被记录。',
        confirmedByUser: false,
      }, { observationsDir: dir }),
      /用户明确要求记录/,
    );
  });

  it('keeps trace reports unchanged and ignores malformed capture records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-explicit-capture-projection-'));
    saveObservationInboxReport({
      kind: 'observe-inbox',
      schemaVersion: 2,
      meta: {
        tracePath: '/tmp/trace.jsonl',
        generatedAt: '2026-08-24T00:00:00.000Z',
        sessionCount: 1,
        segmentCount: 1,
        itemCount: 1,
      },
      items: [baseItem({ id: 'trace-item', skillName: 'trace-skill' })],
    }, dir);
    captureExplicitObservation({
      captureSourceKind: 'chatgpt_plugin',
      skillName: 'captured-skill',
      userFeedback: '这里的术语已经过期。',
      captureId: 'capture-2',
      confirmedByUser: true,
    }, { observationsDir: dir });
    writeFileSync(join(dir, 'captures', 'malformed.capture.json'), '{not-json');

    const [latest] = loadLatestObservationInboxReports(dir);
    assert.ok(latest);
    assert.equal(latest.meta.tracePath, '/tmp/trace.jsonl');
    assert.equal(latest.meta.sessionCount, 1);
    assert.equal(latest.meta.segmentCount, 1);
    assert.deepEqual(
      queryObservationInbox(dir).map((item) => item.skillName).sort(),
      ['captured-skill', 'trace-skill'],
    );
    assert.equal(readdirSync(join(dir, 'captures')).filter((file) => file.endsWith('.capture.json')).length, 2);
    assert.equal(loadExplicitObservationCaptureRecords(dir).length, 1);
  });
});

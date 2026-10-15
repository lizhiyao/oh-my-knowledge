import { loadClaudeTraceFixture } from '../../helpers/claude-trace.js';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { segmentTraceBySkill, segmentsToAnalysisEntries, tracesToAnalysisEntries } from '../../../src/observability/trace/index.js';
import { asstRec, userRec, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('segmentsToAnalysisEntries', () => {
  it('each segment → one AnalysisEntry with skill as variant key', () => {
    const s = loadClaudeTraceFixture([
      userRec('u1', '<command-name>/audit</command-name>'),
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    const entries = segmentsToAnalysisEntries(segs);
    assert.equal(entries.length, 1);
    assert.match(entries[0].sampleId, /^trace:[a-f0-9]{32}$/);
    assert.ok('audit' in entries[0].variants);
    assert.equal(entries[0].variants.audit.toolCalls?.length, 1);
    assert.equal(entries[0].variants.audit.numToolCalls, 1);
    assert.deepEqual(entries[0].variants.audit.toolDistribution, { Read: 1 });
  });

  it('projects repeated tool calls as call-count distribution', () => {
    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
      asstRec('a1', [
        { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'tu2', name: 'Read', input: {} },
      ]),
    ], 's1'));
    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.deepEqual(result.toolNames, ['Read']);
    assert.deepEqual(result.toolDistribution, { Read: 2 });
  });

  it('rounds projected tool success rates to the persisted report contract', () => {
    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
      asstRec('a1', [
        { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'tu2', name: 'Read', input: {} },
        { type: 'tool_use', id: 'tu3', name: 'Read', input: {} },
      ]),
      userRec('u2', [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'tu2', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'tu3', content: 'failed', is_error: true },
      ]),
    ], 's1'));
    segment.metrics.numToolFailures = 1;
    segment.metrics.numToolUnknown = 0;
    segment.metrics.numToolCancelled = 0;
    segment.toolCalls[0].status = 'success';
    segment.toolCalls[0].statusSource = 'runtime';
    segment.toolCalls[0].success = true;
    segment.toolCalls[1].status = 'success';
    segment.toolCalls[1].statusSource = 'runtime';
    segment.toolCalls[1].success = true;
    segment.toolCalls[2].status = 'failure';
    segment.toolCalls[2].statusSource = 'runtime';
    segment.toolCalls[2].success = false;

    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(result.toolSuccessRate, 0.67);
  });

  it('bounds persisted trace payloads without mutating the source segment', () => {
    const longOutput = `start-${'x'.repeat(1500)}`;
    const longTurn = `question-${'y'.repeat(2500)}`;
    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
      userRec('u1', longTurn),
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: longOutput }]),
    ], 's1'));

    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(result.turns?.[0].content.length, 2001);
    assert.equal(String(result.toolCalls?.[0].output).length, 1001);
    assert.equal(segment.turns[0].content, longTurn);
    assert.equal(segment.toolCalls[0].output, longOutput);
  });

  it('anchors sample identity to the physical segment start instead of its mutable ordinal', () => {
    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
      userRec('u1', '<command-name>/audit</command-name>'),
      asstRec('a1', [{ type: 'text', text: 'done' }]),
    ], 's1'));
    const original = segmentsToAnalysisEntries([segment])[0].sampleId;
    const shiftedOrdinal = segmentsToAnalysisEntries([{
      ...segment,
      segmentIndex: segment.segmentIndex + 3,
      endRecordIndex: (segment.endRecordIndex ?? 0) + 20,
    }])[0].sampleId;
    const changedBoundary = segmentsToAnalysisEntries([{
      ...segment,
      startRecordIndex: (segment.startRecordIndex ?? 0) + 1,
    }])[0].sampleId;
    const changedSkill = segmentsToAnalysisEntries([{
      ...segment,
      skillName: 'other',
    }])[0].sampleId;

    assert.equal(shiftedOrdinal, original);
    assert.notEqual(changedBoundary, original);
    assert.notEqual(changedSkill, original);
  });

  it('includes cache token buckets in the projected total', () => {
    const first = asstRec('a1', [{ type: 'text', text: 'a' }]) as {
      message: {
        usage: {
          cache_read_input_tokens: number;
          cache_creation_input_tokens: number;
        };
      };
    };
    first.message.usage.cache_read_input_tokens = 7;
    first.message.usage.cache_creation_input_tokens = 5;

    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([first], 's1'));
    const result = segmentsToAnalysisEntries([segment])[0].variants.general;

    assert.equal(result.totalTokens, 42);
    assert.equal(result.tokenUsageReportedByExecutor, undefined);
  });
});

describe('tracesToAnalysisEntries (end-to-end)', () => {
  it('loads dir, segments, converts to entries', () => {
    writeSession(fixture.directory, 'x.jsonl', [
      { type: 'permission-mode', sessionId: 'sx' },
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }], { sessionId: 'sx' }),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }], { sessionId: 'sx' }),
    ]);
    const { entries, sessions, segments } = tracesToAnalysisEntries(fixture.directory);
    assert.equal(sessions.length, 1);
    assert.equal(segments.length, 1);
    assert.equal(entries.length, 1);
    assert.equal(segments[0].skillName, 'general');
  });
});

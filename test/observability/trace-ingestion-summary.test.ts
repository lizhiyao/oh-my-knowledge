import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  mergeTraceIngestionSummaries,
  parseTraceIngestionSummary,
  traceIngestionNotices,
} from '../../src/observability/trace-ingestion.js';

const summary = {
  fileCount: 2,
  sourceRecordCount: 4,
  parsedRecordCount: 2,
  malformedRecordCount: 1,
  ignoredValueCount: 1,
  unknownEventCount: 1,
  filteredSessionCount: 1,
};

describe('trace ingestion summary', () => {
  it('formats shared completeness and intentional-filter notices', () => {
    const notices = traceIngestionNotices(summary, 'zh');
    assert.deepEqual(notices.map((notice) => notice.level), ['warning', 'info']);
    assert.match(notices[0].text, /1 条格式损坏记录/);
    assert.match(notices[1].text, /1 个运行时守护会话/);
  });

  it('allows multiple filtered sessions per source file but rejects evidence without files', () => {
    assert.ok(parseTraceIngestionSummary({
      ...summary,
      fileCount: 1,
      filteredSessionCount: 3,
    }));
    assert.equal(parseTraceIngestionSummary({
      ...summary,
      fileCount: 0,
    }), null);
    assert.equal(parseTraceIngestionSummary({
      ...summary,
      fileCount: 0,
      filteredSessionCount: 0,
    }), null);
  });

  it('rejects unsafe persisted counters and fails before aggregate precision is lost', () => {
    assert.equal(parseTraceIngestionSummary({
      ...summary,
      sourceRecordCount: Number.MAX_SAFE_INTEGER + 1,
    }), null);
    assert.equal(parseTraceIngestionSummary({
      ...summary,
      sourceRecordCount: Number.MAX_SAFE_INTEGER,
      parsedRecordCount: Number.MAX_SAFE_INTEGER,
      malformedRecordCount: 1,
      ignoredValueCount: 0,
    }), null);
    assert.throws(
      () => mergeTraceIngestionSummaries([
        {
          fileCount: Number.MAX_SAFE_INTEGER,
          sourceRecordCount: 0,
          parsedRecordCount: 0,
          malformedRecordCount: 0,
          ignoredValueCount: 0,
          unknownEventCount: 0,
          filteredSessionCount: 0,
        },
        {
          fileCount: 1,
          sourceRecordCount: 0,
          parsedRecordCount: 0,
          malformedRecordCount: 0,
          ignoredValueCount: 0,
          unknownEventCount: 0,
          filteredSessionCount: 0,
        },
      ]),
      RangeError,
    );
  });
});

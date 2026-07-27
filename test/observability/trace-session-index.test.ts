import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createTraceSessionIndex,
  type TraceSessionRef,
} from '../../src/observability/trace-session-index.js';
import type { TraceSession } from '../../src/observability/trace-ir.js';

function session(overrides: Partial<TraceSession>): TraceSession {
  return {
    runId: 'run-1',
    rootRunId: 'root-1',
    traceId: 'trace-1',
    groupPath: '/traces',
    role: 'standalone',
    label: 'trace',
    sourcePath: '/traces/one.jsonl',
    sourceKind: 'codex',
    events: [],
    ...overrides,
  };
}

function ref(overrides: Partial<TraceSessionRef>): TraceSessionRef {
  return {
    sessionId: 'root-1',
    ...overrides,
  };
}

describe('trace session index', () => {
  it('fails closed when an explicit traceId is stale', () => {
    const index = createTraceSessionIndex([session({})]);
    assert.equal(index.resolve(ref({
      traceId: 'missing-trace',
      traceSessionId: 'run-1',
      sourceTrace: '/traces/one.jsonl',
    })), undefined);
  });

  it('fails closed when an explicit source/run identity is stale', () => {
    const index = createTraceSessionIndex([session({})]);
    assert.equal(index.resolve(ref({
      traceSessionId: 'run-1',
      sourceTrace: '/traces/other.jsonl',
    })), undefined);
  });

  it('uses weaker keys only when no precise identity is supplied and the key is unambiguous', () => {
    const one = session({});
    const two = session({
      traceId: 'trace-2',
      sourcePath: '/traces/two.jsonl',
      label: 'trace-2',
    });
    const index = createTraceSessionIndex([one, two]);
    assert.equal(index.resolve(ref({ traceSessionId: 'run-1' })), undefined);
    assert.equal(index.resolve(ref({ sourceTrace: '/traces/one.jsonl' })), one);
  });

  it('rejects references whose explicit identity fields contradict each other', () => {
    const one = session({});
    const index = createTraceSessionIndex([one]);
    assert.equal(index.resolve(ref({
      traceId: 'trace-1',
      traceSessionId: 'other-run',
    })), undefined);
    assert.equal(index.resolve(ref({
      traceId: 'trace-1',
      sourceTrace: '/traces/other.jsonl',
    })), undefined);
    assert.equal(index.resolve(ref({
      traceId: 'trace-1',
      sessionId: 'other-root',
    })), undefined);
    assert.equal(index.resolve(ref({
      sourceTrace: '/traces/one.jsonl',
      sessionId: 'other-root',
    })), undefined);
  });
});

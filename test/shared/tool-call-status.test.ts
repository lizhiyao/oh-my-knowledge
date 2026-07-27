import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  isToolCallFailure,
  isToolCallUnknown,
  toolCallStatus,
} from '../../src/shared/tool-call-status.js';

describe('toolCallStatus', () => {
  it('keeps a missing legacy outcome unknown instead of fabricating a failure', () => {
    const call = {};
    assert.equal(toolCallStatus(call), 'unknown');
    assert.equal(isToolCallUnknown(call), true);
    assert.equal(isToolCallFailure(call), false);
  });

  it('uses explicit four-state status before the legacy success flag', () => {
    assert.equal(toolCallStatus({ status: 'cancelled', success: false }), 'cancelled');
    assert.equal(toolCallStatus({ status: 'unknown', success: true }), 'unknown');
  });

  it('preserves explicit legacy booleans', () => {
    assert.equal(toolCallStatus({ success: true }), 'success');
    assert.equal(toolCallStatus({ success: false }), 'failure');
  });

  it('fails closed on an invalid runtime status instead of trusting a legacy flag', () => {
    const malformed = { status: 'completed', success: true } as never;
    assert.equal(toolCallStatus(malformed), 'unknown');
    assert.equal(isToolCallUnknown(malformed), true);
  });
});

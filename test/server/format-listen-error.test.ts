import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatListenError } from '../../src/server/report-server.js';

function nodeErr(code: string, message = `${code}: synthetic`): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('formatListenError', () => {
  it('p=0 + any errno → ephemeral-port message, never "already in use"', () => {
    const out = formatListenError(0, nodeErr('EACCES'));
    assert.ok(out, 'should return an Error for p=0');
    assert.match(out.message, /ephemeral port/);
    assert.doesNotMatch(out.message, /already in use/);
  });

  it('p=0 + EADDRINUSE (synthetic) → still ephemeral-port message, not occupancy', () => {
    // EADDRINUSE on port 0 doesn't actually happen (OS picks free ephemeral),
    // but if it ever surfaced we still must not call it "already in use".
    const out = formatListenError(0, nodeErr('EADDRINUSE'));
    assert.ok(out);
    assert.match(out.message, /ephemeral port/);
  });

  it('p=0 + no errno → ephemeral-port message with "unknown error"', () => {
    const out = formatListenError(0, new Error('weird'));
    assert.ok(out);
    assert.match(out.message, /ephemeral port/);
    assert.match(out.message, /unknown error/);
  });

  it('p=80 + EACCES → permission-denied message, suggests configured report port', () => {
    const out = formatListenError(80, nodeErr('EACCES'));
    assert.ok(out);
    assert.match(out.message, /permission denied/);
    assert.match(out.message, /port 80/);
    assert.match(out.message, /OMK_REPORT_PORT=7799/);
    assert.doesNotMatch(out.message, /already in use/);
  });

  it('p=80 + EPERM → permission-denied message', () => {
    const out = formatListenError(80, nodeErr('EPERM'));
    assert.ok(out);
    assert.match(out.message, /permission denied \(EPERM\)/);
  });

  it('p=8080 + EADDRINUSE → null (caller should run omk-takeover flow)', () => {
    const out = formatListenError(8080, nodeErr('EADDRINUSE'));
    assert.equal(out, null);
  });

  it('p=8080 + ENETUNREACH → fallback message naming the errno', () => {
    const out = formatListenError(8080, nodeErr('ENETUNREACH'));
    assert.ok(out);
    assert.match(out.message, /ENETUNREACH/);
    assert.match(out.message, /pick another port/);
    assert.doesNotMatch(out.message, /already in use/);
    assert.doesNotMatch(out.message, /permission denied/);
  });

  it('p=8080 + no errno → null (fall through to takeover, surfaces unknown via takeover error path)', () => {
    const out = formatListenError(8080, new Error('weird'));
    assert.equal(out, null);
  });

  it('error-message format includes a port-fix suggestion in every branch', () => {
    const cases = [
      formatListenError(0, nodeErr('EACCES')),
      formatListenError(80, nodeErr('EACCES')),
      formatListenError(8080, nodeErr('ENETUNREACH')),
    ];
    for (const out of cases) {
      assert.ok(out);
      assert.match(out.message, /OMK_REPORT_PORT=7799|--port \d+|pick another port|pick another unblocked port/);
    }
  });
});

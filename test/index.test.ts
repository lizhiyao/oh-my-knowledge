import { strict as assert } from 'node:assert';
import { say } from '../src/index.js';

describe('index.test.ts', () => {
  it('should success', () => {
    assert(say('foo') === 'hello, foo');
  });
});

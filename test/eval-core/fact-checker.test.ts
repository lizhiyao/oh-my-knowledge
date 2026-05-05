import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractPathClaims } from '../../src/eval-core/fact-checker.js';

describe('fact-checker path extraction', () => {
  it('does not treat method calls as file paths', () => {
    const claims = extractPathClaims('const data = await res.json(); return data;');
    assert.ok(!claims.includes('res.json'));
  });

  it('still extracts real file paths with known extensions', () => {
    const claims = extractPathClaims('Update eval-samples.json and src/cli/index.ts.');
    assert.ok(claims.includes('eval-samples.json'));
    assert.ok(claims.includes('src/cli/index.ts'));
  });
});

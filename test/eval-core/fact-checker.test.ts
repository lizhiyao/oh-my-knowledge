import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkFacts,
  extractPathClaims,
} from '../../src/eval-core/fact-checker.js';

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

  it('extracts neutral and provider-compatible agent paths', () => {
    const claims = extractPathClaims(
      'Read .agents/skills/review/SKILL.md, .codex/skills/a/SKILL.md, '
      + '.gemini/skills/b/SKILL.md, and .claude/skills/c/SKILL.md.',
    );
    assert.deepEqual(claims, [
      '.agents/skills/review/SKILL.md',
      '.codex/skills/a/SKILL.md',
      '.gemini/skills/b/SKILL.md',
      '.claude/skills/c/SKILL.md',
    ]);
  });

  it('never verifies a path claim outside the evaluation cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-fact-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'omk-fact-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'secret');
      const result = checkFacts(
        'The file is at .agents/../../'
        + `${outside.split('/').at(-1)}/secret.md`,
        root,
      );

      assert.equal(result.totalCount, 1);
      assert.equal(result.verifiedCount, 0);
      assert.match(result.claims[0].evidence || '', /outside the evaluation cwd/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

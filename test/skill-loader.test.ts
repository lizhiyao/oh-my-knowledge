import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEvaluands } from '../lib/skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..', '..', 'examples', 'code-review', 'skills');

describe('resolveEvaluands', () => {
  it('baseline 产生 kind 为 baseline 的 evaluand', () => {
    const evaluands = resolveEvaluands(SKILL_DIR, ['baseline']);
    assert.equal(evaluands.length, 1);
    assert.equal(evaluands[0].name, 'baseline');
    assert.equal(evaluands[0].kind, 'baseline');
    assert.equal(evaluands[0].source, 'baseline');
    assert.equal(evaluands[0].content, null);
  });

  it('文件 variant 产生带 content 的 evaluand', () => {
    const evaluands = resolveEvaluands(SKILL_DIR, ['v1']);
    assert.equal(evaluands.length, 1);
    assert.equal(evaluands[0].name, 'v1');
    assert.equal(evaluands[0].kind, 'skill');
    assert.equal(typeof evaluands[0].content, 'string');
    assert.ok((evaluands[0].content as string).length > 0);
  });

  it('baseline + 文件 variant 组合', () => {
    const evaluands = resolveEvaluands(SKILL_DIR, ['baseline', 'v1', 'v2']);
    assert.equal(evaluands.length, 3);
    assert.equal(evaluands[0].kind, 'baseline');
    assert.equal(evaluands[1].kind, 'skill');
    assert.equal(evaluands[2].kind, 'skill');
  });
});

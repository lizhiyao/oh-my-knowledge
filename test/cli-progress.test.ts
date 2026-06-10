import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { makeOnProgress, makeDoctorProgress } from '../src/cli/lib/progress.js';

function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

describe('CLI progress', () => {
  it('marks failed completed tasks with a failure icon and error', () => {
    const output = captureStderr(() => {
      makeOnProgress('zh')({
        phase: 'done',
        completed: 1,
        total: 1,
        sample_id: 's1',
        variant: 'v1',
        durationMs: 240000,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        ok: false,
        error: 'execution timed out after 240s',
      });
    });

    assert.match(output, /⚠️/);
    assert.doesNotMatch(output, /✓/);
    assert.match(output, /execution timed out after 240s/);
  });
});

describe('doctor progress', () => {
  it('batch (total>1) 显示 [i/n] 前缀 + 体检中 / ✓ pass + 耗时', () => {
    const p = makeDoctorProgress('zh');
    const start = captureStderr(() => p({ phase: 'skill_start', index: 2, total: 3, skillName: 'my-skill' }));
    assert.match(start, /\[2\/3\] my-skill/);
    assert.match(start, /体检中/);

    const done = captureStderr(() => p({ phase: 'skill_done', index: 2, total: 3, skillName: 'my-skill', status: 'pass', durationMs: 1200 }));
    assert.match(done, /\[2\/3\] my-skill/);
    assert.match(done, /✓ pass/);
    assert.match(done, /1200ms/);
  });

  it('single skill (total=1) 省略 [i/n] 前缀', () => {
    const p = makeDoctorProgress('zh');
    const start = captureStderr(() => p({ phase: 'skill_start', index: 1, total: 1, skillName: 'solo' }));
    assert.doesNotMatch(start, /\[1\/1\]/);
    assert.match(start, /solo/);
  });

  it('status 图标:warn → ⚠ warn,fail → ✗ fail', () => {
    const p = makeDoctorProgress('en');
    const warn = captureStderr(() => p({ phase: 'skill_done', index: 1, total: 2, skillName: 's', status: 'warn', durationMs: 5 }));
    assert.match(warn, /⚠ warn/);
    const fail = captureStderr(() => p({ phase: 'skill_done', index: 2, total: 2, skillName: 's', status: 'fail', durationMs: 5 }));
    assert.match(fail, /✗ fail/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor } from '../lib/executor.mjs';
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createExecutor', () => {
  it('returns a function for claude', () => {
    const exec = createExecutor('claude');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for openai', () => {
    const exec = createExecutor('openai');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for gemini', () => {
    const exec = createExecutor('gemini');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for script', () => {
    const exec = createExecutor('script');
    assert.equal(typeof exec, 'function');
  });

  it('defaults to claude', () => {
    const exec = createExecutor();
    assert.equal(typeof exec, 'function');
  });

  it('throws on unknown executor', () => {
    assert.throws(
      () => createExecutor('unknown'),
      /Unknown executor.*Available: claude, openai, gemini, script/,
    );
  });
});

describe('scriptExecutor', () => {
  it('runs eval.sh from skill directory', async () => {
    // Create a mock skill directory with eval.sh
    const skillDir = join(tmpdir(), `omk-test-skill-${Date.now()}`);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'eval.sh'), '#!/bin/bash\necho "# Test Output"\necho "Content from: $1"');

    const exec = createExecutor('script');
    const result = await exec({ model: null, system: skillDir, prompt: 'test input data' });

    assert.equal(result.ok, true);
    assert.ok(result.output.includes('# Test Output'));
    assert.ok(result.durationMs >= 0);

    rmSync(skillDir, { recursive: true, force: true });
  });

  it('parses omk_metrics from stderr', async () => {
    const skillDir = join(tmpdir(), `omk-test-metrics-${Date.now()}`);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'eval.sh'), [
      '#!/bin/bash',
      'echo "# Output"',
      'echo \'{"omk_metrics":{"inputTokens":150,"outputTokens":300,"costUSD":0.003}}\' >&2',
    ].join('\n'));

    const exec = createExecutor('script');
    const result = await exec({ model: null, system: skillDir, prompt: 'test' });

    assert.equal(result.ok, true);
    assert.equal(result.inputTokens, 150);
    assert.equal(result.outputTokens, 300);
    assert.equal(result.costUSD, 0.003);

    rmSync(skillDir, { recursive: true, force: true });
  });

  it('returns error when skill directory is missing', async () => {
    const exec = createExecutor('script');
    const result = await exec({ model: null, system: null, prompt: 'test' });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('skill directory'));
  });
});

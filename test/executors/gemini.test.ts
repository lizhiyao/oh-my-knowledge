import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { geminiExecutor } from '../../src/executors/gemini/index.js';

describe('geminiExecutor process boundary', () => {
  const originalPath = process.env.PATH;
  let dir: string | undefined;

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('does not turn a non-zero exit with partial stdout into success', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omk-gemini-failure-'));
    const executable = join(dir, 'gemini');
    await writeFile(executable, [
      '#!/bin/sh',
      'printf "partial model output"',
      'printf "provider failed" >&2',
      'exit 2',
    ].join('\n'));
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const result = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.equal(result.output, 'partial model output');
    assert.match(result.error ?? '', /provider failed/);
    assert.equal(result.stopReason, 'error');
  });

  it('does not turn an empty zero exit into a successful sample', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omk-gemini-empty-'));
    const executable = join(dir, 'gemini');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const result = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /without model output/);
  });

  it('fails closed on malformed JSON stats and marks omitted cost as unreported', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omk-gemini-metrics-'));
    const executable = join(dir, 'gemini');
    await writeFile(executable, [
      '#!/bin/sh',
      'printf \'{"response":"done","stats":{"inputTokens":-1,"outputTokens":2}}\'',
    ].join('\n'));
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const malformed = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });
    assert.equal(malformed.ok, false);
    assert.match(malformed.error ?? '', /invalid token usage/);

    await writeFile(executable, [
      '#!/bin/sh',
      'printf \'{"response":42,"stats":{"inputTokens":3,"outputTokens":2}}\'',
    ].join('\n'));
    const malformedResponse = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });
    assert.equal(malformedResponse.ok, false);
    assert.match(malformedResponse.error ?? '', /"response" must be a string/);

    await writeFile(executable, [
      '#!/bin/sh',
      'printf \'{"response":"done","stats":null}\'',
    ].join('\n'));
    const malformedStats = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });
    assert.equal(malformedStats.ok, false);
    assert.match(malformedStats.error ?? '', /"stats" must be an object/);

    await writeFile(executable, '#!/bin/sh\nprintf "done"\n');
    const plain = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });
    assert.equal(plain.ok, true);
    assert.equal(plain.costReportedByExecutor, false);
    assert.equal(plain.tokenUsageReportedByExecutor, false);

    await writeFile(executable, [
      '#!/bin/sh',
      'printf \'{"response":"done","stats":{"inputTokens":3,"outputTokens":2}}\'',
    ].join('\n'));
    const measured = await geminiExecutor({
      model: 'gemini-test',
      prompt: 'prompt',
    });
    assert.equal(measured.ok, true);
    assert.equal(measured.tokenUsageReportedByExecutor, undefined);
  });
});

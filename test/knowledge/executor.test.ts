import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredExtractionModel } from '../../src/observability/knowledge-extraction/adapters/executor.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';

const result: ExecResult = { ok: true, output: '{"proposals":[]}', durationMs: 1, durationApiMs: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUSD: 0, stopReason: 'end_turn', numTurns: 1,
  costReportedByExecutor: false, tokenUsageReportedByExecutor: false };

describe('knowledge generation executor boundary', () => {
  it.each(['success', 'failure', 'cancel'] as const)('cleans its isolated directory after %s', async (outcome) => {
    let directory = '';
    const controller = new AbortController();
    const model = configuredExtractionModel('codex', 'test', async (input) => {
      directory = input.cwd!;
      expect(readdirSync(directory)).toEqual([]);
      expect(input).toMatchObject({ lean: true, textOnly: true, allowedSkills: [], model: 'test' });
      writeFileSync(join(directory, 'runtime-output'), 'fixture');
      if (outcome === 'failure') throw new Error('fixture failure');
      if (outcome === 'cancel') controller.abort();
      return result;
    });
    const pending = model.generate('system', 'selected evidence', controller.signal);
    if (outcome === 'success') {
      expect(await pending).toEqual({ output: result.output, durationMs: 1 });
    } else await expect(pending).rejects.toThrow();
    expect(directory).not.toBe('');
    expect(existsSync(directory)).toBe(false);
  });
  it('rejects unsupported executor selection before invoking a runtime', () => {
    expect(() => configuredExtractionModel('codex-sdk', 'test')).toThrow('restricted');
  });
});

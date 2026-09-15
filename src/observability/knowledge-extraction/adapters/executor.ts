import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../../../executors/index.js';
import type { ExecutorFn } from '../../../executors/contracts/ports.js';
import type { ExtractionModel } from '../application.js';

export function configuredExtractionModel(executor: string, model: string, implementation?: ExecutorFn): ExtractionModel {
  if (!['codex', 'openai-api', 'anthropic-api'].includes(executor)) {
    throw new Error(`Executor ${executor} has no knowledge-generation adapter.`);
  }
  if (!model.trim()) throw new Error('An explicitly configured model is required.');
  return {
    executor, model,
    async generate(system, input, signal) {
      signal?.throwIfAborted();
      const cwd = executor === 'codex' ? mkdtempSync(join(tmpdir(), 'omk-knowledge-text-')) : undefined;
      try {
        const execute = implementation ?? createExecutor(executor);
        const result = await execute({ model, system, prompt: input,
          ...(cwd ? { cwd, allowedSkills: [] } : {}),
          timeoutMs: 300_000, abortSignal: signal });
        signal?.throwIfAborted();
        if (!result.ok || result.output === null) throw new Error(result.error ?? `Generation failed: ${result.stopReason}`);
        if (result.toolCalls?.length) throw new Error('Text extraction unexpectedly invoked a tool; output was rejected.');
        return {
          output: result.output, durationMs: result.durationMs,
          ...(result.tokenUsageReportedByExecutor === false ? {} : { inputTokens: result.inputTokens, outputTokens: result.outputTokens }),
          ...(result.costReportedByExecutor === false ? {} : { costUSD: result.costUSD }),
        };
      } finally { if (cwd) rmSync(cwd, { recursive: true, force: true }); }
    },
  };
}

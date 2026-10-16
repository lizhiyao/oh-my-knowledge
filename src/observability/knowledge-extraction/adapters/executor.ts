import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExecutorInput } from '../../../executors/contracts/ports.js';
import type { ExecutorArchiveProducer } from '../../../executors/contracts/archive.js';
import type { ExtractionModel } from '../generation.js';
import type { ExtractionOutcome } from '../runs.js';
import { observeExtractionException } from '../generation.js';
import { WINDOW_EXTRACTION_WIRE_ID, WINDOW_EXTRACTION_WIRE_SCHEMA } from '../model-wire.js';
import { canonicalJson } from '../../../knowledge/store.js';

export function validateExtractionModelSelection(executor: string, model: string): void {
  if (!['codex', 'openai-api'].includes(executor)) {
    throw new Error(`Executor ${executor} has no knowledge-generation adapter.`);
  }
  if (!model.trim()) throw new Error('An explicitly configured model is required.');
}

/** Delivery supplies a concrete, frozen producer. Inspect is local; generation performs one invocation. */
export function configuredExtractionModel(executor: string, model: string, producer: ExecutorArchiveProducer): ExtractionModel {
  validateExtractionModelSelection(executor, model);
  const privateRoot = resolve(tmpdir());
  const request = (system: string, input: string): ExecutorInput => ({ model, system, prompt: input,
    outputFormat: { mode: 'json-schema', name: 'knowledge_extraction_v1', schema: WINDOW_EXTRACTION_WIRE_SCHEMA },
    timeoutMs: 300_000, ...(executor === 'openai-api' ? { maxOutputTokens: 4096 } : {}) });
  const inspected = new Map<string, string>();
  const inspect = (system: string, input: string) => {
    const execution = request(system, input);
    const evidence = producer.inspect(executor, execution);
    inspected.set(canonicalJson(execution), canonicalJson(evidence));
    return evidence;
  };
  return {
    executor, model, outputMode: 'json-schema', wireId: WINDOW_EXTRACTION_WIRE_ID, timeoutMs: 300_000,
    ...(executor === 'openai-api' ? { maxOutputTokens: 4096 } : {}), inspect,
    async generate(system, input, signal): Promise<ExtractionOutcome> {
      signal?.throwIfAborted();
      const execution = request(system, input), key = canonicalJson(execution);
      if (!inspected.has(key)) inspect(system, input);
      const configured = producer.configure(executor, execution);
      if (canonicalJson(configured.evidence) !== inspected.get(key)) throw new Error('Extraction producer changed after reservation.');
      let cwd: string | undefined, outcome: Exclude<ExtractionOutcome, { outcomeKind: 'model-port-projection' }>;
      try {
        if (executor === 'codex') cwd = mkdtempSync(join(privateRoot, 'omk-knowledge-text-'));
        // Admission, tool/refusal checks and cancellation decisions follow the archive acknowledgement.
        const result = await configured.execute({ ...execution, ...(cwd ? { cwd } : {}), abortSignal: signal });
        outcome = { outcomeKind: 'result', result: result as unknown as Extract<ExtractionOutcome, { outcomeKind: 'result' }>['result'] };
      } catch (error) { outcome = { outcomeKind: 'exception', error: observeExtractionException(error) }; }
      finally {
        if (cwd) {
          try { rmSync(cwd, { recursive: true, force: true }); }
          catch { outcome!.cleanupFailure = { diagnostic: 'Private execution directory cleanup failed.' }; }
        }
      }
      return outcome;
    },
  };
}

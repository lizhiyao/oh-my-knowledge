import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import type { ExecutorArchiveProducer } from '../../executors/contracts/archive.js';
import type { ExtractionModel } from '../extraction/generation.js';
import type { ExtractionOutcome } from '../extraction/runs.js';
import { observeExtractionException } from '../extraction/generation.js';
import { WINDOW_EXTRACTION_WIRE_ID, WINDOW_EXTRACTION_WIRE_SCHEMA } from '../extraction/model-wire.js';
import { canonicalJson } from '../store.js';

export function validateExtractionModelSelection(executor: string, model: string): void {
  if (!['codex', 'openai-api'].includes(executor)) {
    throw new Error(`Executor ${executor} has no knowledge-generation adapter.`);
  }
  if (!model.trim()) throw new Error('An explicitly configured model is required.');
}

/** Delivery supplies a concrete, frozen producer. Inspect is local; generation performs one invocation. */
export function configuredExtractionModel(executor: string, model: string, producer: ExecutorArchiveProducer,
  options?: { maxOutputTokens?: number }): ExtractionModel {
  validateExtractionModelSelection(executor, model);
  const maxOutputTokens = options?.maxOutputTokens === undefined ? executor === 'openai-api' ? 4096 : undefined : options.maxOutputTokens;
  if (options?.maxOutputTokens !== undefined) producer.assertCapabilities(executor, { model, prompt: '', maxOutputTokens });
  const privateRoot = resolve(tmpdir());
  const request = (system: string, input: string): ExecutorInput => ({ model, system, prompt: input,
    outputFormat: { mode: 'json-schema', name: 'knowledge_extraction_v1', schema: WINDOW_EXTRACTION_WIRE_SCHEMA },
    timeoutMs: 300_000, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
  const inspected = new Map<string, string>();
  const inspect = (system: string, input: string) => {
    const execution = request(system, input);
    const evidence = producer.inspect(executor, execution);
    inspected.set(canonicalJson(execution), canonicalJson(evidence));
    return evidence;
  };
  return {
    executor, model, outputMode: 'json-schema', wireId: WINDOW_EXTRACTION_WIRE_ID, timeoutMs: 300_000,
    dispatchGate: 'producer-before-dispatch/v1', ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), inspect,
    async generate(system, input, signal, beforeDispatch): Promise<ExtractionOutcome> {
      signal?.throwIfAborted();
      const execution = request(system, input), key = canonicalJson(execution);
      if (!inspected.has(key)) inspect(system, input);
      const configured = producer.configure(executor, execution, beforeDispatch);
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

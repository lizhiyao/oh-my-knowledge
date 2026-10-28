import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import type { ExecutorArchiveEvidence, ExecutorArchiveProducer } from '../../executors/contracts/archive.js';
import type { GenerationProfile } from '../extraction/body-generation-wire.js';
import { observeGenerationException, type GenerationOutcome } from '../extraction/native-outcome.js';
import { canonicalJson } from '../store.js';

export interface KnowledgeGenerationModel {
  executor: string; model: string; timeoutMs: number;
  inspect(profile: GenerationProfile, input: string): ExecutorArchiveEvidence;
  invoke(profile: GenerationProfile, input: string, signal?: AbortSignal, beforeDispatch?: () => void): Promise<GenerationOutcome>;
}
/** Each phase has its own exact request-specific archive proof, never the old window wire. */
export function configuredKnowledgeGenerationModel(executor: string, model: string, producer: ExecutorArchiveProducer,
  timeoutMs = 300_000): KnowledgeGenerationModel {
  if (!['codex', 'openai-api'].includes(executor) || !model.trim()) throw new Error('Unsupported knowledge generation model.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Invalid generation timeout.');
  const inspected = new Map<string, string>();
  const request = (profile: GenerationProfile, input: string): ExecutorInput => ({ model, system: profile.system, prompt: input, timeoutMs,
    outputFormat: { mode: 'json-schema', name: profile.outputName, schema: profile.wireSchema } });
  const inspect = (profile: GenerationProfile, input: string) => {
    const execution = request(profile, input); producer.assertCapabilities(executor, execution);
    const evidence = producer.inspect(executor, execution); inspected.set(canonicalJson(execution), canonicalJson(evidence)); return evidence;
  };
  return { executor, model, timeoutMs, inspect,
    async invoke(profile, input, signal, beforeDispatch) {
      signal?.throwIfAborted(); const execution = request(profile, input), key = canonicalJson(execution);
      if (!inspected.has(key)) throw new Error('Generation dispatch requires a prepared producer proof.');
      let dispatched = false;
      const configured = producer.configure(executor, execution, () => { beforeDispatch?.(); dispatched = true; });
      if (canonicalJson(configured.evidence) !== inspected.get(key)) throw new Error('Generation producer changed after claim.');
      let cwd: string | undefined, outcome: GenerationOutcome | undefined;
      try {
        if (executor === 'codex') cwd = mkdtempSync(join(tmpdir(), 'omk-knowledge-text-'));
        const result = await configured.execute({ ...execution, ...(cwd ? { cwd } : {}), abortSignal: signal });
        outcome = { outcomeKind: 'result', result: result as unknown as Extract<GenerationOutcome, { outcomeKind: 'result' }>['result'] };
      } catch (error) {
        if (!dispatched) throw error; // Local gate refusal is not a native executor original.
        outcome = { outcomeKind: 'exception', error: observeGenerationException(error) };
      }
      finally {
        if (cwd) try { rmSync(cwd, { recursive: true, force: true }); }
        catch { if (outcome) outcome.cleanupFailure = { diagnostic: 'Private generation directory cleanup failed.' };
          else throw new Error('Private generation directory cleanup failed before native dispatch.'); }
      }
      if (!outcome) throw new Error('Generation returned no outcome.');
      return outcome;
    },
  };
}

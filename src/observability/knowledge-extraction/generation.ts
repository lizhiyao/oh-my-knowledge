import { createHash } from 'node:crypto';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExtractionJson, ExtractionOutcome } from './runs.js';
import { canonicalJson } from '../../knowledge/store.js';
import { WINDOW_EXTRACTION_WIRE_ID, decodeWindowExtractionWire } from './model-wire.js';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION } from './prompt.js';
import { STRICT_EXTRACTION_PROMPT, STRICT_EXTRACTION_PROMPT_VERSION } from './strict-prompt.js';

export const EXTRACTION_GENERATION_POLICY = Object.freeze({
  policyId: 'knowledge-generation-single/v1' as const,
  maxInvocations: 1 as const, retry: 'none' as const, fallback: 'none' as const,
});
export const EXTRACTION_OUTCOME_MAX_BYTES = 512 * 1024 * 1024 - 64 * 1024;
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const extractionRequestDigest = (value: unknown) => digest(canonicalJson(value));
export interface AuthoredExtractionResult {
  output: string; durationMs: number; inputTokens?: number; outputTokens?: number; costUSD?: number;
}
/** Concrete adapters expose their archive witness; authored model ports have an explicit narrower evidence scope. */
export interface ExtractionModel {
  executor: string; model: string;
  readonly outputMode?: 'json-schema' | 'prompt-json';
  readonly wireId?: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  inspect?(system: string, input: string): ExecutorArchiveEvidence;
  generate(system: string, input: string, signal?: AbortSignal): Promise<AuthoredExtractionResult | ExtractionOutcome>;
}

export function extractionPrompt(model: Pick<ExtractionModel, 'outputMode'>) {
  return model.outputMode === 'json-schema'
    ? { system: STRICT_EXTRACTION_PROMPT, promptVersion: STRICT_EXTRACTION_PROMPT_VERSION }
    : { system: EXTRACTION_PROMPT, promptVersion: EXTRACTION_PROMPT_VERSION };
}

/** Exceptions are observations, with accessors skipped and an explicit representation bound. */
export function observeExtractionException(error: unknown): Extract<ExtractionOutcome, { outcomeKind: 'exception' }>['error'] {
  const sourceType = typeof error;
  let name: string | null = null, message = '', accessorsSkipped = false;
  if (typeof error === 'string') message = error;
  else if (error !== null && (sourceType === 'object' || sourceType === 'function')) {
    for (const field of ['name', 'message'] as const) {
      let object: object | null = error as object;
      for (let depth = 0; object && depth < 16; depth++) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(object, field);
          if (descriptor) {
            if ('value' in descriptor && typeof descriptor.value === 'string') {
              if (field === 'name') name = descriptor.value; else message = descriptor.value;
            } else if (descriptor.get || descriptor.set) accessorsSkipped = true;
            break;
          }
          object = Object.getPrototypeOf(object);
        } catch { accessorsSkipped = true; break; }
      }
    }
  } else message = String(error);
  const bounded = (value: string, bytes: number) => {
    let result = value.slice(0, bytes);
    while (Buffer.byteLength(result, 'utf8') > bytes) result = result.slice(0, -1);
    return result;
  };
  const shortName = name === null ? null : bounded(name, 256), shortMessage = bounded(message, 4096);
  return { representationKind: 'exception-diagnostic/v1', sourceType,
    name: shortName, message: shortMessage, truncated: shortName !== name || shortMessage !== message, accessorsSkipped };
}

export function extractionExecution(model: ExtractionModel, system: string, input: string) {
  const outputMode = model.outputMode ?? 'prompt-json';
  if (outputMode === 'json-schema' && model.wireId !== WINDOW_EXTRACTION_WIRE_ID) throw new Error('Extraction wire identity conflict.');
  const producer = model.inspect?.(system, input) ?? {
    producerId: 'authored-model-port/v1', producerRevision: digest('authored-model-port/v1'),
    sourceChannels: [{ channel: 'author-supplied-model-result', maxBytes: EXTRACTION_OUTCOME_MAX_BYTES }],
    maxOutcomeJsonBytes: EXTRACTION_OUTCOME_MAX_BYTES,
    proof: { proofKind: 'authored-model-port/v1', scope: 'author-supplied-result;not-an-executor-transport-bound' },
  };
  if (!Number.isSafeInteger(producer.maxOutcomeJsonBytes) || producer.maxOutcomeJsonBytes < 1
    || producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) throw new Error('Extraction outcome archive capacity exceeded before invocation.');
  return { outputMode, ...(model.wireId ? { wireId: model.wireId } : {}),
    timeoutMs: model.timeoutMs ?? 300_000, ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    systemDigest: digest(system), inputDigest: digest(input), producer };
}

export async function invokeExtractionModel(model: ExtractionModel, system: string, input: string, signal?: AbortSignal): Promise<ExtractionOutcome> {
  let value: Awaited<ReturnType<ExtractionModel['generate']>>;
  try {
    value = await model.generate(system, input, signal);
  } catch (error) { return { outcomeKind: 'exception', error: observeExtractionException(error) }; }
  return 'outcomeKind' in value ? value : { outcomeKind: 'model-port-projection', scope: 'authored-model-port/v1', result: value };
}

/** Standard JSON data representation (undefined omission/nonfinite null), without recursive stringify on returned trace values. */
export function serializeExtractionObservation(input: unknown): ExtractionJson {
  const active = new WeakSet<object>();
  const stack: { source: object; target: Record<string, ExtractionJson> | ExtractionJson[]; keys: string[]; index: number }[] = [];
  const copy = (value: unknown): ExtractionJson => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== 'object' || active.has(value)) throw new Error('Returned extraction observation is not JSON data.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error('Returned extraction observation has a non-JSON prototype.');
    const target: Record<string, ExtractionJson> | ExtractionJson[] = array ? [] : {};
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    active.add(value); stack.push({ source: value, target, keys, index: 0 }); return target;
  };
  const output = copy(input);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.keys.length) { active.delete(frame.source); stack.pop(); continue; }
    const key = frame.keys[frame.index++], descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (descriptor && !('value' in descriptor)) throw new Error('Returned extraction observation contains an accessor.');
    const value: unknown = descriptor?.value;
    if (value === undefined && !Array.isArray(frame.target)) continue;
    const child = value === undefined ? null : copy(value);
    Object.defineProperty(frame.target, key, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return output;
}

export function extractionOutcomeResult(outcome: ExtractionOutcome) {
  return outcome.outcomeKind === 'exception' ? undefined : outcome.result;
}

/** Archive first. This function only derives admission and never edits the returned executor fact. */
export function extractionResponse(outcome: ExtractionOutcome, outputMode: 'json-schema' | 'prompt-json', wireId?: string) {
  if (outputMode === 'json-schema' && wireId !== WINDOW_EXTRACTION_WIRE_ID) throw new Error('Saved extraction wire identity differs from the current decoder; use its frozen version.');
  const fail = (failureKind: string, diagnostic: string) => ({ status: 'failed' as const, failure: { failureKind, diagnostic } });
  if (outcome.outcomeKind === 'exception') return fail('exception', outcome.error.message || 'Extraction invocation threw an exception.');
  const result = outcome.result;
  if (outcome.outcomeKind === 'result') {
    const native = outcome.result;
    if (native.ok !== true) {
      const failure = native.failure;
      return fail(failure && typeof failure === 'object' && !Array.isArray(failure) && typeof failure.failureKind === 'string'
        ? failure.failureKind : 'unknown', typeof native.error === 'string' ? native.error : 'Extraction executor failed.');
    }
    if (native.refusal !== undefined) return fail('refusal', 'Extraction executor returned a refusal.');
    if (Array.isArray(native.toolCalls) && native.toolCalls.length) return fail('unexpected_tools', 'Text extraction unexpectedly invoked a tool; output was rejected.');
  }
  if (typeof result.output !== 'string') return fail('invalid_result', 'Extraction did not return original assistant text.');
  // Preserve the existing JavaScript string-length ceiling; native output remains in the archive even on failure.
  if (result.output.length > 2 * 1024 * 1024) return fail('capacity', 'Extraction response exceeds capacity.');
  if (outputMode === 'json-schema') {
    if (Buffer.from(result.output, 'utf8').toString('utf8') !== result.output) return fail('invalid_result', 'Extraction output contains invalid Unicode; original code units remain archived.');
    const decoded = decodeWindowExtractionWire(Buffer.from(result.output, 'utf8'));
    if (decoded.decodeStatus !== 'decoded') return fail(decoded.failureKind === 'invalid_json' ? 'parse_error' : 'wire_error', decoded.error);
    return { status: 'decoded' as const, response: decoded.domainInput, rawOutput: result.output,
      wireDiagnostic: { wireId: decoded.wireId, wireStatus: decoded.wireStatus, itemFailures: decoded.wireFailures } };
  }
  try { return { status: 'decoded' as const, response: JSON.parse(result.output) as unknown, rawOutput: result.output }; }
  catch { return fail('parse_error', 'Extraction response is not valid JSON.'); }
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExtractionJson, ExtractionOutcome } from './runs.js';
import { canonicalJson } from '../store.js';
import { WINDOW_EXTRACTION_WIRE_ID, decodeWindowExtractionWire } from './model-wire.js';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION } from './prompt.js';
import { STRICT_EXTRACTION_PROMPT, STRICT_EXTRACTION_PROMPT_VERSION } from './strict-prompt.js';
import { ENTITY_ONLY_EXTRACTION_PROMPT_VERSION, ENTITY_ONLY_EXTRACTION_SYSTEM_DIGEST } from './entity-only-prompt.js';
import { OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION, OCCURRENCE_GUIDED_EXTRACTION_SYSTEM_DIGEST } from './occurrence-guided-prompt.js';

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
  readonly dispatchGate?: 'producer-before-dispatch/v1';
  inspect?(system: string, input: string): ExecutorArchiveEvidence;
  generate(system: string, input: string, signal?: AbortSignal, beforeDispatch?: () => void): Promise<AuthoredExtractionResult | ExtractionOutcome>;
}

export const ExtractionPromptProfileSchema = z.strictObject({
  profileVersion: z.literal('knowledge-extraction-prompt-profile/v1'),
  promptVersion: z.string().regex(/^knowledge-extraction-v[1-9]\d*(?![\s\S])/),
  system: z.string().min(1).max(2 * 1024 * 1024).refine(value => value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= 2 * 1024 * 1024 && Buffer.from(value, 'utf8').toString('utf8') === value),
});
export type ExtractionPromptProfile = z.infer<typeof ExtractionPromptProfileSchema>;

// Published identities remain pinned after defaults advance. These digests do not
// load historical implementations or rewrite existing runs.
const publishedPromptDigests: Readonly<Record<string, string>> = Object.freeze({
  'knowledge-extraction-v19': 'sha256:a8ded7271b06aa3faa4c16e4875d693f03b7bb5be63748bfb3a585f1f8d9e745',
  'knowledge-extraction-v20': 'sha256:581732fbe83f847ba6fe2f809fb0bd65e04dd7a69a7b924952c97bd5408901b9',
  'knowledge-extraction-v21': 'sha256:beea0e93590f82fcf6ca30df279cb89e2e7eb62f39da5cfa4543a5ab1ddba130',
  'knowledge-extraction-v22': 'sha256:c52c995810a59fde98cd4c9ac3812fd23ce79ca2e6ad85436cd3904eb574d179',
  'knowledge-extraction-v23': 'sha256:55db71e6e190bc8059cbecd8f68f18159de0fc60721ad4cb3debf51088b2058a',
  'knowledge-extraction-v24': 'sha256:b6d6de8496817d98a8d36cc751a37f394379d5cccb673e4c7ba74adbafe0ce99',
  'knowledge-extraction-v25': 'sha256:aecb8127e6b936f308fe7a87de4bb044b4aaaf357ef801d6f09d9326d3860614',
  'knowledge-extraction-v26': 'sha256:1d7b8b43b0918af7fc14b32c0cc20ef55f5d61e7c0109d66c5714d02d82225b7',
  'knowledge-extraction-v27': 'sha256:8d58914f4fe02eaf16cfae409df1dd1e839abe9ff626669cfbdd187ad50d61b9',
  'knowledge-extraction-v28': 'sha256:d7746055f9ba82b4720d065465e0df2e3e5654c3071d9a2f159186fde7073b3d',
  'knowledge-extraction-v29': 'sha256:ad1dc989b54427edfeb6b8e771a1f5204ac007d93b616dd7bcc10d2fa4fbac91',
  'knowledge-extraction-v30': 'sha256:45ccb3821a6ec2c0ee1bc5f8f6ab4f2e3590724e2d4453cd39d77f46d4fb0085',
  'knowledge-extraction-v31': 'sha256:dbe367bf49eb5c4dd9a2d94eec8ecfacbda761d9d4904737f1b417a20ae8c37e',
  'knowledge-extraction-v32': 'sha256:488c21d07419befc6750456bb7d1ac1ebac62454a403e781c86cfd23ddc2ccda',
  [ENTITY_ONLY_EXTRACTION_PROMPT_VERSION]: ENTITY_ONLY_EXTRACTION_SYSTEM_DIGEST,
  [OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION]: OCCURRENCE_GUIDED_EXTRACTION_SYSTEM_DIGEST,
});
for (const current of [{ promptVersion: EXTRACTION_PROMPT_VERSION, system: EXTRACTION_PROMPT },
  { promptVersion: STRICT_EXTRACTION_PROMPT_VERSION, system: STRICT_EXTRACTION_PROMPT }]) {
  if (publishedPromptDigests[current.promptVersion] !== digest(current.system)) {
    throw new Error('Default extraction prompt requires an explicitly registered version and raw byte digest.');
  }
}

/** Explicit study profiles preserve raw bytes and cannot relabel registered published versions. */
export function extractionPrompt(model: Pick<ExtractionModel, 'outputMode'>, profileInput?: ExtractionPromptProfile) {
  const standard = model.outputMode === 'json-schema'
    ? { system: STRICT_EXTRACTION_PROMPT, promptVersion: STRICT_EXTRACTION_PROMPT_VERSION }
    : { system: EXTRACTION_PROMPT, promptVersion: EXTRACTION_PROMPT_VERSION };
  if (profileInput === undefined) return standard;
  const profile = ExtractionPromptProfileSchema.parse(profileInput);
  const knownDigest = publishedPromptDigests[profile.promptVersion];
  if (knownDigest !== undefined && digest(profile.system) !== knownDigest) {
    throw new Error('A known extraction prompt version cannot identify different bytes.');
  }
  return { system: profile.system, promptVersion: profile.promptVersion };
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

export async function invokeExtractionModel(model: ExtractionModel, system: string, input: string, signal?: AbortSignal, beforeDispatch?: () => void): Promise<ExtractionOutcome> {
  let value: Awaited<ReturnType<ExtractionModel['generate']>>;
  try {
    if (!model.dispatchGate) beforeDispatch?.();
    value = await model.generate(system, input, signal, beforeDispatch);
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

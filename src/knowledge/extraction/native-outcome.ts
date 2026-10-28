import { createHash } from 'node:crypto';
import { z } from 'zod';

export type GenerationJson = null | boolean | number | string | GenerationJson[] | { [key: string]: GenerationJson };
export interface GenerationNativeResult { ok: boolean; output: string | null; [key: string]: GenerationJson }
export interface GenerationException {
  representationKind: 'exception-diagnostic/v1'; sourceType: string; name: string | null;
  message: string; truncated: boolean; accessorsSkipped: boolean;
}
export type GenerationOutcome =
  | { outcomeKind: 'result'; result: GenerationNativeResult; cleanupFailure?: { diagnostic: string } }
  | { outcomeKind: 'exception'; error: GenerationException; cleanupFailure?: { diagnostic: string } };
export const GenerationOutcomeRefSchema = z.strictObject({ bytes: z.number().int().positive(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
export type GenerationOutcomeRef = z.infer<typeof GenerationOutcomeRefSchema>;

/** Standard JSON observation; getters and non-JSON prototypes never execute. */
export function observeGenerationJSON(input: unknown): GenerationJson {
  const active = new WeakSet<object>();
  const frames: { source: object; target: Record<string, GenerationJson> | GenerationJson[]; keys: string[]; index: number }[] = [];
  const copy = (value: unknown): GenerationJson => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== 'object' || active.has(value)) throw new Error('Generation outcome is not JSON data.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error('Generation outcome has a non-JSON prototype.');
    const target: Record<string, GenerationJson> | GenerationJson[] = array ? [] : {};
    active.add(value); frames.push({ source: value, target, keys: array ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value), index: 0 });
    return target;
  };
  const result = copy(input);
  while (frames.length) {
    const frame = frames.at(-1)!;
    if (frame.index === frame.keys.length) { active.delete(frame.source); frames.pop(); continue; }
    const key = frame.keys[frame.index++], descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (descriptor && !('value' in descriptor)) throw new Error('Generation outcome contains an accessor.');
    const value: unknown = descriptor?.value;
    if (value === undefined && !Array.isArray(frame.target)) continue;
    Object.defineProperty(frame.target, key, { value: value === undefined ? null : copy(value), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function* stringChunks(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 16_384, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
  }
  yield '"';
}
/** Canonical object key order, including deeply nested native trace fields. */
export function* generationJSONChunks(value: GenerationJson): Generator<string> {
  const frames: { value: GenerationJson; keys?: string[]; index: number }[] = [{ value, index: 0 }];
  while (frames.length) {
    const frame = frames.at(-1)!, current = frame.value;
    if (typeof current === 'string') { yield* stringChunks(current); frames.pop(); continue; }
    if (current === null || typeof current !== 'object') { yield JSON.stringify(current); frames.pop(); continue; }
    const array = Array.isArray(current), object = current as Record<string, GenerationJson>;
    if (!frame.keys) { frame.keys = Object.keys(object); if (!array) frame.keys.sort(); yield array ? '[' : '{'; }
    if (frame.index === frame.keys.length) { yield array ? ']' : '}'; frames.pop(); continue; }
    const key = frame.keys[frame.index++]; if (frame.index > 1) yield ',';
    if (!array) { yield* stringChunks(key); yield ':'; }
    frames.push({ value: object[key], index: 0 });
  }
}
export function measureGenerationJSON(value: GenerationJson, maximum: number): GenerationOutcomeRef {
  const hash = createHash('sha256'); let bytes = 0;
  for (const chunk of generationJSONChunks(value)) {
    bytes += Buffer.byteLength(chunk); if (bytes > maximum) throw new Error('Generation archive capacity exceeded.'); hash.update(chunk);
  }
  return { bytes, digest: `sha256:${hash.digest('hex')}` };
}
export function checkGenerationOutcome(value: unknown): GenerationOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid generation outcome.');
  const outcome = value as GenerationOutcome;
  const allowed = new Set(['outcomeKind', outcome.outcomeKind === 'result' ? 'result' : 'error', 'cleanupFailure']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Invalid generation outcome fields.');
  if (outcome.cleanupFailure && (Object.keys(outcome.cleanupFailure).length !== 1 || typeof outcome.cleanupFailure.diagnostic !== 'string')) throw new Error('Invalid generation cleanup diagnostic.');
  if (outcome.outcomeKind === 'result' && outcome.result && typeof outcome.result.ok === 'boolean'
    && (outcome.result.output === null || typeof outcome.result.output === 'string')) return outcome;
  if (outcome.outcomeKind === 'exception') {
    z.strictObject({ representationKind: z.literal('exception-diagnostic/v1'), sourceType: z.string(), name: z.string().max(256).nullable(),
      message: z.string().max(4096), truncated: z.boolean(), accessorsSkipped: z.boolean() }).parse(outcome.error);
    return outcome;
  }
  throw new Error('Invalid generation outcome.');
}
export function observeGenerationException(error: unknown): GenerationException {
  let name: string | null = null, message = typeof error === 'string' ? error : '', accessorsSkipped = false;
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    for (const field of ['name', 'message'] as const) {
      let current: object | null = error;
      for (let depth = 0; current && depth < 16; depth++) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(current, field);
          if (descriptor) {
            if ('value' in descriptor && typeof descriptor.value === 'string') { if (field === 'name') name = descriptor.value; else message = descriptor.value; }
            else if (descriptor.get || descriptor.set) accessorsSkipped = true;
            break;
          }
          current = Object.getPrototypeOf(current);
        } catch { accessorsSkipped = true; break; }
      }
    }
  }
  const bounded = (v: string, max: number) => { let s = v.slice(0, max); while (Buffer.byteLength(s) > max) s = s.slice(0, -1); return s; };
  const shortName = name === null ? null : bounded(name, 256), shortMessage = bounded(message, 4096);
  return { representationKind: 'exception-diagnostic/v1', sourceType: typeof error, name: shortName, message: shortMessage,
    truncated: shortName !== name || shortMessage !== message, accessorsSkipped };
}

import { createHash } from 'node:crypto';
import type { ExecutorFn, ExecutorInput } from '../contracts/ports.js';
import type { ExecutorArchiveProducer } from '../contracts/archive.js';
import { createExecutor } from '../index.js';
import { assertExecutorInputCapabilities } from '../core/capabilities.js';
import { MAX_API_RESPONSE_BYTES } from '../core/http.js';
import { buildOpenAiChatRequest, OPENAI_CHAT_REQUEST_VERSION, type OpenAiDispatchPolicy } from './request.js';
import { OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION } from './api.js';

export type OpenAiArchiveExecutorFactory = (name: string, options: { env: NodeJS.ProcessEnv; apiDispatchPolicy: OpenAiDispatchPolicy }) => ExecutorFn;
const textHash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PRODUCER = 'openai-chat-archive/v1';
const revision = textHash(JSON.stringify({ producer: PRODUCER, api: OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION,
  builder: OPENAI_CHAT_REQUEST_VERSION, httpMax: MAX_API_RESPONSE_BYTES, proofVersion: 'three-utf8-strings-double-diagnostic-redaction-signed-duration/v1',
  dispatchGate: 'producer-before-dispatch/v1' }));
/** The exact same credential variants/order as diagnostics.ts; values never enter the witness. */
export function openAiArchiveDiagnosticGrowth(environment: NodeJS.ProcessEnv): bigint {
  const credentials = [...new Set(Object.entries(environment)
    .filter(([key]) => /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SECRET_ACCESS_KEY)$/i.test(key))
    .flatMap(([, value]) => value ? [value, value.trim(), JSON.stringify(value).slice(1, -1)].filter(Boolean) : []))]
    .sort((left, right) => right.length - left.length);
  // Each split/join replaces at least L code units with 10; ceil(10/L) is
  // conservative. Bearer/Basic replace >=1 token unit with 10 (prefix unchanged).
  let growth = 10n;
  for (const credential of credentials) growth *= BigInt(Math.max(1, Math.ceil(10 / credential.length)));
  return growth;
}
export function createOpenAiArchiveProducer(environment: NodeJS.ProcessEnv, create: OpenAiArchiveExecutorFactory = createExecutor): ExecutorArchiveProducer {
  const env = Object.freeze({ ...environment });
  const inspect = (executor: string, input: ExecutorInput) => {
    if (executor !== 'openai-api') throw new Error('Codex archive capacity is not yet proven; no invocation was started.');
    assertExecutorInputCapabilities(executor, input);
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required before preparation.');
    const wire = Object.freeze(buildOpenAiChatRequest(input, env, 'single-completion/v1'));
    const growth = openAiArchiveDiagnosticGrowth(env);
    // A 4 MiB transport body can decode to <=12 MiB UTF-8 (replacement x3).
    // Each of output/refusal/stopReason <= that bound, even when refusal is copied
    // into output. JSON quoting <=6x UTF-8. error is inner-redacted then shortened
    // to 1024 UTF-16 + "...", followed by one outer capability redaction (growth).
    const stringBytes = 3n * (6n * 3n * BigInt(MAX_API_RESPONSE_BYTES) + 2n);
    const errorBytes = 6n * 1027n * growth + 2n;
    // All remaining keys, booleans, nulls, finite numeric fields and the fixed
    // failure/cleanup envelope are dominated by this explicit maximal template.
    const maximalFixed = { outcomeKind: 'result', result: { ok: false, output: null, refusal: '', error: '', stopReason: '',
      durationMs: -Number.MAX_VALUE, durationApiMs: Number.MAX_VALUE, inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheCreationTokens: Number.MAX_SAFE_INTEGER,
      tokenUsageReportedByExecutor: false, costUSD: Number.MAX_VALUE, costReportedByExecutor: false, numTurns: Number.MAX_SAFE_INTEGER,
      failure: { failureKind: 'unsupported_output', httpStatus: 599, retryAfterMs: 2_147_483_647 } }, cleanupFailure: { diagnostic: '\0'.repeat(4096) } };
    const fixedBytes = Buffer.byteLength(JSON.stringify(maximalFixed));
    const bound = stringBytes + errorBytes + BigInt(fixedBytes);
    if (bound > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Actual API diagnostic growth exceeds a safe archive bound; no invocation was started.');
    const evidence = { producerId: PRODUCER, producerRevision: revision,
      sourceChannels: [{ channel: 'HTTP response bytes', maxBytes: MAX_API_RESPONSE_BYTES }], maxOutcomeJsonBytes: Number(bound),
      proof: { proofKind: 'openai-chat-return-bound/v1', endpoint: wire.endpoint, bodyDigest: textHash(wire.body),
        utf8ReplacementFactor: 3, jsonUtf8Factor: 6, retainedRawStringChannels: ['output', 'refusal', 'stopReason'],
        innerDiagnosticCodeUnits: 1027, outerDiagnosticGrowth: growth.toString(), fixedJsonBytes: fixedBytes,
        singleCompletion: true, stream: false, redirect: 'error', dispatchGate: 'producer-before-dispatch/v1', producerRevision: revision } };
    return { evidence, wire };
  };
  return { assertCapabilities: assertExecutorInputCapabilities, inspect: (executor, input) => inspect(executor, input).evidence,
    configure(executor, input, beforeDispatch) {
    const { evidence, wire } = inspect(executor, input);
    const execute = create(executor, { env, apiDispatchPolicy: { requestConstraints: 'single-completion/v1', redirect: 'error', beforeDispatch: actual => {
      if (actual.endpoint !== wire.endpoint || actual.body !== wire.body) throw new Error('API dispatch identity conflict.');
      beforeDispatch?.();
    } } });
    return { evidence, execute };
  } };
}

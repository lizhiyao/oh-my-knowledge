import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { ExecutorArchiveProducer } from '../../contracts/archive.js';
import type { ExecutorFn, ExecutorInput } from '../../contracts/ports.js';
import { assertExecutorInputCapabilities } from '../../core/capabilities.js';
import { DEFAULT_TIMEOUT_MS, MAX_BUFFER } from '../../core/limits.js';
import { createExecutor } from '../../index.js';

type CodexArchiveExecutorFactory = (name: string, options: { env: NodeJS.ProcessEnv }) => ExecutorFn;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PRODUCER = 'codex-cli-return-archive/v1';
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_MODEL_BYTES = 4096;
const MAX_SCHEMA_DEPTH = 128;
const FIXED_JSON_BYTES = 64 * 1024;
const OUTCOME_QUOTA_BYTES = Math.min(512 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH - 1);
const CWD_PREFIX = 'omk-knowledge-text-';
// These implementations are the premises of the bound. The real-runtime fixture
// checks their frozen source identities; changing one requires re-auditing proof.
const SOURCE_DIGESTS = Object.freeze({
  'src/executors/openai/codex/cli.ts': '4d76d15d64ccca5e113824492f4715458c68cc09f6cbac94ee68a7859bd37c85',
  'src/executors/openai/codex/protocol.ts': '198f8c52bcf6b8d4ebdd9665c5e3bdb8bd70fd407a5c1d28d277831d4d224eaa',
  'src/executors/openai/codex/trace.ts': '3a522c0c743e97f40e9f00bde534d735b6c0fdf62fc346329c65b8fd152b4596',
  'src/executors/contracts/tool-identity.ts': '2933cf286744c8caa8e904616f2778e8b228cdf477c5389267da67baf3f6fdc6',
  'src/executors/core/subprocess.ts': 'd6f50765168a17437d2d4567e38b36ad94bdcdb04ed4e338f124f6dea2be87bc',
  'src/executors/core/diagnostics.ts': 'b7bb430e557395b7af16804721ec634cf79a44380075f79219c7134e1907e99c',
  'src/shared/json-safe-truncation.ts': '0b5d6fcea1c3f1e46e758b7160fcfcd886180df4ad3629785ad6ab2d1a8eaf23',
  'src/executors/core/runtime.ts': 'a6f8803d83498243eea2501d8ec0393830b78f5501cef4567e9793a57e16cf07',
});
const PROOF_VERSION = 'jsonl-disjoint-fields-and-event-templates-44x-6x-long-credentials/v1';
const revision = hash(JSON.stringify({ producer: PRODUCER, proofVersion: PROOF_VERSION, perStreamMaxBytes: MAX_BUFFER,
  sourceDigests: SOURCE_DIGESTS,
  stdoutJsonFactor: 44, stderrJsonFactor: 6, fixedJsonBytes: FIXED_JSON_BYTES, inputMaxBytes: MAX_INPUT_BYTES,
  schemaMaxBytes: MAX_SCHEMA_BYTES, schemaMaxDepth: MAX_SCHEMA_DEPTH, environmentMaxBytes: MAX_ENV_BYTES,
  pathMaxBytes: MAX_PATH_BYTES, modelMaxBytes: MAX_MODEL_BYTES, outcomeQuotaBytes: OUTCOME_QUOTA_BYTES,
  requestPolicy: 'frozen-data-request-private-cwd-and-temp-root/v1',
  dispatchGate: 'producer-before-dispatch/v1',
  resultPolicy: 'complete-returned-json-before-contract-admission/iterative-writer-required',
  protocol: 'codex-jsonl-protocol-and-trace/v1', diagnosticPolicy: 'frozen-credential-variants-and-bearer-basic/v1' }));

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Codex archive requires a NUL-free ${label}.`);
  return value;
}

/** Configuration is small plain data. Native returned evidence has no such depth gate. */
function copySchema(value: unknown): Readonly<Record<string, unknown>> {
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (count: number) => { bytes += count; if (bytes > MAX_SCHEMA_BYTES) throw new Error('Codex archive schema capacity exceeded.'); };
  const copy = (node: unknown, depth: number): unknown => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error('Codex archive schema depth exceeded.');
    if (node === null || typeof node === 'boolean' || typeof node === 'number' && Number.isFinite(node)) {
      charge(Buffer.byteLength(JSON.stringify(node))); return node;
    }
    if (typeof node === 'string') {
      if (node.length > MAX_SCHEMA_BYTES) throw new Error('Codex archive schema capacity exceeded.');
      charge(Buffer.byteLength(JSON.stringify(node))); return node;
    }
    if (!node || typeof node !== 'object' || ancestors.has(node)) throw new Error('Codex archive schema must be acyclic JSON data.');
    const array = Array.isArray(node), prototype: unknown = Object.getPrototypeOf(node);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error('Codex archive schema must be plain JSON data.');
    const descriptors = Object.getOwnPropertyDescriptors(node);
    if (Reflect.ownKeys(node).some(key => typeof key !== 'string') || Object.hasOwn(descriptors, 'toJSON')) throw new Error('Codex archive schema cannot have serialization hooks.');
    ancestors.add(node); charge(2);
    try {
      if (array) {
        const result: unknown[] = [];
        const length = node.length;
        if (Object.keys(descriptors).length !== length + 1) throw new Error('Codex archive schema arrays must be dense JSON data.');
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Codex archive schema cannot have accessors.');
          if (index) charge(1);
          result.push(copy(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let index = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Codex archive schema cannot have accessors or hidden properties.');
        if (key.length > MAX_SCHEMA_BYTES) throw new Error('Codex archive schema capacity exceeded.');
        charge(Buffer.byteLength(JSON.stringify(key)) + 1 + (index++ ? 1 : 0));
        result[key] = copy(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally { ancestors.delete(node); }
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex archive schema must be a JSON object.');
  return copy(value, 0) as Readonly<Record<string, unknown>>;
}

function snapshotInput(input: ExecutorInput): ExecutorInput {
  // These options would introduce additional discovery/configuration or runtime policy.
  for (const option of ['skillDir', 'allowedSkills', 'mocks', 'mocksBaseDir', 'mocksStrict', 'lean', 'verbose'] as const) {
    if (input[option] !== undefined) throw new Error(`Codex archive does not support ${option}.`);
  }
  const model = text(input.model, 'model'), prompt = text(input.prompt, 'prompt');
  const system = input.system === undefined || input.system === null ? input.system : text(input.system, 'system');
  if (!model.trim() || Buffer.byteLength(model) > MAX_MODEL_BYTES) throw new Error('Codex archive requires a bounded explicit model.');
  if (Buffer.byteLength(prompt) + Buffer.byteLength(system ?? '') > MAX_INPUT_BYTES) throw new Error('Codex archive input capacity exceeded.');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Codex archive requires a bounded positive timeout.');
  if (input.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)) throw new Error('Unsupported Codex archive effort.');
  const outputFormat = input.outputFormat?.mode === 'json-schema'
    ? Object.freeze({ mode: 'json-schema' as const, name: input.outputFormat.name, schema: copySchema(input.outputFormat.schema) })
    : input.outputFormat === undefined ? undefined : Object.freeze({ mode: input.outputFormat.mode });
  return Object.freeze({ model, prompt, ...(system !== undefined ? { system } : {}), timeoutMs,
    ...(input.effort === undefined ? {} : { effort: input.effort }), ...(outputFormat ? { outputFormat } : {}) });
}

function environmentBytes(environment: NodeJS.ProcessEnv): number {
  let rawBytes = 0;
  for (const [key, value] of Object.entries(environment)) {
    text(key, 'environment key');
    if (value === undefined) continue;
    text(value, 'environment value'); rawBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (rawBytes > MAX_ENV_BYTES) throw new Error('Codex archive environment capacity exceeded.');
    // Same credential variants as core/diagnostics.ts. Replacing >=10 UTF-16 units
    // with the ten ASCII units of [REDACTED] cannot increase the unit budget.
    if (/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SECRET_ACCESS_KEY)$/i.test(key) && value) {
      const variants = [value, value.trim(), JSON.stringify(value).slice(1, -1)].filter(Boolean);
      if (variants.some(variant => variant.length < 10)) throw new Error('Codex archive cannot prove diagnostic growth for short credential variants.');
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(environment));
  if (bytes > MAX_ENV_BYTES) throw new Error('Codex archive environment capacity exceeded.');
  return bytes;
}

/** Complete returned JSON only: neither raw JSONL nor provider requests are attested. */
export function createCodexArchiveProducer(environment: NodeJS.ProcessEnv, create: CodexArchiveExecutorFactory = createExecutor): ExecutorArchiveProducer {
  const env = Object.freeze({ ...environment });
  const tempRoot = resolve(tmpdir());
  const assertCapabilities = (executor: string, input: ExecutorInput) => {
    if (executor !== 'codex') throw new Error('Codex archive producer requires codex.');
    assertExecutorInputCapabilities(executor, input);
  };
  const inspect = (executor: string, input: ExecutorInput) => {
    assertCapabilities(executor, input);
    if (input.cwd != null || input.abortSignal !== undefined) throw new Error('Codex archive preparation cannot contain a runtime cwd or signal.');
    text(tempRoot, 'temporary root');
    if (Buffer.byteLength(tempRoot) + 128 > MAX_PATH_BYTES) throw new Error('Codex archive temporary root capacity exceeded.');
    const snapshot = snapshotInput(input), requestJson = JSON.stringify(snapshot);
    const localContextBytes = Buffer.byteLength(requestJson) + environmentBytes(env) + 3 * MAX_PATH_BYTES;
    // B is the actual per-stream byte cap, not an output-token/call/spending cap.
    // Partition stdout into disjoint field JSON spans and event skeletons:
    // * at most eight copies of a namespace segment + one schema diagnostic;
    //   invalid UTF-8 replacement is <=3x; allowing diagnostic redaction gives <=30x;
    // * arbitrary JSON re-encoding (including number spelling) <=6x; direct tool
    //   input is copied twice, tool-output JSON is quoted again and copied twice,
    //   giving <=12x/24x. Non-string coercion and file_change defaults fit <=24x;
    // * each tool's two fixed templates + its turn fit 700 bytes, against >=42
    //   source skeleton bytes. Text-only turns and pending-ID separators are lower.
    // 44x dominates these disjoint charges, including joins/array punctuation.
    // stderr: replacement decode has <=S UTF-16 units. Long credential replacement
    // does not grow that count. Bearer/Basic has >=5 ASCII prefix letters, leaving
    // enough of its 6x JSON unit allowance for the ten-byte replacement. Thus 6S,
    // NOT a multiply-by-ten redactor estimate. Local fs/spawn diagnostics can quote
    // the bounded invocation context; arbitrary thrown JS uses a bounded exception
    // observation at the workflow. 64KiB also covers global keys/numerics/cleanup.
    // An iterative JSON writer is required; this is not a JSON.stringify depth proof.
    const bound = 44 * MAX_BUFFER + 6 * MAX_BUFFER + 6 * localContextBytes + FIXED_JSON_BYTES;
    if (!Number.isSafeInteger(bound) || bound > OUTCOME_QUOTA_BYTES) throw new Error('Codex archive proof exceeds its 512 MiB outcome quota; no invocation was started.');
    const evidence = { producerId: PRODUCER, producerRevision: revision,
      sourceChannels: [{ channel: 'Codex retained stdout bytes', maxBytes: MAX_BUFFER },
        { channel: 'Codex retained stderr bytes', maxBytes: MAX_BUFFER },
        { channel: 'Bounded local invocation configuration bytes', maxBytes: localContextBytes }],
      maxOutcomeJsonBytes: bound,
      proof: { proofKind: 'codex-cli-complete-return-bound/v1', proofVersion: PROOF_VERSION, producerRevision: revision,
        requestDigest: hash(requestJson), environmentDigest: hash(JSON.stringify(env)),
        stdoutJsonFactor: 44, stderrJsonFactor: 6, localDiagnosticJsonFactor: 6, localContextBytes, fixedJsonBytes: FIXED_JSON_BYTES,
        minimumCredentialVariantCodeUnits: 10, schemaMaxDepth: MAX_SCHEMA_DEPTH,
        sourceDigests: SOURCE_DIGESTS, nodeVersion: process.version,
        temporaryRootDigest: hash(tempRoot), privateCwdPrefix: CWD_PREFIX, privateCwdMaxBytes: MAX_PATH_BYTES,
        traceCopies: 2, namespaceContentCopies: 8, nativeAdmission: 'after-archive', dispatchGate: 'producer-before-dispatch/v1',
        scope: 'Complete returned JSON; protocol streams, binary configuration, provider calls and token/cost bounds are not attested.' } };
    return { evidence, snapshot, requestJson };
  };
  return { assertCapabilities, inspect: (executor, input) => inspect(executor, input).evidence,
    configure(executor, input, beforeDispatch) {
      const { evidence, snapshot, requestJson } = inspect(executor, input);
      const execute = create(executor, { env });
      return { evidence, execute: async actual => {
        actual.abortSignal?.throwIfAborted();
        if (resolve(tmpdir()) !== tempRoot) throw new Error('Codex archive temporary root changed before dispatch.');
        assertCapabilities(executor, actual);
        if (JSON.stringify(snapshotInput(actual)) !== requestJson) throw new Error('Codex archive dispatch identity conflict.');
        const cwd = text(actual.cwd, 'private cwd'), normalized = resolve(cwd);
        if (cwd !== normalized || dirname(normalized) !== tempRoot || !new RegExp(`^${CWD_PREFIX}[A-Za-z0-9]{6}$`).test(basename(normalized))
          || Buffer.byteLength(normalized) > MAX_PATH_BYTES) throw new Error('Codex archive requires a private cwd under the frozen temporary root.');
        // No await between local gates and the actual adapter. Only the verified
        // runtime cwd/signal are added; schema/request/env snapshots cannot drift.
        beforeDispatch?.();
        return execute({ ...snapshot, cwd: normalized, abortSignal: actual.abortSignal });
      } };
    } };
}

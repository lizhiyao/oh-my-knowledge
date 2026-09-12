import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  IdentifierSchema,
  JsonValueSchema,
  digestCanonicalJson,
  type JsonValue,
  type UsageRecord,
} from '../../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../../eval-core/execution/index.js';
import {
  SourceNeutralTraceWithoutMocksSchema,
} from '../../../../eval-runtime/traces/source-neutral.js';
import type {
  Artifact,
  Executor,
  ExecutorCapabilities,
  ExecutorInvocation,
  ExecutorResult,
} from '../../../../eval-runtime/evaluation/contracts.js';
import {
  spawnWithSigintPropagation,
  type SpawnHelperError,
} from '../../../../executors/core/subprocess.js';
import { mergeOutputClassification } from '../shared/classified-environment.js';
import { captureCodexEnvironment, type CodexEnvironmentEntry } from './environment.js';
import {
  assertCodexIdentityFilesUnchanged,
  captureCodexIdentityFiles,
  type CodexContentIdentityFile,
  type CapturedCodexIdentityFile,
} from './content-identity.js';
import {
  buildCodexCliCoreArguments,
  DEFAULT_CODEX_CLI_MAX_OUTPUT_BYTES,
  DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES,
} from './cli.js';
import {
  parseCodexCliStream,
  requiresCodexUpgrade,
  type ParsedCodexCliStream,
} from './cli-protocol.js';
import {
  CODEX_CLI_RESOURCE_PROFILE,
  codexPromptEnvelopeText,
  type CodexKnowledgeArtifact,
} from './resources.js';
import { probeCodexCliVersion } from './version.js';

/** Revision of this published reference implementation, independent from the vendor version. */
export const CODEX_CLI_REFERENCE_ADAPTER_VERSION = '1.0.0' as const;

/**
 * Lowest vendor CLI version whose `codex exec --json` event shape is frozen by this repository's
 * fixtures. It is a protocol-shape floor, not a claim of compatibility with every later release.
 */
export const CODEX_CLI_MIN_SUPPORTED_VERSION = '0.146.0' as const;

export const DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS = 5_000;

const INPUT_PROJECTION_VERSION = 'omk.codex-cli-prompt/v1';
const SOURCE_PROTOCOL = 'codex exec --json';
const TRACE_MEDIA_TYPE = 'application/vnd.omk.source-neutral-trace+json';

/** A released `major.minor.patch` only: pre-release and custom builds fail closed. */
const ReleaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);

export interface CreateCodexCliReferenceExecutorInput {
  /** Measurement identity for this Executor; the host owns its naming scheme. */
  readonly executorId: string;
  /** Absolute Codex executable. PATH lookup is intentionally unsupported. */
  readonly executablePath: string;
  /** Pinned at assembly time so every variant in one Run measures the same model. */
  readonly model: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Defaults to `read-only`; `workspace-write` still stays inside the attempt-private directory. */
  readonly sandbox?: 'read-only' | 'workspace-write';
  /** Complete classified environment. Nothing is inherited from process.env. */
  readonly environment?: Readonly<Record<string, CodexEnvironmentEntry>>;
  /** Implementation files not reachable from `executablePath` evidence, such as a bundled binary. */
  readonly contentIdentityFiles?: readonly CodexContentIdentityFile[];
  readonly maxOutputBytes?: number;
  readonly maxPromptBytes?: number;
  readonly identityProbeTimeoutMs?: number;
  /** Additional measurement-relevant host declarations; the `codexCli` facet is reserved. */
  readonly fingerprintFacets?: Readonly<Record<string, JsonValue>>;
}

interface CapturedReferenceConfiguration {
  readonly executablePath: string;
  readonly model: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly sandbox: 'read-only' | 'workspace-write';
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: readonly JsonValue[];
  readonly outputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxOutputBytes: number;
  readonly maxPromptBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`Codex CLI reference Executor ${name} must be a positive safe integer.`);
  }
  return resolved;
}

function captureConfiguration(
  input: Readonly<CreateCodexCliReferenceExecutorInput>,
): CapturedReferenceConfiguration {
  if (!isAbsolute(input.executablePath) || input.executablePath.includes('\0')) {
    throw new TypeError('Codex CLI reference Executor requires an absolute executablePath.');
  }
  if (typeof input.model !== 'string' || input.model.trim() === '') {
    throw new TypeError('Codex CLI reference Executor requires a non-empty model.');
  }
  if (input.sandbox !== undefined
      && input.sandbox !== 'read-only' && input.sandbox !== 'workspace-write') {
    throw new TypeError('Codex CLI reference Executor sandbox must be read-only or workspace-write.');
  }
  const environment = captureCodexEnvironment(input.environment);
  const effort = input.effort;
  return Object.freeze({
    executablePath: input.executablePath,
    model: input.model,
    ...(effort === undefined ? {} : { effort }),
    sandbox: input.sandbox ?? 'read-only',
    environment: environment.values,
    environmentIdentity: environment.identity,
    outputClassification: mergeOutputClassification(environment.outputClassification, 'sensitive'),
    maxOutputBytes: positiveInteger(
      input.maxOutputBytes,
      DEFAULT_CODEX_CLI_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    ),
    maxPromptBytes: positiveInteger(
      input.maxPromptBytes,
      DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES,
      'maxPromptBytes',
    ),
  });
}

function belowVersionFloor(observed: string, floor: string): boolean {
  const left = observed.split('.').map((part) => Number.parseInt(part, 10));
  const right = floor.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

function fail(
  code: string,
  stage: 'infrastructure' | 'execution',
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({ code, stage, message }, usage);
}

/**
 * The knowledge carrier reaches Codex through the prompt envelope only, exactly as the sealed host
 * seam projects it. A carrier this seam cannot materialize fails closed instead of silently
 * running the model without instructions.
 */
function projectArtifact(
  artifact: Readonly<Artifact>,
): Readonly<{ knowledge?: CodexKnowledgeArtifact; errorCode?: string }> {
  if (artifact.content === null) {
    // A baseline declares no carrier; every other source resolves to concrete content upstream.
    return artifact.kind === 'baseline' ? {} : { errorCode: 'OMK_CODEX_CLI_ARTIFACT_UNSUPPORTED' };
  }
  if (artifact.content.trim() === '') {
    return { errorCode: 'OMK_CODEX_CLI_ARTIFACT_UNSUPPORTED' };
  }
  return { knowledge: { artifactKind: 'file', instructions: artifact.content } };
}

function referenceFingerprintFacets(
  configuration: CapturedReferenceConfiguration,
  identity: Readonly<{
    files: readonly CapturedCodexIdentityFile[];
    identityProbeTimeoutMs: number;
  }>,
  declared: Readonly<Record<string, JsonValue>>,
): JsonValue {
  return {
    ...declared,
    codexCli: {
      adapter: {
        adapterVersion: CODEX_CLI_REFERENCE_ADAPTER_VERSION,
        seam: 'eval-runtime-facade',
        sourceProtocol: SOURCE_PROTOCOL,
        cancellation: 'sigterm-then-sigkill',
        processIsolation: 'per-attempt',
      },
      'version-floor': {
        minSupportedVersion: CODEX_CLI_MIN_SUPPORTED_VERSION,
        probeTimeoutMs: identity.identityProbeTimeoutMs,
      },
      runtime: {
        model: configuration.model,
        effort: configuration.effort ?? null,
        sandbox: configuration.sandbox,
      },
      launcher: { executablePathDigest: digestCanonicalJson(configuration.executablePath) },
      binary: {
        coverage: 'declared-files-reverified-before-spawn',
        files: identity.files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
      },
      environment: { entries: [...configuration.environmentIdentity] },
      limits: {
        maxOutputBytes: configuration.maxOutputBytes,
        maxPromptBytes: configuration.maxPromptBytes,
      },
      'fixed-controls': {
        approvalPolicy: 'never',
        configMode: 'strict-ignore-user-config',
        rules: 'ignored',
        session: 'ephemeral',
        shellEnvironmentInheritance: 'none',
        workspaceRoot: 'attempt-private-temp-directory',
      },
      'input-projection': {
        version: INPUT_PROJECTION_VERSION,
        promptSchemaVersion: CODEX_CLI_RESOURCE_PROFILE.promptSchemaVersion,
        artifact: 'content-string-only',
        envelope: 'canonical-json',
        executionContext: 'executionContext-field',
        task: 'sample-input-verbatim',
      },
    },
  };
}

function safeUsageOfOutput(stdout: string | undefined): UsageRecord | undefined {
  if (stdout === undefined || stdout.trim() === '') return undefined;
  try {
    return parseCodexCliStream(stdout).usage;
  } catch {
    // The process failure stays authoritative; malformed provider detail remains redacted.
    return undefined;
  }
}

async function runAttempt(
  configuration: CapturedReferenceConfiguration,
  files: readonly CapturedCodexIdentityFile[],
  prompt: string,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<ParsedCodexCliStream> {
  await assertCodexIdentityFilesUnchanged(files, {
    adapterLabel: 'Codex CLI',
    cancellationCode: 'OMK_CODEX_CLI_CANCELLED',
    identityChangedCode: 'OMK_CODEX_CLI_IDENTITY_CHANGED',
    signal,
  });
  const internalAbort = new AbortController();
  const { child, done } = spawnWithSigintPropagation(
    configuration.executablePath,
    buildCodexCliCoreArguments({
      model: configuration.model,
      ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
      sandbox: configuration.sandbox,
      workingDirectory,
      prompt,
    }),
    {
      cwd: workingDirectory,
      env: { ...configuration.environment },
      maxBuffer: configuration.maxOutputBytes,
      abortSignal: AbortSignal.any([signal, internalAbort.signal]),
    },
  );
  let stdinFailed = child.stdin === null;
  if (child.stdin === null) internalAbort.abort();
  else {
    child.stdin.once('error', () => {
      stdinFailed = true;
      internalAbort.abort();
    });
    child.stdin.end();
  }
  let stdout: string;
  try {
    stdout = (await done).stdout;
  } catch (error) {
    const spawnError = error as SpawnHelperError;
    if (signal.aborted || spawnError.failureKind === 'abort') {
      fail('OMK_CODEX_CLI_CANCELLED', 'execution', 'Codex CLI execution was cancelled.');
    }
    if (spawnError.failureKind === 'buffer-limit') {
      fail(
        'OMK_CODEX_CLI_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'Codex CLI output exceeded the adapter byte limit.',
      );
    }
    if (spawnError.failureKind === 'nonzero-exit') {
      const upgradeRequired = requiresCodexUpgrade(spawnError.stdout ?? '');
      fail(
        upgradeRequired
          ? 'OMK_CODEX_CLI_UPGRADE_REQUIRED'
          : 'OMK_CODEX_CLI_EXIT_NONZERO',
        'execution',
        upgradeRequired
          ? 'Codex CLI must be upgraded for this model.'
          : 'Codex CLI exited unsuccessfully.',
        safeUsageOfOutput(spawnError.stdout),
      );
    }
    if (stdinFailed) {
      fail(
        'OMK_CODEX_CLI_STDIN_UNAVAILABLE',
        'infrastructure',
        'Codex CLI stdin is unavailable.',
      );
    }
    fail(
      'OMK_CODEX_CLI_SPAWN_FAILED',
      'infrastructure',
      'Codex CLI process could not run.',
    );
  }
  const parsed = parseCodexCliStream(stdout);
  if (parsed.terminalStatus === 'failed' && requiresCodexUpgrade(stdout)) {
    fail(
      'OMK_CODEX_CLI_UPGRADE_REQUIRED',
      'execution',
      'Codex CLI must be upgraded for this model.',
      parsed.usage,
    );
  }
  return parsed;
}

/**
 * Published reference Executor for the Codex CLI: configuration in, a canonical façade `Executor`
 * out. It reuses the shipped argument builder, JSONL protocol parser, classified environment and
 * content identity controls, and carries none of the sealed host-seam machinery, so capabilities
 * that need plan-bound resource leases fail closed instead of degrading to weaker isolation.
 *
 * Unsupported at this seam, each with a stable `OMK_CODEX_CLI_*` error code: trial workspace
 * overlays, native MCP configuration, pre-tool-call mock interception, per-trial tool allow-lists,
 * runtime context projection, and artifact carriers that are not a non-empty string
 * (`content === null`, such as a directory Skill). Retry, timeout and budget policy stay with the
 * Runtime through `invocation.signal`; vendor-side account and network isolation remain the host's
 * responsibility. Verify the supported surface with `checkExecutor` from
 * `oh-my-knowledge/eval-runtime`.
 */
export async function createCodexCliReferenceExecutor(
  input: Readonly<CreateCodexCliReferenceExecutorInput>,
): Promise<Executor<JsonValue, undefined, string, JsonValue>> {
  const executorId = IdentifierSchema.safeParse(input.executorId);
  if (!executorId.success) {
    throw new TypeError('Codex CLI reference Executor requires a valid executorId.');
  }
  const declaredFacets = input.fingerprintFacets;
  if (declaredFacets !== undefined
      && (typeof declaredFacets !== 'object' || declaredFacets === null
        || Array.isArray(declaredFacets))) {
    throw new TypeError('Codex CLI reference Executor fingerprintFacets must be a JSON object.');
  }
  if (declaredFacets !== undefined && Object.hasOwn(declaredFacets, 'codexCli')) {
    throw new TypeError('Codex CLI reference Executor reserves the codexCli fingerprint facet.');
  }
  const configuration = captureConfiguration(input);
  const identityProbeTimeoutMs = positiveInteger(
    input.identityProbeTimeoutMs,
    DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS,
    'identityProbeTimeoutMs',
  );
  const files = await captureCodexIdentityFiles([
    { facetId: 'codex-executable', path: configuration.executablePath },
    ...(input.contentIdentityFiles ?? []),
  ], 'Codex CLI');
  const observedVersion = await probeCodexCliVersion({
    executablePath: configuration.executablePath,
    environment: configuration.environment,
    maxOutputBytes: configuration.maxOutputBytes,
    timeoutMs: identityProbeTimeoutMs,
  });
  if (!ReleaseVersionSchema.safeParse(observedVersion).success) {
    // The probed token is unvalidated vendor stdout: reject it without quoting it back.
    throw new TypeError(
      'Codex CLI version probe reported an unsupported version format; expected major.minor.patch.',
    );
  }
  await assertCodexIdentityFilesUnchanged(files, {
    adapterLabel: 'Codex CLI',
    cancellationCode: 'OMK_CODEX_CLI_CANCELLED',
    identityChangedCode: 'OMK_CODEX_CLI_IDENTITY_CHANGED',
  });
  if (belowVersionFloor(observedVersion, CODEX_CLI_MIN_SUPPORTED_VERSION)) {
    throw new TypeError(
      `Codex CLI ${observedVersion} is below the supported floor `
      + `${CODEX_CLI_MIN_SUPPORTED_VERSION}; upgrade the vendor CLI or select another Executor.`,
    );
  }
  const capabilities: ExecutorCapabilities = Object.freeze({
    determinism: 'stochastic' as const,
    cancellation: 'best-effort' as const,
    concurrency: Object.freeze({ safety: 'parallel-safe' as const }),
    seedControl: 'unsupported' as const,
    telemetry: Object.freeze({
      trace: 'optional' as const,
      usage: 'optional' as const,
      providerCost: Object.freeze({ reporting: 'unsupported' as const }),
    }),
  });
  const fingerprintFacets = referenceFingerprintFacets(
    configuration,
    { files, identityProbeTimeoutMs },
    declaredFacets === undefined ? {} : structuredClone(declaredFacets),
  );

  return Object.freeze({
    executorId: executorId.data,
    version: observedVersion,
    schemas: Object.freeze({
      input: Object.freeze({ parse: (value: unknown) => JsonValueSchema.parse(value) }),
      output: Object.freeze({ parse: (value: unknown) => z.string().parse(value) as string }),
      trace: Object.freeze({
        parse: (value: unknown) => SourceNeutralTraceWithoutMocksSchema.parse(value) as JsonValue,
      }),
    }),
    outputClassification: configuration.outputClassification,
    traceClassification: configuration.outputClassification,
    outputMediaType: 'text/plain',
    traceMediaType: TRACE_MEDIA_TYPE,
    capabilities,
    fingerprintFacets,
    async execute(
      invocation: Readonly<ExecutorInvocation<JsonValue, undefined>>,
    ): Promise<ExecutorResult<string, JsonValue>> {
      const { signal } = invocation;
      if (signal.aborted) throw signal.reason;
      if (invocation.workspace !== undefined || invocation.mcpConfig !== undefined
          || invocation.mockInterception !== undefined) {
        return { errorCode: 'OMK_CODEX_CLI_ISOLATION_UNSUPPORTED' };
      }
      if (invocation.allowedTools !== undefined) {
        return { errorCode: 'OMK_CODEX_CLI_TOOL_POLICY_UNSUPPORTED' };
      }
      if (invocation.runtimeContext !== undefined) {
        return { errorCode: 'OMK_CODEX_CLI_RUNTIME_CONTEXT_UNSUPPORTED' };
      }
      const projection = projectArtifact(invocation.artifact);
      if (projection.errorCode !== undefined) {
        return { errorCode: projection.errorCode };
      }
      let workingDirectory: string;
      try {
        workingDirectory = await mkdtemp(join(tmpdir(), 'omk-codex-reference-'));
      } catch {
        return { errorCode: 'OMK_CODEX_CLI_WORKING_DIRECTORY_UNAVAILABLE' };
      }
      try {
        const parsed = await runAttempt(
          configuration,
          files,
          codexPromptEnvelopeText(
            CODEX_CLI_RESOURCE_PROFILE,
            {
              ...(projection.knowledge === undefined
                ? {}
                : { knowledgeArtifact: projection.knowledge }),
              ...(invocation.executionContext === undefined
                ? {}
                : { executionContext: invocation.executionContext }),
              task: invocation.input,
            },
            configuration.maxPromptBytes,
          ),
          workingDirectory,
          signal,
        );
        if (parsed.terminalStatus === 'failed') {
          return {
            errorCode: 'OMK_CODEX_CLI_TURN_FAILED',
            ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
          };
        }
        return {
          output: parsed.output as string,
          ...(parsed.trace === undefined ? {} : { trace: parsed.trace }),
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof ExecutionPortFailure) {
          return {
            errorCode: error.evaluationError.code,
            ...(error.usage === undefined ? {} : { usage: error.usage }),
          };
        }
        return { errorCode: 'OMK_CODEX_CLI_SPAWN_FAILED' };
      } finally {
        await rm(workingDirectory, { recursive: true, force: true });
      }
    },
  });
}

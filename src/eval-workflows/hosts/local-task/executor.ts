import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import { type JsonValue } from '../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../eval-core/execution/index.js';
import type { Executor } from '../../../eval-runtime/evaluation/contracts.js';
import type { WorkspaceProvider } from '../../../eval-runtime/workspace.js';
import { spawnWithSigintPropagation, type SpawnHelperError } from '../../../executors/core/subprocess.js';
import { buildCodexExecArguments } from '../../../executors/openai/codex/cli-arguments.js';
import { parseCodexCliStream } from '../adapters/codex/cli-protocol.js';
import { LocalTaskOutputSchema, type LocalTaskDefinition, type LocalTaskOutput, type TaskFile } from '../../inputs/contracts/local-task.js';
import type { TaskAttemptDiagnostic } from './diagnostics.js';
import { collectTaskArtifacts, taskTreeDigest } from './files.js';
import { assertIdentityFilesUnchanged, type CapturedIdentityFile } from '../adapters/shared/content-identity.js';

export function createTaskExecutor(input: {
  definition: LocalTaskDefinition;
  snapshot: readonly TaskFile[];
  provider: WorkspaceProvider;
  temporaryRoot: string;
  executable: string;
  executableDigest: string;
  version: string;
  identityFiles: readonly CapturedIdentityFile[];
  fixtureSource?: string;
  authenticationFile?: string;
  captureDiagnostic: (diagnostic: TaskAttemptDiagnostic) => Promise<void>;
}): Executor<JsonValue, undefined, LocalTaskOutput> {
  const { definition } = input;
  const snapshotDigest = taskTreeDigest(input.snapshot);
  return {
    executorId: 'omk.local-task-executor/v1', version: '1.1.0',
    schemas: { input: z.json(), output: LocalTaskOutputSchema, trace: z.json() },
    outputClassification: 'sensitive', traceClassification: 'sensitive',
    outputMediaType: 'application/vnd.omk.local-task-output+json',
    workspaceProvider: input.provider,
    capabilities: {
      determinism: definition.execution.runtimeKind === 'fixture' ? 'deterministic' : 'stochastic',
      cancellation: 'best-effort', concurrency: { safety: 'serialized', maxInFlight: 1 },
      seedControl: 'unsupported', telemetry: { trace: 'optional', usage: 'optional', providerCost: { reporting: 'unsupported' } },
    },
    fingerprintFacets: {
      diagnosticsPolicy: 'attempt-snapshot/v1', maxStreamBytes: 10 * 1024 * 1024,
      outputSchema: 'omk.local-task-output/v1', runtimeKind: definition.execution.runtimeKind,
      implementationDigest: input.executableDigest, runtimeVersion: input.version,
      dependencies: input.identityFiles.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      model: definition.execution.runtimeKind === 'codex' ? definition.execution.model : 'offline-fixture',
      effort: definition.execution.runtimeKind === 'codex' ? definition.execution.effort : 'none',
      timeoutMs: definition.execution.timeoutMs, artifacts: definition.artifacts,
      knowledgeMode: 'provided-content', sandbox: 'trusted-local-workspace-write',
      environment: { LANG: 'C', TZ: 'UTC', inheritance: 'none', home: 'attempt-private' },
    },
    async execute(invocation) {
      if (invocation.workspace === undefined) return { errorCode: 'TASK_WORKSPACE_MISSING' };
      invocation.signal.throwIfAborted();
      const privateRoot = await mkdtemp(join(input.temporaryRoot, 'executor-'));
      let stdout = '';
      let stderr = '';
      let processOutcome: TaskAttemptDiagnostic['processOutcome'] = null;
      let status = 'TASK_EXECUTION_FAILED';
      let captured: LocalTaskOutput | undefined;
      const collect = async (response: string): Promise<LocalTaskOutput> => ({
        schemaVersion: 'omk.local-task-output/v1', response, snapshotDigest,
        ...await collectTaskArtifacts({ root: invocation.workspace!.root, paths: definition.artifacts.files,
          maxBytes: definition.artifacts.maxBytes, snapshot: input.snapshot }),
        source: { sampleId: invocation.sampleId, variantId: invocation.variantId,
          trialIndex: invocation.trialIndex, attemptNumber: invocation.attemptNumber },
      });
      try {
        await assertIdentityFilesUnchanged(input.identityFiles, { adapterLabel: 'Local task',
          cancellationCode: 'TASK_CANCELLED', identityChangedCode: 'TASK_EXECUTOR_CHANGED', signal: invocation.signal });
        const env: NodeJS.ProcessEnv = { HOME: privateRoot, LANG: 'C', TZ: 'UTC', TMPDIR: privateRoot, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
        const execution = definition.execution;
        let args: string[];
        let command: string;
        let stdin = '';
        if (execution.runtimeKind === 'fixture') {
          const script = join(privateRoot, 'fixture.mjs');
          await writeFile(script, input.fixtureSource!, { mode: 0o600 });
          command = process.execPath;
          args = [script];
          stdin = JSON.stringify({ input: invocation.input, knowledge: invocation.artifact.content });
        } else {
          const codexHome = join(privateRoot, 'codex');
          await mkdir(codexHome, { mode: 0o700 });
          if (input.authenticationFile !== undefined) {
            await copyFile(input.authenticationFile, join(codexHome, 'auth.json'));
            await chmod(join(codexHome, 'auth.json'), 0o600);
          }
          env.CODEX_HOME = codexHome;
          command = input.executable;
          args = buildCodexExecArguments({
            model: execution.model, effort: execution.effort, workingDirectory: invocation.workspace.root,
            prompt: `${invocation.artifact.content ?? ''}\n\n${String((invocation.input as { text: string }).text)}`,
            sandbox: 'workspace-write', strictConfig: true, color: 'never', shellEnvironmentInheritance: 'none',
          });
        }
        const { child, done } = spawnWithSigintPropagation(command, args, {
          cwd: invocation.workspace.root, env, abortSignal: invocation.signal,
          timeoutMs: execution.timeoutMs, maxBuffer: 10 * 1024 * 1024,
        });
        child.stdin?.on('error', () => { /* done owns subprocess errors */ });
        child.stdin?.end(stdin);
        const completed = await done;
        stdout = completed.stdout;
        stderr = completed.stderr;
        processOutcome = { exitCode: completed.code, signal: completed.signal, failureKind: null };
        const parsed = execution.runtimeKind === 'codex' ? parseCodexCliStream(completed.stdout) : undefined;
        if (parsed?.terminalStatus === 'failed') return { errorCode: 'TASK_EXECUTION_FAILED', ...(parsed.usage ? { usage: parsed.usage } : {}) };
        const output = await collect(parsed?.output ?? completed.stdout);
        captured = output;
        status = 'completed';
        return { output, ...(parsed?.trace === undefined ? {} : { trace: parsed.trace }),
          ...(parsed?.usage === undefined ? {} : { usage: parsed.usage }) };
      } catch (error) {
        const failure = error as SpawnHelperError;
        stdout = failure.stdout ?? stdout;
        stderr = failure.stderr ?? stderr;
        if (failure.failureKind) processOutcome = { exitCode: failure.code ?? null, signal: failure.signal ?? null, failureKind: failure.failureKind };
        status = failure.killedByTimeout || invocation.signal.reason === 'timeout' ? 'TASK_EXECUTION_TIMEOUT'
          : invocation.signal.aborted ? 'TASK_CANCELLED'
            : error instanceof ExecutionPortFailure ? error.evaluationError.code : 'TASK_EXECUTION_FAILED';
        if (invocation.signal.aborted) throw invocation.signal.reason;
        if (error instanceof ExecutionPortFailure) throw error;
        return { errorCode: status };
      } finally {
        try {
          if (invocation.signal.aborted) status = invocation.signal.reason === 'timeout' ? 'TASK_EXECUTION_TIMEOUT' : 'TASK_CANCELLED';
          await input.captureDiagnostic({ stage: 'execution', status, output: captured ?? await collect(''), stdout, stderr, processOutcome });
        } catch {
          throw new ExecutionPortFailure({ code: 'TASK_DIAGNOSTIC_WRITE_FAILED', stage: 'infrastructure',
            message: 'Local task diagnostic evidence could not be persisted.' });
        } finally {
          // Diagnostic persistence must not prevent private credential cleanup.
          await rm(privateRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

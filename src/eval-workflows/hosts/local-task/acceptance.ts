import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type JsonValue } from '../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../eval-core/execution/index.js';
import type { CustomEvaluator, CustomEvaluatorResult } from '../../../eval-runtime/custom-evaluator.js';
import { spawnWithSigintPropagation, type SpawnHelperError } from '../../../executors/core/subprocess.js';
import { LocalTaskAcceptanceSchema, LocalTaskOutputSchema, type LocalTaskDefinition, type TaskFile } from '../../inputs/contracts/local-task.js';
import type { TaskAttemptDiagnostic } from './diagnostics.js';
import { materializeTaskFiles, taskTreeDigest } from './files.js';
import { assertIdentityFilesUnchanged, type CapturedIdentityFile } from '../adapters/shared/content-identity.js';

export const TASK_METRIC_ID = 'task-accepted';

export function createTaskAcceptance(input: {
  definition: LocalTaskDefinition['acceptance'];
  files: readonly TaskFile[];
  requiredArtifacts: readonly string[];
  temporaryRoot: string;
  runtimeFiles: readonly CapturedIdentityFile[];
  captureDiagnostic: (diagnostic: TaskAttemptDiagnostic) => Promise<void>;
}): CustomEvaluator {
  const acceptanceDigest = taskTreeDigest(input.files);
  const evidence = (value: JsonValue) => ({ value, classification: 'sensitive' as const });
  const missing = (reasonCode: string): CustomEvaluatorResult => ({
    resultKind: 'completed', results: [{ metricId: TASK_METRIC_ID, resultKind: 'missing', reasonCode,
      evidence: evidence({ acceptanceDigest, status: reasonCode }) }],
  });
  return {
    evaluatorKind: 'custom', evaluatorId: 'local-task-acceptance', instrumentId: 'local-task-acceptance-v1',
    metrics: [{ metricId: TASK_METRIC_ID, valueType: 'boolean', direction: 'higher-is-better', missingPolicyId: 'exclude/v1' }],
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    implementation: {
      implementationId: 'omk.local-task-acceptance/v1', version: '1.1.0',
      schemas: {
        bindings: z.strictObject({ actual: LocalTaskOutputSchema }),
        values: { [TASK_METRIC_ID]: z.boolean() },
        fingerprintFacets: { output: 'omk.local-task-output/v1', acceptance: 'omk.local-task-acceptance/v1' },
      },
      fingerprintFacets: { acceptanceDigest, nodeVersion: process.version, entrypoint: input.definition.entrypoint,
        runtimeFiles: input.runtimeFiles.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
        platform: process.platform, architecture: process.arch,
        environment: { LANG: 'C', TZ: 'UTC', inheritance: 'none', home: 'acceptance-private' },
        timeoutMs: input.definition.timeoutMs, requiredArtifacts: [...input.requiredArtifacts].sort() },
      async evaluate({ bindings, signal }) {
        const actual = LocalTaskOutputSchema.parse(bindings.actual);
        if (actual.collectionErrors.length > 0 || actual.missing.length > 0
          || input.requiredArtifacts.some((path) => !actual.files.some((file) => file.path === path))) {
          return missing('TASK_ARTIFACTS_MISSING');
        }
        signal.throwIfAborted();
        const root = await mkdtemp(join(input.temporaryRoot, 'acceptance-'));
        let result: CustomEvaluatorResult;
        let stdout = '';
        let stderr = '';
        let processOutcome: TaskAttemptDiagnostic['processOutcome'] = null;
        let failureCode: string | undefined;
        try {
          await assertIdentityFilesUnchanged(input.runtimeFiles, { adapterLabel: 'Local task acceptance',
            cancellationCode: 'TASK_ACCEPTANCE_CANCELLED', identityChangedCode: 'TASK_ACCEPTANCE_RUNTIME_CHANGED', signal });
          const artifacts = join(root, 'artifacts');
          const verifier = join(root, 'verifier');
          await mkdir(artifacts, { mode: 0o700 });
          await mkdir(verifier, { mode: 0o700 });
          await materializeTaskFiles(artifacts, actual.files);
          await materializeTaskFiles(verifier, input.files);
          const { child, done } = spawnWithSigintPropagation(process.execPath, [join(verifier, input.definition.entrypoint)], {
            cwd: artifacts, env: { HOME: root, TMPDIR: root, LANG: 'C', TZ: 'UTC' }, timeoutMs: input.definition.timeoutMs,
            abortSignal: signal, maxBuffer: 256 * 1024,
          });
          child.stdin?.on('error', () => { /* done owns subprocess failure reporting */ });
          child.stdin?.end(JSON.stringify({ sampleId: actual.source.sampleId }));
          const completed = await done;
          stdout = completed.stdout;
          stderr = completed.stderr;
          processOutcome = { exitCode: completed.code, signal: completed.signal, failureKind: null };
          const acceptance = LocalTaskAcceptanceSchema.safeParse(JSON.parse(completed.stdout) as unknown);
          if (!acceptance.success) { failureCode = 'TASK_ACCEPTANCE_INVALID'; result = missing(failureCode); }
          else result = { resultKind: 'completed', results: [{
            metricId: TASK_METRIC_ID, resultKind: 'score', value: acceptance.data.passed,
            evidence: evidence({ acceptanceDigest, ...acceptance.data }),
          }] };
        } catch (error) {
          const failure = error as SpawnHelperError;
          stdout = failure.stdout ?? stdout;
          stderr = failure.stderr ?? stderr;
          if (failure.failureKind) processOutcome = { exitCode: failure.code ?? null, signal: failure.signal ?? null, failureKind: failure.failureKind };
          failureCode = signal.aborted ? 'TASK_ACCEPTANCE_CANCELLED'
            : failure.killedByTimeout ? 'TASK_ACCEPTANCE_TIMEOUT'
              : error instanceof ExecutionPortFailure ? 'TASK_ACCEPTANCE_RUNTIME_CHANGED'
                : error instanceof SyntaxError ? 'TASK_ACCEPTANCE_INVALID' : 'TASK_ACCEPTANCE_FAILED';
          result = missing(failureCode);
        }
        try { await rm(root, { recursive: true, force: true }); }
        catch { failureCode = 'TASK_ACCEPTANCE_CLEANUP_FAILED'; result = missing(failureCode); }
        if (failureCode) await input.captureDiagnostic({ stage: 'acceptance', status: failureCode, output: actual, stdout, stderr, processOutcome });
        return result;
      },
    },
  };
}

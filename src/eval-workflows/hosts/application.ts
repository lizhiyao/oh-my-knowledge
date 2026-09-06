import { resolve, join } from 'node:path';
import { schemaIdentityKey, type CoreSchemaValidator } from '../../eval-core/contracts/index.js';
import { compileCliEvaluationInput, type CliEvaluationRequest } from '../input-compilation/index.js';
import {
  createNodeCoreRunArtifactStore,
  createNodeCoreContentStore,
  createOverlayCoreRunArtifactStore,
  createNodeCoreBatchArtifactStore,
  type CoreRunArtifactStore,
} from '../artifact-store/index.js';
import { resolveNodeCliEvaluationRequest } from './input-resolution/node-cli-evaluation-resolver.js';
import { createNodeProductionComposition, type NodeEvaluationEnvironment } from './composition/node-runtime.js';
import {
  createRegisteredEvaluationComposition,
  type EvaluationRuntimeComposition,
} from './composition/registered-runtime.js';
import type { CreateProductionRuntimeFactoryRegistryInput } from './composition/runtime-registry.js';
import { createNodeHostPreflightDeclarations } from './composition/node-preflight.js';
import type { OmkRuntimeBindingFactories } from './types.js';
import { executeProductEvaluation, type ProductEvaluationResult } from '../orchestration/evaluation-service.js';
import { persistCoreArtifactSidecars } from '../orchestration/artifact-graph-persistence.js';
import { projectCoreManagedEvidence } from '../projections/managed.js';
import { projectCoreCliBatchOutcome } from '../projections/cli.js';
import type { CoreCliBatchOutcome, CoreCliDryRunProjection } from '../projections/contracts.js';
import type { OmkEvaluationProgressSink } from '../projections/runtime-progress.js';
import { discoverBatchSkills } from '../inputs/batch-discovery.js';
import { globalLayout, projectLayout } from '../../evidence/storage/layout.js';
import { generateRunId } from '../../evidence/storage/run-id.js';

export { parseCliEvaluationRequest, type CliEvaluationRequest } from '../input-compilation/index.js';
export { NodeCliProductionCompositionError, type NodeEvaluationEnvironment } from './composition/node-runtime.js';
export type { ClassifiedEnvironmentEntry } from './adapters/shared/classified-environment.js';
export type { CoreRunArtifactStore, StoredCoreRunArtifacts } from '../artifact-store/index.js';
export type { OmkLlmJudgeInvocationBinding } from './evaluators/llm-judge-invocation.js';
export type { OmkLlmJudgeInvocationRequest } from './evaluators/llm-judge-invocation.js';
export type { OmkExecutorBindingContext } from './types.js';
export { createJudgeProviderRuntimeIdentity } from './composition/judge-provider-identity.js';

export type EvaluationNotice =
  | { readonly noticeKind: 'doctor-skipped' }
  | { readonly noticeKind: 'batch-item'; readonly name: string }
  | { readonly noticeKind: 'managed-evidence-recorded'; readonly count: number }
  | { readonly noticeKind: 'managed-evidence-failed'; readonly error: unknown }
  | { readonly noticeKind: 'series-managed-evidence-skipped' };

type BatchItem = ReturnType<typeof discoverBatchSkills>[number];
export interface EvaluationApplicationInput {
  readonly request: CliEvaluationRequest;
  readonly projectRoot: string;
  readonly materializationRoot: string;
  readonly resourceLeaseRoot: string;
  readonly signal?: AbortSignal;
  readonly createProgressSink?: () => OmkEvaluationProgressSink;
  readonly onCompleted?: (result: ProductEvaluationResult & { readonly outputDirectory: string; readonly store: CoreRunArtifactStore }, request: CliEvaluationRequest) => Promise<void>;
  readonly store?: CoreRunArtifactStore;
  readonly managedEvidenceDirectory?: string;
  readonly onNotice?: (notice: EvaluationNotice) => void;
  /** Entry-owned translation from a batch item to its normalized request. */
  readonly requestForBatchItem?: (item: BatchItem) => CliEvaluationRequest;
}

type BatchDryRun = { readonly projectionKind: 'core-cli-batch-dry-run'; readonly children: readonly { readonly itemId: string; readonly plan: CoreCliDryRunProjection }[] };
export type EvaluationApplicationResult =
  | (ProductEvaluationResult & { readonly outputDirectory: string; readonly store: CoreRunArtifactStore })
  | { readonly outcomeKind: 'batch'; readonly outcome: CoreCliBatchOutcome; readonly outputDirectory: string }
  | { readonly outcomeKind: 'batch-dry-run'; readonly outcome: BatchDryRun; readonly outputDirectory: string };

export interface EvaluationApplication {
  run(input: EvaluationApplicationInput): Promise<EvaluationApplicationResult>;
}

type CompositionInput = { compiled: ReturnType<typeof compileCliEvaluationInput>; projectRoot: string; outputDirectory: string; resourceLeaseRoot: string };
interface ApplicationHost {
  readonly environment?: NodeJS.ProcessEnv;
  readonly implementationIds?: readonly string[];
  readonly idPrefix?: string;
  readonly globalFallback: boolean;
  compose(input: CompositionInput): EvaluationRuntimeComposition | Promise<EvaluationRuntimeComposition>;
}

function runStore(outputDirectory: string, contentResolver: EvaluationRuntimeComposition['contentResolver'], fallback: boolean): CoreRunArtifactStore {
  const primary = createNodeCoreRunArtifactStore(outputDirectory, { contentResolver });
  const fallbackDirs = fallback && resolve(outputDirectory) === resolve(projectLayout().evalDir) ? [globalLayout().evalDir] : [];
  const unique = [...new Set(fallbackDirs.map((dir) => resolve(dir)))].filter((dir) => dir !== resolve(outputDirectory));
  return unique.length === 0 ? primary : createOverlayCoreRunArtifactStore(primary, unique.map((dir) => createNodeCoreRunArtifactStore(dir, { contentResolver: createNodeCoreContentStore(join(dir, 'content')) })));
}

function createApplication(host: ApplicationHost): EvaluationApplication {
  async function run(input: EvaluationApplicationInput): Promise<EvaluationApplicationResult> {
    const { request } = input;
    const projectRoot = resolve(input.projectRoot);
    if (request.values.orchestration.preflight.doctor === 'skip') input.onNotice?.({ noticeKind: 'doctor-skipped' });
    if (request.values.orchestration.batch) {
      if (request.values.orchestration.repeatCount > 1) throw new TypeError(request.values.presentation.language === 'zh'
        ? '批量评测不支持独立重复。请移除 --batch 后逐个评测，或使用 --repeat 1 覆盖重复次数（包括 eval.yaml 中的 repeat）。'
        : 'Batch evaluation does not support independent repeats. Remove --batch and evaluate each skill separately, or use --repeat 1 to override the repeat count (including repeat in eval.yaml).');
      const entries = discoverBatchSkills(resolve(projectRoot, request.values.locators.skillDirectory));
      if (entries.length === 0) throw new TypeError(request.values.presentation.language === 'zh'
        ? `没有找到带 canonical 私有用例的目录 skill：${request.values.locators.skillDirectory}。每个 skill 应使用 <skill>/.omk/eval-samples.json 或 eval-samples.yaml。`
        : `No directory skill with canonical private samples found in ${request.values.locators.skillDirectory}. Use <skill>/.omk/eval-samples.json or eval-samples.yaml for each skill.`);
      if (request.values.orchestration.resumeSourceLocator !== undefined) throw new TypeError('Batch resume 必须按 child runId 显式执行，不能复用旧聚合报告。');
      if (input.requestForBatchItem === undefined) throw new TypeError('Batch evaluation requires an item request mapper.');
      const children: EvaluationApplicationResult[] = [];
      for (const entry of entries) {
        input.onNotice?.({ noticeKind: 'batch-item', name: entry.name });
        const childRequest = input.requestForBatchItem(entry);
        if (childRequest.values.orchestration.batch) throw new TypeError('Batch child 不能再次声明 batch。');
        children.push(await run({ ...input, request: childRequest }));
      }
      const outputDirectory = children[0]!.outputDirectory;
      if (request.values.orchestration.dryRun) {
        return { outcomeKind: 'batch-dry-run', outputDirectory, outcome: Object.freeze({ projectionKind: 'core-cli-batch-dry-run', children: Object.freeze(children.map((child, index) => {
          if (child.outcomeKind !== 'dry-run') throw new Error('Core Batch dry-run child 缺少 plan。');
          return Object.freeze({ itemId: entries[index]!.name, plan: child.outcome });
        })) }) };
      }
      const artifacts = children.map((child) => {
        if (child.outcomeKind !== 'run') throw new Error('Core Batch child 缺少持久化产物。');
        return child.artifacts;
      });
      const store = input.store ?? runStore(outputDirectory, createNodeCoreContentStore(join(outputDirectory, 'content')), host.globalFallback);
      const batch = await createNodeCoreBatchArtifactStore(outputDirectory, store).save({ batchId: generateRunId(['batch']), createdAt: new Date().toISOString(), children: artifacts.map((child, index) => ({ itemId: entries[index]!.name, runId: child.manifest.runId })) });
      return { outcomeKind: 'batch', outputDirectory, outcome: projectCoreCliBatchOutcome({ batch, children: artifacts, exitMode: request.values.presentation.exitMode, diagnosticMode: request.values.orchestration.diagnostic === 'enabled-outside-core' ? 'enabled' : 'disabled' }) };
    }
    const outputDirectory = resolve(projectRoot, request.values.presentation.outputDirectoryLocator);
    const resolved = await resolveNodeCliEvaluationRequest(request, {
      projectRoot, materializationRoot: input.materializationRoot,
      ...(host.environment === undefined ? {} : { environment: host.environment }),
      ...(request.values.orchestration.repeatCount > 1 ? { seriesInstanceId: generateRunId([`${host.idPrefix ?? ''}series`]) } : {}),
      ...(host.implementationIds === undefined ? {} : { hostExecutorImplementationIds: host.implementationIds, hostOwnedEffortImplementationIds: host.implementationIds }),
    });
    const compiled = compileCliEvaluationInput(resolved);
    const composition = await host.compose({ compiled, projectRoot, outputDirectory, resourceLeaseRoot: input.resourceLeaseRoot });
    const store = input.store ?? runStore(outputDirectory, composition.contentResolver, host.globalFallback);
    const result = await executeProductEvaluation({ host: { compiled, ...composition, artifactStore: store }, request, signal: input.signal, createProgressSink: input.createProgressSink, idPrefix: host.idPrefix });
    if (result.outcomeKind !== 'dry-run') {
      const artifacts = result.outcomeKind === 'run' ? [result.artifacts] : result.artifacts;
      for (const source of artifacts) await persistCoreArtifactSidecars({ source, outputDirectory, cwd: projectRoot });
      if (compiled.orchestration.managedEvidence === 'append') {
        if (result.outcomeKind === 'series') input.onNotice?.({ noticeKind: 'series-managed-evidence-skipped' });
        else {
          try {
            const { recordCoreEvalEvidence } = await import('../../knowledge-artifacts/governance/evidence.js');
            const written = recordCoreEvalEvidence(projectCoreManagedEvidence(result.artifacts), input.managedEvidenceDirectory === undefined ? undefined : { dir: input.managedEvidenceDirectory });
            if (written.length > 0) input.onNotice?.({ noticeKind: 'managed-evidence-recorded', count: written.length });
          } catch (error) { input.onNotice?.({ noticeKind: 'managed-evidence-failed', error }); }
        }
      }
    }
    const completed = { ...result, outputDirectory, store };
    await input.onCompleted?.(completed, request);
    return completed;
  }
  return Object.freeze({ run });
}

export function createNodeEvaluationApplication(capabilities: NodeEvaluationEnvironment): EvaluationApplication {
  return createApplication({ environment: capabilities.environment, globalFallback: true, compose: (input) => createNodeProductionComposition({ ...input, capabilities }) });
}

export interface HostedEvaluationCapabilities {
  readonly implementationId: string;
  readonly idPrefix?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly schemaValidators: readonly CoreSchemaValidator[];
  readonly executorFactory: OmkRuntimeBindingFactories['executorsByImplementationId'] extends ReadonlyMap<string, infer Factory> ? Factory : never;
  readonly resolveJudgeInvocation: CreateProductionRuntimeFactoryRegistryInput['resolveJudgeInvocation'];
}

export function createHostedEvaluationApplication(capabilities: HostedEvaluationCapabilities): EvaluationApplication {
  return createApplication({
    environment: capabilities.environment, implementationIds: [capabilities.implementationId], idPrefix: capabilities.idPrefix, globalFallback: false,
    compose(input) {
      const preflightDeclarations = createNodeHostPreflightDeclarations(input.compiled, capabilities.environment, input.projectRoot);
      return createRegisteredEvaluationComposition({
        ...input, schemaValidators: new Map(capabilities.schemaValidators.map((validator) => [schemaIdentityKey(validator.schema), validator])),
        resolveJudgeInvocation: capabilities.resolveJudgeInvocation,
        executorFactories: new Map([[capabilities.implementationId, async (context) => {
          const binding = await capabilities.executorFactory(context);
          return { ...binding, preflightDeclarations: [...preflightDeclarations, ...binding.preflightDeclarations] };
        }]]),
      });
    },
  });
}

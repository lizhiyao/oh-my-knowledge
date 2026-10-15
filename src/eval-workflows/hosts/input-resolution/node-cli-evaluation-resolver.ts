import { isRemovedBuiltinExecutor } from '../../../executors/core/registry.js';
import { compareStrings } from '../../../eval-core/primitives/ordering.js';
import { parseStatelessApiSampleInput } from '../adapters/shared/sample-input.js';
import { isAbsolute, resolve } from 'node:path';
import { deepFreezeCanonicalJson, type JsonValue } from '../../../eval-core/contracts/index.js';
import { RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION, RESOLVED_HOST_RESOURCES_SCHEMA_VERSION, type CliEvaluationRequest, type ResolvedCliEvaluationInput } from '../../input-compilation/index.js';
import { BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID } from '../../measurement/analysis/bootstrap-family-node-v2.js';
import { buildProductionMeasurementDesign } from '../../orchestration/measurement-design.js';
import { type SampleContentResolverSession } from '../../orchestration/sample-content-resolution.js';
import { absolute, fail, optionalFileResource, registry } from './resolution-resources.js';
import { artifactResource, resolveRequestedArtifacts, resolveVariantInputs } from './resolution-artifacts.js';
import { loadRequestedSamples, resolveExternalSamples, resolvedSampleContentResources } from './resolution-samples.js';
import { resolveTargetRuntime, resolvedExecutionControls, resolvedMocks } from './resolution-execution.js';

export interface ResolveNodeCliEvaluationRequestOptions {
  /** Absolute semantic root for relative CLI／eval.yaml locators. */
  readonly projectRoot: string;
  /** Resolver-owned directory for normalized inline or ephemeral resources. */
  readonly materializationRoot: string;
  /** Required when repeatCount > 1; identity allocation remains host-owned. */
  readonly seriesInstanceId?: string;
  /** Host-owned in-process Runtime implementations that need no executable resource. */
  readonly hostExecutorImplementationIds?: readonly string[];
  /** Host Runtime implementations whose reasoning configuration is provider-owned. */
  readonly hostOwnedEffortImplementationIds?: readonly string[];
  /** Environment inherited by resolver-owned MCP subprocesses. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Test／embedding seam. The Resolve stage owns and closes the supplied one-shot session. */
  readonly sampleContentResolver?: SampleContentResolverSession;
}

/** Production effect resolver. It never creates Runtime, runId, Plan, or persisted Run artifacts. */
export async function resolveNodeCliEvaluationRequest(
  request: Readonly<CliEvaluationRequest>,
  options: Readonly<ResolveNodeCliEvaluationRequestOptions>,
): Promise<ResolvedCliEvaluationInput> {
  if (!isAbsolute(options.projectRoot) || !isAbsolute(options.materializationRoot)) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'resolver.options',
    message: 'projectRoot 与 materializationRoot 必须是绝对路径。',
  });
  const selectedRuntimes = [
    { executorId: request.values.targetRuntime.executorId, fieldPath: 'targetRuntime.executorId' },
    ...request.values.judges.members.map((judge, index) => ({
      executorId: judge.executorId, fieldPath: `judges.members.${index}.executorId`,
    })),
  ];
  for (const runtime of selectedRuntimes) {
    if (isRemovedBuiltinExecutor(runtime.executorId)) fail({
      code: 'CLI_INPUT_INVALID', fieldPath: runtime.fieldPath,
      message: `内置执行器「${runtime.executorId}」已移除。请选择 codex、codex-sdk、openai-api 或自定义执行器文件路径。`,
    });
  }
  const hostExecutorImplementationIds = new Set(
    options.hostExecutorImplementationIds ?? [],
  );
  const hostOwnedEffortImplementationIds = new Set(
    options.hostOwnedEffortImplementationIds ?? [],
  );
  if ([...hostExecutorImplementationIds].some((implementationId) => (
    typeof implementationId !== 'string'
      || implementationId.trim() === ''
      || implementationId !== implementationId.trim()
  ))) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'resolver.options.hostExecutorImplementationIds',
    message: '宿主 Runtime implementationId 必须是非空规范字符串。',
  });
  if ([...hostOwnedEffortImplementationIds].some((implementationId) => (
    !hostExecutorImplementationIds.has(implementationId)
  ))) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'resolver.options.hostOwnedEffortImplementationIds',
    message: '宿主管理 effort 的 Runtime 必须同时声明为宿主 Runtime。',
  });
  if (request.values.orchestration.batch) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'orchestration.batch',
    message: 'Batch request 必须由 production host workflow 展开为独立 child evaluation。',
  });
  const { skillDirectory, inputs } = resolveVariantInputs(request, options.projectRoot);
  const loaded = loadRequestedSamples(request, options.projectRoot);
  const artifacts = resolveRequestedArtifacts(request, skillDirectory, inputs);
  const { resolvedSamples, resolvedContents } = await resolveExternalSamples(loaded.samples, request, options);
  const resources = registry();
  const sampleContentRecords = await resolvedSampleContentResources(
    resources,
    resolvedContents,
    options.materializationRoot,
  );
  const targetRuntime = await resolveTargetRuntime(
    resources,
    options.projectRoot,
    request.values.targetRuntime.executorId,
    hostExecutorImplementationIds,
  );
  if (targetRuntime.implementationResource === undefined) {
    for (const sample of resolvedSamples) {
      if (targetRuntime.sampleInputPolicy === 'stateless-api') {
        try { parseStatelessApiSampleInput(sample.input as JsonValue); }
        catch (cause) {
          return fail({ code: 'CLI_INPUT_INVALID', fieldPath: `samples.${sample.sample_id}.input`,
            message: cause instanceof Error ? cause.message : 'Unsupported API sample input.', cause });
        }
      } else if (sample.input.inputKind !== 'text') {
        return fail({ code: 'CLI_INPUT_INVALID', fieldPath: `samples.${sample.sample_id}.input`,
          message: 'This executor supports only text samples. Use openai-api for JSON/plain message history, or custom-executor for application-specific input.' });
      }
    }
  }
  const resolvedMockControls = await resolvedMocks(
    resources,
    resolvedSamples,
    loaded.baseDir,
    options.materializationRoot,
  );
  const mocks = resolvedMockControls.bindings;
  const mcpConfig = await optionalFileResource(
    resources,
    options.projectRoot,
    options.materializationRoot,
    request.values.locators.mcpConfig,
    'mcp-config',
  );
  const gold = await optionalFileResource(
    resources,
    options.projectRoot,
    options.materializationRoot,
    request.values.locators.gold,
    'gold-dataset',
  );

  const targets = await Promise.all(request.values.variants.map(async (variant, index) => {
    const artifact = artifacts[index]!;
    artifact.experimentRole = variant.experimentRole;
    if (variant.allowedSkills !== undefined) artifact.allowedSkills = [...variant.allowedSkills];
    const artifactDescriptor = await artifactResource(
      resources,
      artifact,
      variant.targetId,
      options.materializationRoot,
    );
    const executionControls = await resolvedExecutionControls(
      resources,
      resolvedSamples,
      options.projectRoot,
      variant.workspaceLocator,
      mcpConfig,
      resolvedMockControls.plansBySampleId,
    );
    return {
      targetId: variant.targetId,
      experimentRole: variant.experimentRole,
      targetKind: artifact.kind,
      protocolId: 'omk.invoke/v1' as const,
      executor: {
        implementationId: targetRuntime.implementationId,
        ...(targetRuntime.implementationResource === undefined ? {} : {
          implementationResource: targetRuntime.implementationResource,
        }),
        model: request.values.targetRuntime.model,
        ...(hostOwnedEffortImplementationIds.has(targetRuntime.implementationId)
          ? {}
          : { effort: request.values.targetRuntime.effort }),
      },
      behavior: {
        systemInstructions: artifact.content === null ? 'not-required' as const : 'required' as const,
        artifact: artifactDescriptor,
        ...(mcpConfig === undefined ? {} : { mcpConfig }),
        ...(mocks.length === 0 ? {} : { mocks }),
        ...(artifact.allowedSkills === undefined
          ? {}
          : { allowedSkills: [...artifact.allowedSkills] }),
      },
      executionControls,
    };
  }));

  const design = buildProductionMeasurementDesign(request, resolvedSamples);
  const repeatCount = request.values.orchestration.repeatCount;
  if (repeatCount > 1 && (options.seriesInstanceId?.trim() ?? '') === '') fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'orchestration.independentSeries.seriesInstanceId',
    message: 'repeat > 1 时必须由宿主分配 seriesInstanceId。',
  });
  const output: ResolvedCliEvaluationInput = {
    schemaVersion: RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION,
    ...design,
    targets,
    experiment: {
      trials: 1,
      seed: design.dataset.datasetId,
      assignment: {
        assignmentKind: 'complete-block',
        algorithmId: 'assignment.complete-block/v1',
        randomizationSlotIds: targets.map((target) => `slot-${target.targetId}`).sort(),
      },
      sampling: {
        experimentalUnit: 'sample',
        pairingKey: '/sampleId',
        repeatedMeasures: true,
        resamplingUnit: 'paired-block',
        estimatorId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
        seedCoupling: 'uncontrolled',
      },
      scheduling: {
        schedulingKind: 'randomized-block',
        blockSize: targets.length,
      },
    },
    policy: {
      executionConcurrency: request.values.measurement.executionConcurrency,
      evaluationConcurrency: request.values.measurement.executionConcurrency,
      executionTimeoutMs: request.values.measurement.timeoutMs,
      evaluationTimeoutMs: request.values.measurement.timeoutMs,
      retryCount: request.values.measurement.retryCount,
      cache: request.values.measurement.cache,
      ...(request.values.measurement.budget === undefined ? {} : {
        budget: request.values.measurement.budget,
      }),
    },
    hostResources: {
      schemaVersion: RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
      resources: [...resources.resourcesById.values()].sort((left, right) => (
        compareStrings(left.descriptor.resourceId, right.descriptor.resourceId)
      )),
    },
    orchestration: {
      dryRun: request.values.orchestration.dryRun,
      batch: false,
      ...(request.values.orchestration.resumeSourceLocator === undefined ? {} : {
        resumeSourceLocator: request.values.orchestration.resumeSourceLocator,
      }),
      preflight: request.values.orchestration.preflight,
      diagnostic: request.values.orchestration.diagnostic,
      ...(loaded.requires === undefined ? {} : {
        dependencyRequirements: {
          baseDirectoryLocator: resolve(loaded.baseDir),
          ...Object.fromEntries(Object.entries(loaded.requires)
            .filter((entry): entry is [string, string[]] => entry[1] !== undefined)
            .map(([key, values]) => [key, [...new Set(values)].sort()])),
        },
      }),
      ...(gold === undefined ? {} : {
        gold: { resourceId: gold.resourceId, comparisonMode: 'exploratory-post-hoc' },
      }),
      ...(repeatCount <= 1 ? {} : {
        independentSeries: {
          repeatCount,
          seriesInstanceId: options.seriesInstanceId!,
          comparisonScope: 'decision',
          minimumStatus: 'conditional',
        },
      }),
    },
    presentation: {
      ...request.values.presentation,
      outputDirectoryLocator: absolute(
        options.projectRoot,
        request.values.presentation.outputDirectoryLocator,
      ),
    },
    staticRunMetadata: {
      annotations: {
        inputSources: structuredClone(request.fieldSources) as unknown as JsonValue,
        sampleSourceCount: loaded.sourceFiles.length,
        ...(sampleContentRecords.length === 0 ? {} : {
          sampleContentResolution: structuredClone(sampleContentRecords) as unknown as JsonValue,
        }),
      },
    },
  };
  return deepFreezeCanonicalJson(output as unknown as JsonValue) as unknown as ResolvedCliEvaluationInput;
}

import { canonicalizeJson, type JsonValue, type TargetExecutionControls } from '../../../eval-core/contracts/index.js';
import type { Mock } from '../../../executors/contracts/mock.js';
import type { Sample } from '../../inputs/contracts/sample.js';
import { MOCK_INTERCEPTION_PLAN_MEDIA_TYPE } from '../../../eval-runtime/mock-interception.js';
import { CliEvaluationInputError, type ResolvedMockBinding, type ResolvedResourceDescriptor } from '../../input-compilation/index.js';
import { absolute, fail, fileResource, materializeBytes, treeResource, type ResourceRegistry } from './resolution-resources.js';

type ExecutionWorkspaceDescriptor = Extract<
  TargetExecutionControls['defaults']['workspace'],
  { workspaceMode: 'copy-on-write-overlay' }
>['descriptor'];

type ExecutionMcpDescriptor = Extract<
  TargetExecutionControls['defaults']['mcp'],
  { mcpMode: 'native-config' }
>['descriptor'];

type ExecutionMockDescriptor = Extract<
  TargetExecutionControls['defaults']['mockInterception'],
  { mockInterceptionMode: 'pre-tool-call' }
>['descriptor'];

function executionWorkspaceDescriptor(
  descriptor: ResolvedResourceDescriptor,
): ExecutionWorkspaceDescriptor {
  if (descriptor.classification === 'gold') fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'executionControls.workspace.descriptor.classification',
    message: 'Executor workspace 不得使用 Gold classification。',
  });
  return descriptor as ExecutionWorkspaceDescriptor;
}

function executionMcpDescriptor(
  descriptor: ResolvedResourceDescriptor,
): ExecutionMcpDescriptor {
  if (descriptor.classification === 'gold') fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'executionControls.mcp.descriptor.classification',
    message: 'Executor MCP config 不得使用 Gold classification。',
  });
  return descriptor as ExecutionMcpDescriptor;
}

function executionMockDescriptor(
  descriptor: ResolvedResourceDescriptor,
): ExecutionMockDescriptor {
  if (descriptor.classification !== 'secret'
      || descriptor.mediaType !== MOCK_INTERCEPTION_PLAN_MEDIA_TYPE) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'executionControls.mockInterception.descriptor',
    message: 'Executor mock interception plan 必须使用 secret 专用 media type。',
  });
  return descriptor as ExecutionMockDescriptor;
}

const PRODUCTION_EXECUTOR_INPUT_POLICIES = new Map<string, 'text' | 'stateless-api'>([
  ['codex', 'text'],
  ['codex-sdk', 'text'],
  ['openai-api', 'stateless-api'],
]);

interface ResolvedTargetRuntime {
  readonly implementationId: string;
  readonly implementationResource?: ResolvedResourceDescriptor;
  readonly sampleInputPolicy?: 'text' | 'stateless-api';
}

export async function resolveTargetRuntime(
  resources: ResourceRegistry,
  projectRoot: string,
  requestedExecutorId: string,
  hostExecutorImplementationIds: ReadonlySet<string>,
): Promise<ResolvedTargetRuntime> {
  if (PRODUCTION_EXECUTOR_INPUT_POLICIES.has(requestedExecutorId)
      || hostExecutorImplementationIds.has(requestedExecutorId)) {
    return { implementationId: requestedExecutorId, sampleInputPolicy: PRODUCTION_EXECUTOR_INPUT_POLICIES.get(requestedExecutorId) ?? 'text' };
  }
  const executablePath = absolute(projectRoot, requestedExecutorId);
  const descriptor = await fileResource(resources, {
    resourceKind: 'runtime-implementation',
    path: executablePath,
    classification: 'sensitive',
    mediaType: 'application/vnd.omk.custom-executor-runtime',
    lineage: {
      lineageKind: 'custom-executor-runtime',
      exchangeSchemaVersion: 'omk.custom-executor-exchange/v1',
    },
  }).catch((cause: unknown) => {
    if (!(cause instanceof CliEvaluationInputError)
        || cause.code !== 'CLI_INPUT_RESOLUTION_FAILED') throw cause;
    return fail({
      code: cause.code,
      sourcePath: cause.sourcePath,
      fieldPath: 'targetRuntime.executorId',
      message: '自定义执行器必须是存在且可读取的可执行文件路径，不接受带参数的命令字符串。',
      cause,
    });
  });
  return {
    implementationId: `custom-executor-${descriptor.digest.slice('sha256:'.length)}`,
    implementationResource: descriptor,
  };
}

async function mockPayloadDescriptors(
  resources: ResourceRegistry,
  mock: Readonly<Mock>,
  samplesBaseDir: string,
  materializationRoot: string,
): Promise<readonly ResolvedResourceDescriptor[]> {
  if (mock.return_file !== undefined) {
    const path = absolute(samplesBaseDir, mock.return_file);
    return [await fileResource(resources, {
      resourceKind: 'mock-payload',
      path,
      classification: 'secret',
    })];
  }
  const values = mock.return_seq ?? (mock.return === undefined ? [''] : [mock.return]);
  return Promise.all(values.map(async (value) => {
    const objectValue = typeof value === 'object' && value !== null;
    const bytes = Buffer.from(objectValue ? JSON.stringify(value) : String(value));
    const path = await materializeBytes(
      materializationRoot,
      bytes,
      objectValue ? '.json' : '.txt',
    );
    return fileResource(resources, {
      resourceKind: 'mock-payload',
      path,
      classification: 'secret',
      mediaType: objectValue ? 'application/json' : 'text/plain',
    });
  }));
}

async function mockRuleDescriptor(
  resources: ResourceRegistry,
  mock: Readonly<Mock>,
  materializationRoot: string,
): Promise<ResolvedResourceDescriptor> {
  const bytes = Buffer.from(canonicalizeJson({
    tool: mock.tool,
    ...(mock.match === undefined ? {} : { match: structuredClone(mock.match) as JsonValue }),
  }));
  const path = await materializeBytes(materializationRoot, bytes, '.json');
  return fileResource(resources, {
    resourceKind: 'mock-rule',
    path,
    classification: 'secret',
    mediaType: 'application/json',
  });
}

export async function resolvedMocks(
  resources: ResourceRegistry,
  samples: readonly Readonly<Sample>[],
  samplesBaseDir: string,
  materializationRoot: string,
): Promise<Readonly<{
  bindings: readonly ResolvedMockBinding[];
  plansBySampleId: ReadonlyMap<string, ResolvedResourceDescriptor>;
}>> {
  const bindings: ResolvedMockBinding[] = [];
  const plansBySampleId = new Map<string, ResolvedResourceDescriptor>();
  for (const sample of samples) {
    const sampleBindings: ResolvedMockBinding[] = [];
    for (const mock of sample.mocks ?? []) {
      const binding: ResolvedMockBinding = {
        sampleIds: [sample.sample_id],
        rule: await mockRuleDescriptor(resources, mock, materializationRoot),
        strict: sample.mocksStrict ?? true,
        payloads: await mockPayloadDescriptors(
          resources,
          mock,
          samplesBaseDir,
          materializationRoot,
        ),
      };
      bindings.push(binding);
      sampleBindings.push(binding);
    }
    if (sampleBindings.length > 0) {
      const bytes = Buffer.from(canonicalizeJson({
        schemaVersion: 'omk.mock-interception-plan/v1',
        strict: sampleBindings[0]!.strict,
        rules: sampleBindings.map((binding, index) => ({
          mockId: `mock-${index + 1}`,
          rule: binding.rule,
          payloads: binding.payloads,
        })),
      }));
      const path = await materializeBytes(materializationRoot, bytes, '.json');
      plansBySampleId.set(sample.sample_id, await fileResource(resources, {
        resourceKind: 'mock-plan',
        path,
        classification: 'secret',
        mediaType: MOCK_INTERCEPTION_PLAN_MEDIA_TYPE,
      }));
    }
  }
  return Object.freeze({ bindings, plansBySampleId });
}

export async function resolvedExecutionControls(
  resources: ResourceRegistry,
  samples: readonly Readonly<Sample>[],
  projectRoot: string,
  targetWorkspaceLocator: string | undefined,
  mcpConfig: ResolvedResourceDescriptor | undefined,
  mockPlansBySampleId: ReadonlyMap<string, ResolvedResourceDescriptor>,
): Promise<TargetExecutionControls> {
  const defaultWorkspace = targetWorkspaceLocator === undefined
    ? undefined
    : await treeResource(resources, {
        resourceKind: 'workspace',
        path: absolute(projectRoot, targetWorkspaceLocator),
        classification: 'sensitive',
        mediaType: 'application/vnd.omk.workspace-tree',
      });
  const sampleOverrides = (await Promise.all(samples.map(async (sample) => {
    const workspace = targetWorkspaceLocator !== undefined || sample.cwd === undefined
      ? undefined
      : await treeResource(resources, {
          resourceKind: 'workspace',
          path: absolute(projectRoot, sample.cwd),
          classification: 'sensitive',
          mediaType: 'application/vnd.omk.workspace-tree',
        });
    const tools = sample.allowedTools === undefined
      ? undefined
      : {
          toolPolicyKind: 'allow-list' as const,
          allowedTools: [...sample.allowedTools].sort(),
        };
    const mockPlan = mockPlansBySampleId.get(sample.sample_id);
    if (workspace === undefined && tools === undefined && mockPlan === undefined) return undefined;
    return {
      sampleId: sample.sample_id,
      ...(workspace === undefined ? {} : {
        workspace: {
          workspaceMode: 'copy-on-write-overlay' as const,
            descriptor: executionWorkspaceDescriptor(workspace),
        },
      }),
      ...(tools === undefined ? {} : { tools }),
      ...(mockPlan === undefined ? {} : {
        mockInterception: {
          mockInterceptionMode: 'pre-tool-call' as const,
          descriptor: executionMockDescriptor(mockPlan),
        },
      }),
    };
  }))).filter((override) => override !== undefined);
  return {
    defaults: {
      workspace: defaultWorkspace === undefined
        ? { workspaceMode: 'not-required' }
        : {
            workspaceMode: 'copy-on-write-overlay',
            descriptor: executionWorkspaceDescriptor(defaultWorkspace),
          },
      tools: { toolPolicyKind: 'runtime-default' },
      mcp: mcpConfig === undefined
        ? { mcpMode: 'not-required' }
        : { mcpMode: 'native-config', descriptor: executionMcpDescriptor(mcpConfig) },
      mockInterception: { mockInterceptionMode: 'not-required' },
    },
    sampleOverrides,
  };
}

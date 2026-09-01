import { isAbsolute } from 'node:path';
import type { EvaluationEngineClock } from '../../evaluation-core/engine/index.js';
import type { ExecutionExecutor } from '../../evaluation-core/execution/index.js';
import {
  deepFreezeCanonicalJson,
  type JsonValue,
} from '../../evaluation-core/contracts/index.js';
import { createNodeCoreContentStore } from '../artifact-store/node-content-store.js';
import {
  createAnthropicApiExecutorAdapter,
  createClaudeCliExecutorAdapter,
  createClaudeSdkExecutorAdapter,
  createCodexCliExecutorAdapter,
  createCodexSdkExecutorAdapter,
  createCustomCommandExecutorAdapter,
  createOpenAIApiExecutorAdapter,
  type AnthropicApiCoreConfiguration,
  type ClaudeCliCoreConfiguration,
  type ClaudeSdkCoreConfiguration,
  type CodexCliCoreConfiguration,
  type CodexSdkCoreConfiguration,
  type CustomCommandConfiguration,
  type CustomCommandRuntimeDescription,
  type OpenAIApiCoreConfiguration,
} from '../runtime-adapter/adapters/index.js';
import { captureCoreApiTransport } from '../runtime-adapter/adapters/api-http.js';
import type { OmkEvaluationRuntimeSupportPorts } from '../runtime-adapter/composition.js';
import {
  createLlmAssertionEvaluatorBindingFactory,
  LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  type OmkLlmJudgeInvocationResolver,
} from '../runtime-adapter/evaluators/llm-assertions.js';
import {
  createRubricJudgeEvaluatorBindingFactory,
  RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
} from '../runtime-adapter/evaluators/rubric-judge.js';
import type {
  OmkExecutorBindingContext,
  OmkRuntimeBindingFactories,
  OmkRuntimePortBinding,
  OmkRuntimePreflightDeclaration,
} from '../runtime-adapter/types.js';

type ProductionExecutorPreflightConfiguration = {
  /** Physical checks are host-owned and captured without executing them. */
  readonly preflightDeclarations: readonly OmkRuntimePreflightDeclaration[];
};

export type ProductionExecutorAdapterConfiguration = ProductionExecutorPreflightConfiguration & (
  | { readonly adapterKind: 'codex-cli'; readonly command: CodexCliCoreConfiguration }
  | { readonly adapterKind: 'codex-sdk'; readonly sdk?: CodexSdkCoreConfiguration }
  | { readonly adapterKind: 'claude-cli'; readonly command: ClaudeCliCoreConfiguration }
  | { readonly adapterKind: 'claude-sdk'; readonly sdk?: ClaudeSdkCoreConfiguration }
  | { readonly adapterKind: 'openai-api'; readonly api: OpenAIApiCoreConfiguration }
  | { readonly adapterKind: 'anthropic-api'; readonly api: AnthropicApiCoreConfiguration }
  | {
      readonly adapterKind: 'custom-command';
      readonly runtime: CustomCommandRuntimeDescription;
      readonly command: CustomCommandConfiguration;
    }
);

export interface CreateProductionRuntimeFactoryRegistryInput {
  /** Exact implementation IDs selected by resolved Targets. Factories remain lazy. */
  readonly executorsByImplementationId: ReadonlyMap<
    string,
    ProductionExecutorAdapterConfiguration
  >;
  /** Omit only when the resolved Definition contains no provider-backed Evaluator. */
  readonly resolveJudgeInvocation?: OmkLlmJudgeInvocationResolver;
}

export class ProductionRuntimeRegistryError extends TypeError {
  readonly code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID';
  readonly implementationId?: string;

  constructor(input: {
    code: ProductionRuntimeRegistryError['code'];
    message: string;
    implementationId?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ProductionRuntimeRegistryError';
    this.code = input.code;
    this.implementationId = input.implementationId;
  }
}

function fail(input: ConstructorParameters<typeof ProductionRuntimeRegistryError>[0]): never {
  throw new ProductionRuntimeRegistryError(input);
}

function readonlyMapSnapshot<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const snapshot = new Map(source);
  const view: ReadonlyMap<Key, Value> = Object.freeze({
    get size() { return snapshot.size; },
    get(key: Key) { return snapshot.get(key); },
    has(key: Key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
    forEach(
      callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
      thisArg?: unknown,
    ) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });
  return view;
}

function jsonSnapshot<Value>(value: Value): Value {
  return deepFreezeCanonicalJson(
    structuredClone(value) as unknown as JsonValue,
  ) as unknown as Value;
}

function preflightSnapshot(
  declarations: readonly OmkRuntimePreflightDeclaration[],
): readonly OmkRuntimePreflightDeclaration[] {
  return Object.freeze(declarations.map((declaration) => Object.freeze({ ...declaration })));
}

function snapshotConfiguration(
  configuration: ProductionExecutorAdapterConfiguration,
): ProductionExecutorAdapterConfiguration {
  const preflightDeclarations = preflightSnapshot(configuration.preflightDeclarations);
  switch (configuration.adapterKind) {
    case 'codex-cli':
    case 'claude-cli':
      return Object.freeze({
        adapterKind: configuration.adapterKind,
        preflightDeclarations,
        command: Object.freeze({
          ...configuration.command,
          ...(configuration.command.environment === undefined ? {} : {
            environment: jsonSnapshot(configuration.command.environment),
          }),
          ...(configuration.command.contentIdentityFiles === undefined ? {} : {
            contentIdentityFiles: jsonSnapshot(configuration.command.contentIdentityFiles),
          }),
        }),
      }) as ProductionExecutorAdapterConfiguration;
    case 'codex-sdk':
    case 'claude-sdk':
      return Object.freeze({
        adapterKind: configuration.adapterKind,
        preflightDeclarations,
        ...(configuration.sdk === undefined ? {} : {
          sdk: Object.freeze({
            ...configuration.sdk,
            ...(configuration.sdk.environment === undefined ? {} : {
              environment: jsonSnapshot(configuration.sdk.environment),
            }),
          }),
        }),
      }) as ProductionExecutorAdapterConfiguration;
    case 'openai-api':
    case 'anthropic-api':
      return Object.freeze({
        adapterKind: configuration.adapterKind,
        preflightDeclarations,
        api: Object.freeze({
          ...configuration.api,
          ...(configuration.api.transport === undefined ? {} : {
            transport: captureCoreApiTransport(configuration.api.transport),
          }),
        }),
      }) as ProductionExecutorAdapterConfiguration;
    case 'custom-command':
      return Object.freeze({
        adapterKind: configuration.adapterKind,
        preflightDeclarations,
        runtime: Object.freeze({
          ...configuration.runtime,
          capabilities: jsonSnapshot(configuration.runtime.capabilities),
          ...(configuration.runtime.contentIdentityFiles === undefined ? {} : {
            contentIdentityFiles: jsonSnapshot(configuration.runtime.contentIdentityFiles),
          }),
        }),
        command: Object.freeze({
          ...configuration.command,
          ...(configuration.command.arguments === undefined ? {} : {
            arguments: Object.freeze([...configuration.command.arguments]),
          }),
          ...(configuration.command.environment === undefined ? {} : {
            environment: jsonSnapshot(configuration.command.environment),
          }),
        }),
      });
  }
}

function executorFactory(
  implementationId: string,
  configuration: ProductionExecutorAdapterConfiguration,
): (context: Readonly<OmkExecutorBindingContext>) => Promise<
  OmkRuntimePortBinding<ExecutionExecutor>
> {
  return async (context) => {
    if (context.binding.implementationId !== implementationId) fail({
      code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
      implementationId,
      message: 'Executor factory 收到与注册键不一致的 binding。',
    });
    const common = {
      target: context.target,
      binding: context.binding,
      sessionIsolationKey: context.sessionIsolationKey,
      resourceLeases: context.resourceLeases,
    };
    let port: ExecutionExecutor;
    switch (configuration.adapterKind) {
      case 'codex-cli':
        port = await createCodexCliExecutorAdapter({ ...common, command: configuration.command });
        break;
      case 'codex-sdk':
        port = await createCodexSdkExecutorAdapter({ ...common, sdk: configuration.sdk });
        break;
      case 'claude-cli':
        port = await createClaudeCliExecutorAdapter({ ...common, command: configuration.command });
        break;
      case 'claude-sdk':
        port = await createClaudeSdkExecutorAdapter({ ...common, sdk: configuration.sdk });
        break;
      case 'openai-api':
        port = await createOpenAIApiExecutorAdapter({ ...common, api: configuration.api });
        break;
      case 'anthropic-api':
        port = await createAnthropicApiExecutorAdapter({ ...common, api: configuration.api });
        break;
      case 'custom-command':
        if (configuration.runtime.implementationId !== implementationId) fail({
          code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
          implementationId,
          message: 'Custom command Runtime identity 与注册键不一致。',
        });
        port = await createCustomCommandExecutorAdapter({
          target: context.target,
          binding: context.binding,
          runtime: configuration.runtime,
          command: configuration.command,
          sessionIsolationKey: context.sessionIsolationKey,
          resourceLeases: context.resourceLeases,
        });
        break;
    }
    return {
      port,
      // Production inputs currently declare exact implementation IDs but no version range.
      // Until a version-constraint resolver is explicit, any supplied constraint fails closed.
      satisfiesVersionConstraint: context.binding.versionConstraint === undefined,
      preflightDeclarations: configuration.preflightDeclarations,
    };
  };
}

/** Creates the only production registry without touching unused Runtime configuration. */
export function createProductionRuntimeFactoryRegistry(
  input: Readonly<CreateProductionRuntimeFactoryRegistryInput>,
): OmkRuntimeBindingFactories {
  let executorEntries: readonly [string, ProductionExecutorAdapterConfiguration][];
  try {
    executorEntries = [...input.executorsByImplementationId.entries()];
  } catch (cause) {
    return fail({
      code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
      message: 'Executor registry 必须是可迭代的 ReadonlyMap。',
      cause,
    });
  }
  const executorsByImplementationId = new Map<string, ReturnType<typeof executorFactory>>();
  for (const [implementationId, configuration] of executorEntries) {
    if (typeof implementationId !== 'string' || implementationId.trim() === '') fail({
      code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
      message: 'Executor implementationId 必须是非空字符串。',
    });
    let captured: ProductionExecutorAdapterConfiguration;
    try {
      if (configuration.adapterKind === 'custom-command'
          && configuration.runtime.implementationId !== implementationId) fail({
        code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
        implementationId,
        message: 'Custom command Runtime identity 与注册键不一致。',
      });
      captured = snapshotConfiguration(configuration);
    } catch (cause) {
      if (cause instanceof ProductionRuntimeRegistryError) throw cause;
      fail({
        code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
        implementationId,
        message: 'Executor registry configuration 无法安全捕获。',
        cause,
      });
    }
    executorsByImplementationId.set(
      implementationId,
      executorFactory(implementationId, captured),
    );
  }

  // Built-ins are owned and merged exactly once by createOmkEvaluationRuntime.
  // This host registry contributes only platform adapters and provider-backed judges.
  const evaluatorsByImplementationId = new Map();
  if (input.resolveJudgeInvocation !== undefined) {
    evaluatorsByImplementationId.set(
      LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      createLlmAssertionEvaluatorBindingFactory(input.resolveJudgeInvocation),
    );
    evaluatorsByImplementationId.set(
      RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
      createRubricJudgeEvaluatorBindingFactory(input.resolveJudgeInvocation),
    );
  }
  return Object.freeze({
    executorsByImplementationId: readonlyMapSnapshot(executorsByImplementationId),
    evaluatorsByImplementationId: readonlyMapSnapshot(evaluatorsByImplementationId),
    analysisNodesByImplementationId: readonlyMapSnapshot(new Map()),
    missingPoliciesByImplementationId: readonlyMapSnapshot(new Map()),
    decisionPoliciesByImplementationId: readonlyMapSnapshot(new Map()),
    seriesAnalysisNodesByImplementationId: readonlyMapSnapshot(new Map()),
    seriesDecisionPoliciesByImplementationId: readonlyMapSnapshot(new Map()),
  });
}

export function createNodeEvaluationClock(): EvaluationEngineClock {
  return Object.freeze({
    monotonicNow: () => performance.now(),
    timestamp: () => new Date().toISOString(),
    sleep(delayMs: number, signal: AbortSignal): Promise<void> {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        return Promise.reject(new TypeError('Clock delayMs 必须是有限非负数。'));
      }
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, delayMs);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
}

/** Node support ports share one digest-verifying content store instance. */
export function createNodeEvaluationRuntimeSupportPorts(input: Readonly<{
  readonly contentStoreRoot: string;
  readonly clock?: EvaluationEngineClock;
}>): OmkEvaluationRuntimeSupportPorts {
  if (typeof input.contentStoreRoot !== 'string'
      || input.contentStoreRoot.trim() === ''
      || !isAbsolute(input.contentStoreRoot)) fail({
    code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID',
    message: 'contentStoreRoot 必须是非空绝对路径。',
  });
  const contentStore = createNodeCoreContentStore(input.contentStoreRoot);
  return Object.freeze({
    clock: input.clock ?? createNodeEvaluationClock(),
    executionContentStore: contentStore,
    evaluationContentStore: contentStore,
    contentResolver: contentStore,
  });
}

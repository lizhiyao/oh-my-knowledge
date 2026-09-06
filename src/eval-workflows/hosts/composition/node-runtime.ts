import { createNodeHostPreflightDeclarations } from './node-preflight.js';
import { isAbsolute } from 'node:path';
import {
  schemaIdentityKey,
  type CoreSchemaValidator,
  type RuntimeIdentity,
} from '../../../eval-core/contracts/index.js';
import { createExecutor } from '../../../executors/index.js';
import type { ExecutorFn } from '../../../executors/contracts/ports.js';
import { resolveExecutorRuntimeFingerprint } from '../../../executors/core/runtime-fingerprint.js';
import type { CliEvaluationCompileResult } from '../../input-compilation/index.js';
import type {
  OmkLlmJudgeInvocationBinding,
} from '../evaluators/llm-judge-invocation.js';
import { createExecutorJudgeInvocationPort } from '../evaluators/executor-judge-invocation.js';
import {
  createAnthropicApiCoreSchemaValidators,
} from '../adapters/anthropic/protocol.js';
import {
  createClaudeCliCoreSchemaValidators,
} from '../adapters/claude/cli-protocol.js';
import {
  createClaudeSdkCoreSchemaValidators,
} from '../adapters/claude/sdk-protocol.js';
import {
  createCodexCliCoreSchemaValidators,
} from '../adapters/codex/cli-protocol.js';
import {
  createCodexSdkCoreSchemaValidators,
} from '../adapters/codex/sdk-protocol.js';
import {
  createCustomCommandCoreSchemaValidators,
  customCommandExecutorCapabilities,
} from '../adapters/custom/command.js';
import {
  createOpenAIApiCoreSchemaValidators,
} from '../adapters/openai/protocol.js';
import type { ClassifiedEnvironmentEntry } from '../adapters/shared/classified-environment.js';
import { createJudgeProviderRuntimeIdentity } from './judge-provider-identity.js';
import {
  createProductionRuntimeFactoryRegistry,
  type ProductionExecutorAdapterConfiguration,
} from './runtime-registry.js';

import { createRegisteredEvaluationComposition, type EvaluationRuntimeComposition } from './registered-runtime.js';

export interface NodeEvaluationEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly classifiedEnvironment: Readonly<Record<string, ClassifiedEnvironmentEntry>>;
  resolveExecutable(command: string): Promise<string>;
  requiredCredential(key: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'): string;
}

export interface CreateNodeProductionCompositionInput {
  readonly compiled: CliEvaluationCompileResult;
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly resourceLeaseRoot: string;
  readonly capabilities: NodeEvaluationEnvironment;
}

export class NodeCliProductionCompositionError extends Error {
  readonly code:
    | 'NODE_CLI_EXECUTOR_UNSUPPORTED'
    | 'NODE_CLI_EXECUTABLE_UNAVAILABLE'
    | 'NODE_CLI_CREDENTIAL_MISSING';

  constructor(
    code: NodeCliProductionCompositionError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'NodeCliProductionCompositionError';
    this.code = code;
  }
}

async function executorConfiguration(
  implementationId: string,
  compiled: CliEvaluationCompileResult,
  capabilities: NodeEvaluationEnvironment,
  projectRoot: string,
): Promise<ProductionExecutorAdapterConfiguration> {
  const preflightDeclarations = createNodeHostPreflightDeclarations(
    compiled,
    capabilities.environment,
    projectRoot,
  );
  const capturedEnvironment = capabilities.classifiedEnvironment;
  switch (implementationId) {
    case 'codex':
      return Object.freeze({
        adapterKind: 'codex-cli',
        command: {
          executablePath: await capabilities.resolveExecutable('codex'),
          environment: capturedEnvironment,
        },
        preflightDeclarations,
      });
    case 'codex-sdk':
      return Object.freeze({
        adapterKind: 'codex-sdk',
        sdk: { environment: capturedEnvironment },
        preflightDeclarations,
      });
    case 'claude':
      return Object.freeze({
        adapterKind: 'claude-cli',
        command: {
          executablePath: await capabilities.resolveExecutable('claude'),
          environment: capturedEnvironment,
        },
        preflightDeclarations,
      });
    case 'claude-sdk':
      return Object.freeze({
        adapterKind: 'claude-sdk',
        sdk: { environment: capturedEnvironment },
        preflightDeclarations,
      });
    case 'openai-api':
      return Object.freeze({
        adapterKind: 'openai-api',
        api: { apiKey: capabilities.requiredCredential('OPENAI_API_KEY') },
        preflightDeclarations,
      });
    case 'anthropic-api':
      return Object.freeze({
        adapterKind: 'anthropic-api',
        api: { apiKey: capabilities.requiredCredential('ANTHROPIC_API_KEY') },
        preflightDeclarations,
      });
    default: {
      const runtimeResource = compiled.hostResources.resources.find((resource) => (
        resource.resourceKind === 'runtime-implementation'
        && typeof resource.lineage === 'object'
        && resource.lineage !== null
        && !Array.isArray(resource.lineage)
        && resource.lineage.lineageKind === 'custom-command-runtime'
        && implementationId === `custom-command-${resource.descriptor.digest.slice('sha256:'.length)}`
      ));
      if (runtimeResource === undefined) {
        throw new NodeCliProductionCompositionError(
          'NODE_CLI_EXECUTOR_UNSUPPORTED',
          `Evaluation Core 找不到执行器「${implementationId}」的可信 Runtime 声明。`,
        );
      }
      return Object.freeze({
        adapterKind: 'custom-command',
        runtime: {
          implementationId,
          version: '1.0.0',
          capabilities: customCommandExecutorCapabilities(),
          contentIdentityFiles: [{ facetId: 'runtime-executable', path: runtimeResource.locator }],
        },
        command: {
          executablePath: runtimeResource.locator,
          environment: capturedEnvironment,
        },
        preflightDeclarations,
      });
    }
  }
}

function productionSchemaValidators(): ReadonlyMap<string, CoreSchemaValidator> {
  const validators = [
    ...createCodexCliCoreSchemaValidators(),
    ...createCodexSdkCoreSchemaValidators(),
    ...createClaudeCliCoreSchemaValidators(),
    ...createClaudeSdkCoreSchemaValidators(),
    ...createOpenAIApiCoreSchemaValidators(),
    ...createAnthropicApiCoreSchemaValidators(),
    ...createCustomCommandCoreSchemaValidators(),
  ];
  return new Map(validators.map((validator) => [schemaIdentityKey(validator.schema), validator]));
}

function judgeIdentity(
  executorId: string,
  model: string,
  deploymentRevision: string | undefined,
  executor: ExecutorFn,
  environment: NodeJS.ProcessEnv,
): RuntimeIdentity {
  return createJudgeProviderRuntimeIdentity({
    executorId,
    model,
    ...(deploymentRevision === undefined ? {} : { deploymentRevision }),
    executorRuntime: resolveExecutorRuntimeFingerprint(
      executorId,
      model,
      { env: environment },
      executor,
    ),
  });
}

function judgeResolver(environment: NodeJS.ProcessEnv): (
  context: Parameters<NonNullable<Parameters<typeof createProductionRuntimeFactoryRegistry>[0]['resolveJudgeInvocation']>>[0],
) => Promise<OmkLlmJudgeInvocationBinding> {
  const executors = new Map<string, ExecutorFn>();
  return async (context) => {
    const qualification = context.binding.qualification;
    if (qualification === undefined) {
      throw new NodeCliProductionCompositionError(
        'NODE_CLI_EXECUTOR_UNSUPPORTED',
        'LLM 评委 binding 缺少 provider qualification。',
      );
    }
    const executorId = qualification.executorId;
    let executor = executors.get(executorId);
    if (executor === undefined) {
      executor = createExecutor(executorId);
      executors.set(executorId, executor);
    }
    return Object.freeze({
      port: createExecutorJudgeInvocationPort(executor, judgeIdentity(
        executorId,
        qualification.model,
        qualification.deploymentRevision,
        executor,
        environment,
      )),
      preflightDeclarations: Object.freeze([Object.freeze({
        preflightKind: 'connectivity' as const,
        checkId: 'provider-connectivity',
        preflightDisposition: 'not-required' as const,
        reasonCode: 'core-evaluation-is-authoritative',
      }), Object.freeze({
        preflightKind: 'credential' as const,
        checkId: 'host-credential',
        preflightDisposition: 'not-required' as const,
        reasonCode: 'provider-validates-credential',
      })]),
    });
  };
}

/** Builds the Node CLI's only production Runtime composition from sealed input. */
export async function createNodeProductionComposition(
  input: Readonly<CreateNodeProductionCompositionInput>,
): Promise<EvaluationRuntimeComposition> {
  if (!isAbsolute(input.outputDirectory)) {
    throw new TypeError('outputDirectory 必须是绝对路径。');
  }
  if (!isAbsolute(input.resourceLeaseRoot)) {
    throw new TypeError('resourceLeaseRoot 必须是绝对路径。');
  }
  const environment = input.capabilities.environment;
  const implementationIds = [...new Set(input.compiled.runtimeBinding.bindings.flatMap((binding) => (
    binding.runtimeKind === 'executor' ? [binding.implementationId] : []
  )))].sort();
  const configurations = await Promise.all(implementationIds.map(async (implementationId) => (
    [implementationId, await executorConfiguration(
      implementationId,
      input.compiled,
      input.capabilities,
      input.projectRoot,
    )] as const
  )));
  return createRegisteredEvaluationComposition({
    compiled: input.compiled,
    outputDirectory: input.outputDirectory,
    resourceLeaseRoot: input.resourceLeaseRoot,
    schemaValidators: productionSchemaValidators(),
    executorConfigurations: new Map(configurations),
    resolveJudgeInvocation: judgeResolver(environment),
  });
}

import type { EvaluationRuntimeProvider } from '../../../eval-runtime/provider.js';
import type { EvaluationContentResolver } from '../../../eval-core/evaluation/index.js';
import type { CoreSchemaValidator } from '../../../eval-core/contracts/index.js';
import type { CliEvaluationCompileResult } from '../../input-compilation/index.js';
import {
  createNodeEvaluationRuntimeSupportPorts,
  createProductionRuntimeFactoryRegistry,
  type CreateProductionRuntimeFactoryRegistryInput,
} from './runtime-registry.js';
import { createOmkRuntimeProvider, createOmkEvaluationSchemaValidators } from './runtime.js';
import type { OmkRuntimeBindingFactories } from '../types.js';
import { join } from 'node:path';

export interface EvaluationRuntimeComposition {
  readonly runtime: EvaluationRuntimeProvider;
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  readonly contentResolver: EvaluationContentResolver | undefined;
}

export function createRegisteredEvaluationComposition(input: Readonly<{
  compiled: CliEvaluationCompileResult;
  outputDirectory: string;
  resourceLeaseRoot: string;
  schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  executorConfigurations?: CreateProductionRuntimeFactoryRegistryInput['executorsByImplementationId'];
  executorFactories?: OmkRuntimeBindingFactories['executorsByImplementationId'];
  resolveJudgeInvocation: CreateProductionRuntimeFactoryRegistryInput['resolveJudgeInvocation'];
}>): EvaluationRuntimeComposition {
  const support = {
    ...createNodeEvaluationRuntimeSupportPorts({ contentStoreRoot: join(input.outputDirectory, 'content') }),
    schemaValidators: input.schemaValidators,
  };
  const base = createProductionRuntimeFactoryRegistry({
    executorsByImplementationId: input.executorConfigurations ?? new Map(),
    resolveJudgeInvocation: input.resolveJudgeInvocation,
  });
  const factories = input.executorFactories === undefined ? base : { ...base, executorsByImplementationId: input.executorFactories };
  return Object.freeze({
    runtime: createOmkRuntimeProvider({ compiled: input.compiled, factories, support, resources: { leaseRoot: input.resourceLeaseRoot } }),
    schemaValidators: createOmkEvaluationSchemaValidators(support.schemaValidators),
    contentResolver: support.contentResolver,
  });
}

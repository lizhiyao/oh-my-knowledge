import { compareStrings } from '../../eval-core/primitives/ordering.js';
import { deepFreezeCanonicalJson, digestCanonicalJson, type EvaluationDefinition, type MeasurementPolicy } from '../../eval-core/contracts/index.js';
import { EvaluationDefinitionError, validateDefinitionSemantics } from '../../eval-core/compiler/index.js';
import { RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION, type CliEvaluationCompileResult, type EvaluationOrchestrationOptions, type ResolvedCliEvaluationInput } from './types.js';
import { fail, canonicalSnapshot } from './compile/values.js';
import { normalizeHostResources, validateHostResourceMaterializationSemantics, validateHostOptions, validateResourceReferences } from './compile/resources.js';
import { compileDefinition } from './compile/definition.js';
import { compilePolicy, compileSeries } from './compile/policy.js';
import { compileRuntimeBinding } from './compile/binding.js';

function validateCompiledCoreSemantics(
  definition: EvaluationDefinition,
  policy: MeasurementPolicy,
): void {
  try {
    validateDefinitionSemantics(definition, policy);
  } catch (cause) {
    const coreError = cause instanceof EvaluationDefinitionError ? cause : undefined;
    fail({
      code: 'CLI_INPUT_CORE_SEMANTICS_INVALID',
      fieldPath: 'definition',
      message: '编译后的 EvaluationDefinition／MeasurementPolicy 未通过 Core 引用或静态语义校验。',
      ...(coreError === undefined ? {} : {
        details: canonicalSnapshot({
          coreCode: coreError.code,
          ...(coreError.details === undefined ? {} : { coreDetails: coreError.details }),
        }),
      }),
      cause,
    });
  }
}

/**
 * Pure deterministic compiler. It performs no filesystem, environment, network,
 * clock, Runtime resolution, or preflight work.
 */
export function compileCliEvaluationInput(
  input: Readonly<ResolvedCliEvaluationInput>,
): CliEvaluationCompileResult {
  const resolvedInput = canonicalSnapshot(input) as unknown as ResolvedCliEvaluationInput;
  if (resolvedInput.schemaVersion !== RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'schemaVersion',
    message: 'Resolved CLI evaluation input 版本不受支持。',
  });
  validateHostOptions(resolvedInput);
  const hostResources = normalizeHostResources(resolvedInput.hostResources);
  validateResourceReferences(resolvedInput, hostResources);
  validateHostResourceMaterializationSemantics(hostResources);
  const definition = compileDefinition(resolvedInput);
  const policy = compilePolicy(resolvedInput);
  validateCompiledCoreSemantics(definition, policy);
  const definitionDigest = digestCanonicalJson(definition);
  const policyDigest = digestCanonicalJson(policy);
  const series = compileSeries(resolvedInput, digestCanonicalJson({ definition, policy }));
  const orchestration: EvaluationOrchestrationOptions = deepFreezeCanonicalJson(canonicalSnapshot({
    dryRun: resolvedInput.orchestration.dryRun,
    batch: resolvedInput.orchestration.batch,
    ...(resolvedInput.orchestration.resumeSourceLocator === undefined ? {} : {
      resumeSourceLocator: resolvedInput.orchestration.resumeSourceLocator,
    }),
    preflight: resolvedInput.orchestration.preflight,
    diagnostic: resolvedInput.orchestration.diagnostic,
    ...(resolvedInput.orchestration.dependencyRequirements === undefined ? {} : {
      dependencyRequirements: {
        baseDirectoryLocator:
          resolvedInput.orchestration.dependencyRequirements.baseDirectoryLocator,
        ...Object.fromEntries(Object.entries(
          resolvedInput.orchestration.dependencyRequirements,
        ).filter(([key]) => key !== 'baseDirectoryLocator')
          .map(([key, values]) => [key, [...values].sort(compareStrings)])),
      },
    }),
    ...(resolvedInput.orchestration.cacheSources === undefined ? {} : {
      cacheSources: resolvedInput.orchestration.cacheSources,
    }),
    ...(resolvedInput.orchestration.gold === undefined ? {} : { gold: resolvedInput.orchestration.gold }),
    ...(series === undefined ? {} : { independentSeries: series }),
  })) as unknown as EvaluationOrchestrationOptions;
  const presentation = deepFreezeCanonicalJson(
    canonicalSnapshot(resolvedInput.presentation),
  ) as unknown as CliEvaluationCompileResult['presentation'];
  const runOptions = deepFreezeCanonicalJson(canonicalSnapshot({
    ...(resolvedInput.staticRunMetadata === undefined ? {} : { metadata: resolvedInput.staticRunMetadata }),
  })) as unknown as CliEvaluationCompileResult['runOptions'];
  const runtimeBinding = compileRuntimeBinding(resolvedInput, definition, series);
  return deepFreezeCanonicalJson({
    definition,
    policy,
    runtimeBinding,
    hostResources,
    orchestration,
    presentation,
    runOptions,
    canonicalDigests: { definition: definitionDigest, policy: policyDigest },
  });
}

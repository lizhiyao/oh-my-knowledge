import { compareStrings } from '../../primitives/ordering.js';
import { canonicalizeJson, type JsonValue, type RuntimeIdentity, type SchemaIdentity, type TargetExecutionRequirements } from '../../contracts/index.js';
import { EvaluationDefinitionError } from '../errors.js';
import { snapshotJson } from '../immutability.js';
import { type AnalysisCapabilities, type AnalysisNodeCapabilities, type DecisionPolicyCapabilities, type MissingPolicyCapabilities, type EvaluatorCapabilities, type ExecutorCapabilities } from '../types.js';

function sortedUniqueStrings(
  values: readonly string[],
  referenceId: string,
  field: string,
): string[] {
  if (new Set(values).size !== values.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime capability manifest 包含重复声明。',
      details: { referenceId, field },
    });
  }
  return [...values].sort(compareStrings);
}

function sortedSchemas(identities: readonly SchemaIdentity[]): SchemaIdentity[] {
  return [...identities].sort((left, right) => (
    compareStrings(left.schemaUri, right.schemaUri)
    || compareStrings(left.schemaVersion, right.schemaVersion)
    || compareStrings(left.schemaDigest, right.schemaDigest)
  ));
}

export function bindCapabilities(
  identity: RuntimeIdentity,
  capabilities: ExecutorCapabilities | EvaluatorCapabilities | AnalysisCapabilities,
): RuntimeIdentity {
  return {
    ...identity,
    capabilities: snapshotJson(capabilities) as JsonValue,
  };
}

export function normalizeExecutorCapabilities(
  capabilities: ExecutorCapabilities,
  referenceId: string,
): ExecutorCapabilities {
  return {
    schemaVersion: capabilities.schemaVersion,
    protocols: capabilities.protocols.map((protocol) => ({
      ...protocol,
      execution: {
        ...protocol.execution,
        features: {
          ...protocol.execution.features,
          workspace: sortedUniqueStrings(
            protocol.execution.features.workspace,
            referenceId,
            `${protocol.protocolId}.features.workspace`,
          ) as typeof protocol.execution.features.workspace,
          mcp: sortedUniqueStrings(
            protocol.execution.features.mcp,
            referenceId,
            `${protocol.protocolId}.features.mcp`,
          ) as typeof protocol.execution.features.mcp,
          mockInterception: sortedUniqueStrings(
            protocol.execution.features.mockInterception,
            referenceId,
            `${protocol.protocolId}.features.mockInterception`,
          ) as typeof protocol.execution.features.mockInterception,
          toolPolicies: sortedUniqueStrings(
            protocol.execution.features.toolPolicies,
            referenceId,
            `${protocol.protocolId}.features.toolPolicies`,
          ) as typeof protocol.execution.features.toolPolicies,
          skillDiscovery: sortedUniqueStrings(
            protocol.execution.features.skillDiscovery,
            referenceId,
            `${protocol.protocolId}.features.skillDiscovery`,
          ) as typeof protocol.execution.features.skillDiscovery,
          sandboxIds: sortedUniqueStrings(
            protocol.execution.features.sandboxIds,
            referenceId,
            `${protocol.protocolId}.features.sandboxIds`,
          ),
        },
      },
    })).sort((left, right) => compareStrings(left.protocolId, right.protocolId)),
  };
}

export function assertExecutionRequirementsSupported(
  referenceId: string,
  requirements: TargetExecutionRequirements,
  features: ExecutorCapabilities['protocols'][number]['execution']['features'],
): void {
  const unsupported = (
    field: keyof TargetExecutionRequirements,
    required: string,
    supported: readonly string[],
  ): never => {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Target execution requirement 不受 Runtime 支持。',
      details: { referenceId, field, required, supported: [...supported] },
    });
  };
  if (requirements.systemInstructions === 'required'
      && features.systemInstructions === 'unsupported') {
    unsupported('systemInstructions', 'required', [features.systemInstructions]);
  }
  if (requirements.workspace !== 'not-required'
      && !features.workspace.includes(requirements.workspace)) {
    unsupported('workspace', requirements.workspace, features.workspace);
  }
  if (requirements.mcp !== 'not-required' && !features.mcp.includes(requirements.mcp)) {
    unsupported('mcp', requirements.mcp, features.mcp);
  }
  if (requirements.mockInterception !== 'not-required'
      && !features.mockInterception.includes(requirements.mockInterception)) {
    unsupported(
      'mockInterception',
      requirements.mockInterception,
      features.mockInterception,
    );
  }
  if (!features.toolPolicies.includes(requirements.toolPolicy)) {
    unsupported('toolPolicy', requirements.toolPolicy, features.toolPolicies);
  }
  if (!features.skillDiscovery.includes(requirements.skillDiscovery)) {
    unsupported('skillDiscovery', requirements.skillDiscovery, features.skillDiscovery);
  }
  if (requirements.sandboxId !== undefined
      && !features.sandboxIds.includes(requirements.sandboxId)) {
    unsupported('sandboxId', requirements.sandboxId, features.sandboxIds);
  }
}

export function normalizeEvaluatorCapabilities(
  capabilities: EvaluatorCapabilities,
  referenceId: string,
): EvaluatorCapabilities {
  return {
    inputSourceKinds: sortedUniqueStrings(
      capabilities.inputSourceKinds,
      referenceId,
      'inputSourceKinds',
    ) as EvaluatorCapabilities['inputSourceKinds'],
    metricValueTypes: sortedUniqueStrings(
      capabilities.metricValueTypes,
      referenceId,
      'metricValueTypes',
    ) as EvaluatorCapabilities['metricValueTypes'],
    schemas: sortedSchemas(capabilities.schemas),
    ...(capabilities.providerCost === undefined
      ? {}
      : { providerCost: snapshotJson(capabilities.providerCost) }),
  };
}

export function normalizeAnalysisCapabilities(
  capabilities: AnalysisCapabilities,
  referenceId: string,
): AnalysisCapabilities {
  if (capabilities.capabilityKind === 'missing-policy') {
    return {
      capabilityKind: 'missing-policy',
      valueTypes: sortedUniqueStrings(
        capabilities.valueTypes,
        referenceId,
        'valueTypes',
      ) as MissingPolicyCapabilities['valueTypes'],
      schemas: sortedSchemas(capabilities.schemas),
    };
  }
  if (capabilities.capabilityKind === 'decision-policy') {
    return {
      capabilityKind: 'decision-policy',
      analysisResultSchemaUris: sortedUniqueStrings(
        capabilities.analysisResultSchemaUris,
        referenceId,
        'analysisResultSchemaUris',
      ),
      multipleComparisonPolicyIds: sortedUniqueStrings(
        capabilities.multipleComparisonPolicyIds,
        referenceId,
        'multipleComparisonPolicyIds',
      ),
      parameterSchema: capabilities.parameterSchema,
      schemas: sortedSchemas(capabilities.schemas),
    } as DecisionPolicyCapabilities;
  }
  const inputDomains = capabilities.inputDomains.map((domain) => (
    domain.inputKind === 'metric-observations'
      ? {
        ...domain,
        valueTypes: sortedUniqueStrings(
          domain.valueTypes,
          referenceId,
          'inputDomains.valueTypes',
        ) as typeof domain.valueTypes,
        ...(domain.missingPolicyIds !== undefined ? {
          missingPolicyIds: sortedUniqueStrings(
            domain.missingPolicyIds,
            referenceId,
            'inputDomains.missingPolicyIds',
          ),
        } : {}),
      }
      : domain.inputKind === 'analysis-result' ? {
        ...domain,
        schemaUris: sortedUniqueStrings(
          domain.schemaUris,
          referenceId,
          'inputDomains.schemaUris',
        ),
      } : domain
  )).sort((left, right) => (
    compareStrings(canonicalizeJson(left), canonicalizeJson(right))
  ));
  if (new Set(inputDomains.map((domain) => canonicalizeJson(domain))).size
      !== inputDomains.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime capability manifest 包含重复 input domain。',
      details: { referenceId, field: 'inputDomains' },
    });
  }
  if (capabilities.sampling !== undefined
      && new Set(capabilities.sampling.repeatedMeasures).size
        !== capabilities.sampling.repeatedMeasures.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime capability manifest 包含重复声明。',
      details: { referenceId, field: 'sampling.repeatedMeasures' },
    });
  }
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: sortedUniqueStrings(
      capabilities.analysisNodeKinds,
      referenceId,
      'analysisNodeKinds',
    ) as AnalysisNodeCapabilities['analysisNodeKinds'],
    inputDomains,
    outputSchema: capabilities.outputSchema,
    parameterSchema: capabilities.parameterSchema,
    inputCardinalities: capabilities.inputCardinalities,
    ...(capabilities.sampling !== undefined ? {
      sampling: {
        assignmentKinds: sortedUniqueStrings(
          capabilities.sampling.assignmentKinds,
          referenceId,
          'sampling.assignmentKinds',
        ) as NonNullable<AnalysisNodeCapabilities['sampling']>['assignmentKinds'],
        experimentalUnits: sortedUniqueStrings(
          capabilities.sampling.experimentalUnits,
          referenceId,
          'sampling.experimentalUnits',
        ) as NonNullable<AnalysisNodeCapabilities['sampling']>['experimentalUnits'],
        repeatedMeasures: [...capabilities.sampling.repeatedMeasures].sort(
          (left, right) => Number(left) - Number(right),
        ),
        resamplingUnits: sortedUniqueStrings(
          capabilities.sampling.resamplingUnits,
          referenceId,
          'sampling.resamplingUnits',
        ) as NonNullable<AnalysisNodeCapabilities['sampling']>['resamplingUnits'],
      },
    } : {}),
    schemas: sortedSchemas(capabilities.schemas),
  };
}

export function assertVersionSatisfied(
  referenceId: string,
  versionConstraint: string | undefined,
  satisfied: boolean,
): void {
  if (satisfied) return;
  throw new EvaluationDefinitionError({
    code: 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
    stage: 'configuration',
    preparationStage: 'runtime-resolution',
    message: '解析出的 Runtime 不满足声明的版本约束。',
    details: {
      referenceId,
      ...(versionConstraint !== undefined ? { versionConstraint } : {}),
    },
  });
}

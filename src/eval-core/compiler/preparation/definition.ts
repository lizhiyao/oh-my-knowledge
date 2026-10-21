import { compareStrings } from '../../primitives/ordering.js';
import { z } from 'zod';
import { EvaluationDefinitionSchema, canonicalizeJson, projectAnalysisCohorts, projectAnalysisGraph, normalizeTargetExecutionControls, type ResolvedRuntime } from '../../contracts/index.js';
import { EvaluationDefinitionError } from '../errors.js';
import { AnalysisCapabilitiesSchema, type PreparationRuntime } from '../types.js';
import { isCompositeAnalysisImplementationId } from '../validation.js';
import { parseInput, requireSchemaValidator } from './schemas.js';

export function normalizeDefinitionParameters(
  definition: z.infer<typeof EvaluationDefinitionSchema>,
  analysisRuntimes: readonly ResolvedRuntime[],
  decisionRuntimes: readonly ResolvedRuntime[],
  runtime: PreparationRuntime,
): z.infer<typeof EvaluationDefinitionSchema> {
  const analysisRuntimeByNodeId = new Map(analysisRuntimes
    .filter((entry) => entry.runtimeKind === 'analysis-node')
    .map((entry) => [entry.referenceId, entry]));
  const nodes = definition.analysisGraph.nodes.map((node) => {
    const resolved = analysisRuntimeByNodeId.get(node.nodeId);
    const capabilities = resolved === undefined ? undefined : AnalysisCapabilitiesSchema.safeParse(
      resolved.identity.capabilities,
    );
    if (capabilities?.success !== true || capabilities.data.capabilityKind !== 'analysis-node') {
      throw new TypeError('Resolved Analysis capabilities disappeared before sealing.');
    }
    const validator = requireSchemaValidator(
      runtime,
      capabilities.data.parameterSchema,
      node.nodeId,
    );
    try {
      const parameters = validator.parse(node.parameters ?? {});
      const inputs = isCompositeAnalysisImplementationId(node.implementationId)
        ? [...node.inputs].sort((left, right) => {
          const leftRank = left.inputKind === 'metric-observations' ? 0 : 1;
          const rightRank = right.inputKind === 'metric-observations' ? 0 : 1;
          return leftRank - rightRank
            || compareStrings(canonicalizeJson(left), canonicalizeJson(right));
        })
        : node.inputs;
      return {
        ...node,
        inputs,
        parameters,
      };
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Analysis node parameters 不符合实现声明的 schema。',
        details: { nodeId: node.nodeId },
      });
    }
  });
  let decisionPolicy = definition.decisionPolicy;
  if (decisionPolicy !== undefined) {
    const resolved = decisionRuntimes.find((entry) => entry.runtimeKind === 'decision-policy');
    const capabilities = resolved === undefined ? undefined : AnalysisCapabilitiesSchema.safeParse(
      resolved.identity.capabilities,
    );
    if (capabilities?.success !== true || capabilities.data.capabilityKind !== 'decision-policy') {
      throw new TypeError('Resolved Decision capabilities disappeared before sealing.');
    }
    const validator = requireSchemaValidator(
      runtime,
      capabilities.data.parameterSchema,
      decisionPolicy.decisionPolicyId,
    );
    try {
      decisionPolicy = {
        ...decisionPolicy,
        parameters: validator.parse(decisionPolicy.parameters ?? {}),
      };
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'DecisionPolicy parameters 不符合实现声明的 schema。',
        details: { referenceId: decisionPolicy.decisionPolicyId },
      });
    }
  }
  return parseInput(EvaluationDefinitionSchema, {
    ...definition,
    analysisGraph: { ...definition.analysisGraph, nodes },
    ...(decisionPolicy !== undefined ? { decisionPolicy } : {}),
  }, 'EvaluationDefinition');
}

export function normalizeEvaluationDefinition(
  definitionInput: unknown,
): z.infer<typeof EvaluationDefinitionSchema> {
  const definition = parseInput(
    EvaluationDefinitionSchema,
    definitionInput,
    'EvaluationDefinition',
  );
  return parseInput(EvaluationDefinitionSchema, {
    ...definition,
    dataset: {
      ...definition.dataset,
      samples: definition.dataset.samples.map((sample) => ({
        ...sample,
        ...(sample.analysis === undefined ? {} : {
          analysis: {
            ...sample.analysis,
            memberships: [...sample.analysis.memberships].sort((left, right) => (
              compareStrings(left.cohortId, right.cohortId)
            )),
          },
        }),
      })),
      ...(definition.dataset.analysisCohorts === undefined ? {} : {
        analysisCohorts: projectAnalysisCohorts(definition.dataset),
      }),
    },
    targets: definition.targets.map((target) => ({
      ...target,
      executionControls: normalizeTargetExecutionControls(target.executionControls),
    })),
    evaluators: definition.evaluators.map((evaluator) => ({
      ...evaluator,
      ...(evaluator.applicableSampleIds === undefined ? {} : {
        applicableSampleIds: [...evaluator.applicableSampleIds].sort(compareStrings),
      }),
    })),
    analysisGraph: projectAnalysisGraph(definition.analysisGraph),
  }, 'EvaluationDefinition');
}

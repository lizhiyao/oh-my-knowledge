/**
 * 内建分析节点目录：把每个节点的实现、参数 schema 与校验器注册进 BUILTIN_DEFINITIONS。
 */
import {
  type JsonValue,
  type SchemaIdentity,
} from '../contracts/index.js';
import type {
  BuiltinDefinition,
} from './builtin-primitives.js';
import {
  executeClusterBootstrap,
  executeCompositeClusterBootstrap,
  executeCompositeMeanBootstrap,
  executeCompositePairedBootstrap,
  executeCompositeUnpairedBootstrap,
  executeHierarchicalClusterBootstrap,
  executeHierarchicalMean,
  executeHierarchicalMeanBootstrap,
  executeHierarchicalPairedBootstrap,
  executeHierarchicalQuantile,
  executeHierarchicalRate,
  executeHierarchicalUnpairedBootstrap,
  executeMeanBootstrap,
  executePairedBootstrap,
  executeUnpairedBootstrap,
} from './builtin-bootstrap.js';
import {
  BUILTIN_HYPOTHESIS_INPUT_SCHEMA,
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  executeBonferroni,
  executeSimultaneousIntervalFamily,
} from './builtin-hypothesis.js';
import {
  nodeCapabilities,
  runtimeIdentity,
} from './builtin-identity.js';
import {
  executeMean,
  executeQuantile,
  executeRate,
} from './builtin-primitives.js';
import {
  BONFERRONI_PARAMETERS_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BUILTIN_SCALAR_RESULT_SCHEMA,
  BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
  COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
  EMPTY_PARAMETERS_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  HIERARCHICAL_QUANTILE_PARAMETERS_SCHEMA,
  HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA,
  QUANTILE_PARAMETERS_SCHEMA,
  SIMULTANEOUS_INTERVAL_FAMILY_PARAMETERS_SCHEMA,
} from './builtin-schemas.js';

export const BUILTIN_DEFINITIONS = new Map<string, BuiltinDefinition>();


function register(
  implementationId: string,
  capabilities: JsonValue,
  outputSchema: SchemaIdentity,
  parameterSchema: SchemaIdentity,
  execute: BuiltinDefinition['execute'],
): void {
  BUILTIN_DEFINITIONS.set(implementationId, {
    identity: runtimeIdentity(implementationId, capabilities),
    outputSchema,
    parameterSchema,
    execute,
  });
}

register(
  'descriptive.mean/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: EMPTY_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  EMPTY_PARAMETERS_SCHEMA,
  executeMean,
);
register(
  'descriptive.rate/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: EMPTY_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  EMPTY_PARAMETERS_SCHEMA,
  executeRate,
);
register(
  'descriptive.quantile/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: QUANTILE_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  QUANTILE_PARAMETERS_SCHEMA,
  executeQuantile,
);
register(
  'descriptive.hierarchical-mean/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA,
  executeHierarchicalMean,
);
register(
  'descriptive.hierarchical-rate/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA,
  executeHierarchicalRate,
);
register(
  'descriptive.hierarchical-quantile/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_QUANTILE_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  HIERARCHICAL_QUANTILE_PARAMETERS_SCHEMA,
  executeHierarchicalQuantile,
);
register(
  'bootstrap.mean-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block', 'independent-groups'],
      experimentalUnits: ['sample', 'run'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample', 'paired-block', 'run'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executeMeanBootstrap,
);
register(
  'bootstrap.paired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executePairedBootstrap,
);
register(
  'bootstrap.unpaired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executeUnpairedBootstrap,
);
register(
  'bootstrap.hierarchical-mean-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block', 'independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample', 'paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalMeanBootstrap,
);
register(
  'bootstrap.hierarchical-paired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalPairedBootstrap,
);
register(
  'bootstrap.hierarchical-unpaired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalUnpairedBootstrap,
);
register(
  'bootstrap.cluster-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['cluster'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['cluster'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executeClusterBootstrap,
);
register(
  'bootstrap.hierarchical-cluster-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['cluster'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['cluster'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalClusterBootstrap,
);
register(
  'bootstrap.composite-mean-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    metricObservationCardinality: { min: 2 },
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block', 'independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample', 'paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeCompositeMeanBootstrap,
);
register(
  'bootstrap.composite-cluster-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    metricObservationCardinality: { min: 2 },
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['cluster'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['cluster'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeCompositeClusterBootstrap,
);
register(
  'bootstrap.composite-paired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    metricObservationCardinality: { min: 2 },
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeCompositePairedBootstrap,
);
register(
  'bootstrap.composite-unpaired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    metricObservationCardinality: { min: 2 },
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeCompositeUnpairedBootstrap,
);
register(
  'simultaneous-intervals.bonferroni/v1',
  nodeCapabilities({
    analysisNodeKind: 'correction',
    analysisResultSchemaUris: [BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri],
    analysisResultCardinality: { min: 2 },
    outputSchema: BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
    parameterSchema: SIMULTANEOUS_INTERVAL_FAMILY_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
  SIMULTANEOUS_INTERVAL_FAMILY_PARAMETERS_SCHEMA,
  executeSimultaneousIntervalFamily,
);
register(
  'bonferroni/v1',
  nodeCapabilities({
    analysisNodeKind: 'correction',
    analysisResultSchemaUris: [BUILTIN_HYPOTHESIS_INPUT_SCHEMA.schemaUri],
    outputSchema: BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
    parameterSchema: BONFERRONI_PARAMETERS_SCHEMA,
  }),
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  BONFERRONI_PARAMETERS_SCHEMA,
  executeBonferroni,
);


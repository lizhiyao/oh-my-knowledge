import type { AnalysisNodeImplementation } from '../../../eval-core/analysis/index.js';
import { createStatelessAnalysisImplementation } from './analysis-support.js';
import {
  parseBootstrapFamilyParameters,
} from './bootstrap-family-parameters.js';
import {
  extractBootstrapObservations,
} from './bootstrap-family-source-adapter.js';
import {
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  buildBootstrapFamilyTable,
  parseBootstrapFamilyTableEnvelope,
} from './bootstrap-family-table.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY,
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
} from './bootstrap-family-node-contract.js';
import {
  bootstrapFamilyAnalysisResultInput,
  validateBootstrapExecutionDesign,
} from './bootstrap-family-node-support.js';

export {
  BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY,
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
} from './bootstrap-family-node-contract.js';

export function createBootstrapFamilyAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const implementation = createStatelessAnalysisImplementation({
    identity: BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY,
    outputSchema: BOOTSTRAP_FAMILY_TABLE_SCHEMA,
    parseParameters: (parameters) => { parseBootstrapFamilyParameters(parameters); },
    execute(context) {
      const parameters = parseBootstrapFamilyParameters(context.node.parameters);
      validateBootstrapExecutionDesign(context, parameters);
      const input = bootstrapFamilyAnalysisResultInput(context.inputs, parameters);
      const observations = extractBootstrapObservations({
        resultType: input.record.resultType,
        value: input.record.value,
      }, context.signal);
      const table = buildBootstrapFamilyTable(parameters, observations);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: parseBootstrapFamilyTableEnvelope({ resultType: 'table', value: table }).value,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{
          assumptionId: 'bootstrap-family-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  return new Map([[BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID, implementation]]);
}

import type { AnalysisNodeImplementation } from '../../../eval-core/analysis/index.js';
import { createStatelessAnalysisImplementation } from './analysis-support.js';
import { parseAgreementParameters } from './agreement-parameters.js';
import { extractAgreementPairs } from './agreement-source-adapter.js';
import {
  AGREEMENT_TABLE_SCHEMA,
  buildAgreementTable,
  parseAgreementTableEnvelope,
} from './agreement-table.js';
import {
  AGREEMENT_ANALYSIS_IDENTITY,
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
  agreementAnalysisResultInput,
  validateAgreementExecutionDesign,
} from './agreement-node-contract.js';

export {
  AGREEMENT_ANALYSIS_IDENTITY,
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
} from './agreement-node-contract.js';

export function createAgreementAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const implementation = createStatelessAnalysisImplementation({
    identity: AGREEMENT_ANALYSIS_IDENTITY,
    outputSchema: AGREEMENT_TABLE_SCHEMA,
    parseParameters: (parameters) => { parseAgreementParameters(parameters); },
    execute(context) {
      const parameters = parseAgreementParameters(context.node.parameters);
      validateAgreementExecutionDesign(context, parameters);
      const input = agreementAnalysisResultInput(context.inputs, parameters);
      const pairs = extractAgreementPairs(
        parameters,
        { resultType: input.record.resultType, value: input.record.value },
        context.samples,
        context.signal,
      );
      const table = buildAgreementTable(parameters, pairs);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: parseAgreementTableEnvelope({ resultType: 'table', value: table }).value,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{ assumptionId: 'agreement-contract', checkStatus: 'passed' }],
      };
    },
  });
  return new Map([[AGREEMENT_ANALYSIS_IMPLEMENTATION_ID, implementation]]);
}

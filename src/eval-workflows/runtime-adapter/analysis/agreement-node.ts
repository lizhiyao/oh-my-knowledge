import type { AnalysisNodeImplementation } from '../../../eval-core/analysis/index.js';
import { createStatelessAnalysisImplementation } from './analysis-support.js';
import { parseAgreementParameters } from './agreement-parameters.js';
import { extractAgreementPairs } from './agreement-source-adapter.js';
import { extractAgreementPairs as extractAgreementPairsV1 } from './agreement-source-adapter-v1.js';
import {
  AGREEMENT_TABLE_SCHEMA,
  AGREEMENT_TABLE_V1_SCHEMA,
  buildAgreementTable,
  buildAgreementTableV1,
  parseAgreementTableEnvelope,
  parseAgreementTableV1Envelope,
} from './agreement-table.js';
import {
  AGREEMENT_ANALYSIS_IDENTITY,
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
  AGREEMENT_ANALYSIS_V2_IDENTITY,
  AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID,
  AGREEMENT_ANALYSIS_V1_IDENTITY,
  AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID,
  agreementAnalysisResultInput,
  agreementAnalysisResultInputV1,
  validateAgreementExecutionDesign,
} from './agreement-node-contract.js';

export {
  AGREEMENT_ANALYSIS_IDENTITY,
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
  AGREEMENT_ANALYSIS_V2_IDENTITY,
  AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID,
  AGREEMENT_ANALYSIS_V1_IDENTITY,
  AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID,
} from './agreement-node-contract.js';

export function createAgreementAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const v1Implementation = createStatelessAnalysisImplementation({
    identity: AGREEMENT_ANALYSIS_V1_IDENTITY,
    outputSchema: AGREEMENT_TABLE_V1_SCHEMA,
    parseParameters: (parameters) => { parseAgreementParameters(parameters); },
    execute(context) {
      const parameters = parseAgreementParameters(context.node.parameters);
      validateAgreementExecutionDesign(context, parameters);
      const input = agreementAnalysisResultInputV1(context.inputs, parameters);
      const pairs = extractAgreementPairsV1(
        parameters,
        { resultType: input.record.resultType, value: input.record.value },
        context.samples,
        context.signal,
      );
      const table = buildAgreementTableV1(parameters, pairs);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: parseAgreementTableV1Envelope({ resultType: 'table', value: table }).value,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{ assumptionId: 'agreement-contract', checkStatus: 'passed' }],
      };
    },
  });
  const v2Implementation = createStatelessAnalysisImplementation({
    identity: AGREEMENT_ANALYSIS_V2_IDENTITY,
    outputSchema: AGREEMENT_TABLE_SCHEMA,
    parseParameters: (parameters) => { parseAgreementParameters(parameters); },
    execute(context) {
      const parameters = parseAgreementParameters(context.node.parameters);
      validateAgreementExecutionDesign(context, parameters);
      const input = agreementAnalysisResultInputV1(context.inputs, parameters);
      const pairs = extractAgreementPairsV1(
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
  return new Map([
    [AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID, v1Implementation],
    [AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID, v2Implementation],
    [AGREEMENT_ANALYSIS_IMPLEMENTATION_ID, implementation],
  ]);
}

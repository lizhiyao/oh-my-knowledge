import { canonicalizeJson } from '../../../eval-core/contracts/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeInput,
} from '../../../eval-core/analysis/index.js';
import type { BootstrapFamilyParameters } from './bootstrap-family-parameters.js';
import { bootstrapFamilySourceSchema } from './bootstrap-family-source-adapter.js';

export type BootstrapFamilyAnalysisResultInput = Extract<
  AnalysisNodeInput,
  { inputKind: 'analysis-result' }
>;

export function bootstrapFamilyAnalysisResultInput(
  inputs: readonly AnalysisNodeInput[],
  parameters: BootstrapFamilyParameters,
): BootstrapFamilyAnalysisResultInput {
  if (inputs.length !== 1 || inputs[0].inputKind !== 'analysis-result') {
    throw new TypeError('Bootstrap family Analysis requires exactly one Analysis result input.');
  }
  const input = inputs[0];
  if (input.referenceId !== parameters.source.analysisResultId) {
    throw new TypeError('Bootstrap source input does not match its sealed parameter binding.');
  }
  if (input.record.resultType !== 'table'
      || canonicalizeJson(input.record.outputSchema)
        !== canonicalizeJson(bootstrapFamilySourceSchema())) {
    throw new TypeError('Bootstrap source input does not match the Composite table schema.');
  }
  return input;
}

export function validateBootstrapExecutionDesign(
  context: Pick<AnalysisNodeExecutionContext, 'sampling' | 'samples'>,
  parameters: BootstrapFamilyParameters,
): void {
  if (context.sampling.experimentalUnit !== 'sample') {
    throw new TypeError('Bootstrap family Analysis requires sample experimental units.');
  }
  const design = parameters.comparisons[0]?.comparisonDesign;
  if (design === 'paired') {
    if (context.sampling.resamplingUnit !== 'paired-block'
        || context.sampling.pairingKey === undefined) {
      throw new TypeError(
        'Paired Bootstrap requires paired-block resampling and an explicit pairingKey.',
      );
    }
  } else if (context.sampling.resamplingUnit !== 'sample') {
    throw new TypeError('Independent or mean-only Bootstrap requires sample resampling.');
  }
  const plannedSampleIds = context.samples.map((sample) => sample.sampleId);
  if (canonicalizeJson(plannedSampleIds) !== canonicalizeJson(parameters.sampleIds)) {
    throw new TypeError('Bootstrap sample order must exactly match the sealed Evaluation plan.');
  }
}

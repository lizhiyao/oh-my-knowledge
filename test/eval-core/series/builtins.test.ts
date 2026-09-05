import { describe, expect, it } from 'vitest';
import {
  createRunStabilityRuntime,
  createRunStabilitySchemaValidators,
  canonicalizeJson,
  digestCanonicalJson,
  type EvaluationSeriesMemberSource,
  type JsonValue,
  type SeriesAnalysisNodeInput,
  type SeriesAnalysisNodeContext,
} from '../../../src/eval-core/index.js';

function member(
  memberId: string,
  replicateIndex: number,
  resultId: string,
  resultType: 'scalar' | 'interval',
  value: JsonValue,
): EvaluationSeriesMemberSource {
  const recordDigest = digestCanonicalJson({ memberId, resultId, resultType, value });
  return {
    reference: { memberId, replicateIndex },
    sources: {
      analysis: {
        bundle: {
          records: [{
            resultId,
            resultType,
            value,
            analysisStatus: 'completed',
            recordDigest,
          }],
        },
      },
    },
  } as unknown as EvaluationSeriesMemberSource;
}

async function analyze(
  members: readonly EvaluationSeriesMemberSource[],
  projection: 'scalar' | 'interval-estimate' = 'scalar',
  planned = members.length,
  inputs?: readonly SeriesAnalysisNodeInput[],
) {
  const runtime = createRunStabilityRuntime();
  const run = await runtime.openRun({
    runId: 'run-stability-test',
    seriesPlanDigest: digestCanonicalJson({ plan: 'test' }),
    bundleId: 'run-stability-bundle',
    nodeId: 'run-stability',
    analysisMode: 'preregistered',
  });
  try {
    return await run.analyze({
      plan: { definition: { seriesId: 'run-stability-series' } },
      node: {
        parameters: {
          sourceAnalysisResultId: 'quality',
          projection,
          coverageMode: 'complete-plan',
        },
      },
      members,
      inputs: inputs ?? [{
        seriesInputKind: 'members',
        referenceId: 'run-stability-series',
        members,
      }],
      coverage: {
        planned,
        completed: members.length,
        partial: 0,
        cancelled: 0,
        budgetExhausted: 0,
        failed: 0,
        missing: planned - members.length,
        comparable: members.length,
      },
      signal: new AbortController().signal,
    } as unknown as SeriesAnalysisNodeContext);
  } finally {
    await run.dispose();
  }
}

describe('Run stability Series builtin', () => {
  it('computes descriptive run-level statistics in canonical replicate order', async () => {
    const output = await analyze([
      member('third', 9, 'quality', 'scalar', 1),
      member('first', 3, 'quality', 'scalar', 1),
      member('second', 7, 'quality', 'scalar', 0),
    ]);

    expect(output).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'table',
      value: {
        experimentalUnit: 'run',
        runCount: 3,
        members: [
          { memberId: 'first', replicateIndex: 3, value: 1 },
          { memberId: 'second', replicateIndex: 7, value: 0 },
          { memberId: 'third', replicateIndex: 9, value: 1 },
        ],
        mean: 2 / 3,
        minimum: 0,
        maximum: 1,
        range: 1,
      },
    });
    if (output.analysisStatus !== 'completed'
        || typeof output.value !== 'object'
        || output.value === null
        || Array.isArray(output.value)) {
      throw new Error('Expected a completed run stability table.');
    }
    expect(output.value.sampleVariance).toBeCloseTo(1 / 3);
    expect(output.value.sampleStandardDeviation).toBeCloseTo(Math.sqrt(1 / 3));
  });

  it('projects interval estimates only when requested and fails closed on missing evidence', async () => {
    await expect(analyze([
      member('first', 0, 'quality', 'interval', { estimate: 0.75, lower: 0.5, upper: 1 }),
      member('second', 1, 'quality', 'interval', { estimate: 0.25, lower: 0, upper: 0.5 }),
    ], 'interval-estimate')).resolves.toMatchObject({
      analysisStatus: 'completed',
      value: { members: [{ value: 0.75 }, { value: 0.25 }], mean: 0.5 },
    });

    await expect(analyze([
      member('first', 0, 'quality', 'scalar', 1),
      member('second', 1, 'different-result', 'scalar', 0),
    ])).resolves.toEqual({
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-source-analysis-evidence-incomplete'],
    });
  });

  it('reports an inconclusive result when finite inputs overflow a statistic', async () => {
    await expect(analyze([
      member('first', 0, 'quality', 'scalar', Number.MAX_VALUE),
      member('second', 1, 'quality', 'scalar', -Number.MAX_VALUE),
    ])).resolves.toEqual({
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-stability-statistic-non-finite'],
    });
  });

  it('requires every preregistered member before publishing stability statistics', async () => {
    await expect(analyze([
      member('first', 0, 'quality', 'scalar', 1),
      member('second', 1, 'quality', 'scalar', 1),
    ], 'scalar', 3)).resolves.toEqual({
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-stability-complete-coverage-required'],
    });
  });

  it('uses only the members input explicitly authorized by the sealed node', async () => {
    const members = [
      member('first', 0, 'quality', 'scalar', 1),
      member('second', 1, 'quality', 'scalar', 0),
    ];
    await expect(analyze(members, 'scalar', 2, [])).resolves.toEqual({
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-stability-input-contract-invalid'],
    });
    await expect(analyze(members, 'scalar', 2, [{
      seriesInputKind: 'members',
      referenceId: 'run-stability-series',
      members,
    }, {
      seriesInputKind: 'members',
      referenceId: 'undeclared-extra-source',
      members,
    }])).resolves.toEqual({
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-stability-input-contract-invalid'],
    });
  });

  it('rejects a stability envelope whose descriptive statistics were altered', async () => {
    const output = await analyze([
      member('first', 0, 'quality', 'scalar', 1),
      member('second', 1, 'quality', 'scalar', 0),
    ]);
    if (output.analysisStatus !== 'completed'
        || typeof output.value !== 'object'
        || output.value === null
        || Array.isArray(output.value)) {
      throw new Error('Expected a completed run stability table.');
    }
    const validator = [...createRunStabilitySchemaValidators().values()][0];
    if (validator === undefined) throw new Error('Expected run stability schema validator.');
    const value = output.value as Readonly<Record<string, JsonValue>>;
    expect(() => validator.parse({
      resultType: output.resultType,
      value: { ...value, mean: 0.9 },
    })).toThrow('exactly recomputable');
  });

  it('round-trips signed-zero statistics through canonical JSON', async () => {
    const output = await analyze([
      member('first', 0, 'quality', 'scalar', -Number.MIN_VALUE),
      member('second', 1, 'quality', 'scalar', 0),
    ]);
    expect(output).toMatchObject({
      analysisStatus: 'completed',
      value: { mean: 0, sampleVariance: 0, sampleStandardDeviation: 0 },
    });
    if (output.analysisStatus !== 'completed') {
      throw new Error('Expected a completed run stability table.');
    }
    const validator = [...createRunStabilitySchemaValidators().values()][0];
    if (validator === undefined) throw new Error('Expected run stability schema validator.');
    const wire = JSON.parse(canonicalizeJson({
      resultType: output.resultType,
      value: output.value,
    }));
    expect(() => validator.parse(wire)).not.toThrow();
  });
});

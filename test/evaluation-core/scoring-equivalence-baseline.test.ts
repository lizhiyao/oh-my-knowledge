import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  runAssertions,
  runAsyncAssertions,
} from '../../src/grading/assertions.js';
import { computeLayeredScores } from '../../src/grading/layered-scores.js';
import { llmJudgeEnsemble, llmJudgeRepeat } from '../../src/grading/judge.js';
import {
  bootstrapDiffCI,
  bootstrapMeanCI,
  bootstrapPairedDiffCI,
} from '../../src/eval-core/bootstrap.js';
import { computeAgreementWithCI } from '../../src/grading/human-gold.js';
import { PROMPT_REGISTRY } from '../../src/shared/llm-prompts/registry.js';
import type {
  Assertion,
  ExecResult,
  ExecutorFn,
  JudgeConfig,
  Sample,
  ToolCallInfo,
} from '../../src/types/index.js';

interface Fixture {
  schemaVersion: string;
  legacyBaseline: {
    commit: string;
    bootstrapSeed: number;
    promptHashes: Record<string, string>;
  };
  deterministicAssertions: {
    output: string;
    context: { toolCalls: ToolCallInfo[] };
    assertions: Assertion[];
    expected: unknown;
    expectedLayered: unknown;
  };
  fixedResponseAssertions: {
    output: string;
    sample: Sample;
    assertions: Assertion[];
    replayScores: number[];
    expected: unknown;
  };
  judgeRepeat: { replayScores: number[]; expected: unknown };
  judgeEnsemble: {
    members: Array<JudgeConfig & { replayScores: number[] }>;
    expected: unknown;
  };
  statistics: {
    control: number[];
    treatment: number[];
    resamples: number;
    alpha: number;
    mean: unknown;
    independentDifference: unknown;
    pairedDifference: unknown;
    degenerate: {
      emptyMean: unknown;
      singletonMean: unknown;
      emptyDifference: unknown;
      singletonPairedDifference: unknown;
      constantAgreement: 'NaN';
    };
    ratings: Array<[number, number]>;
    agreement: unknown;
  };
}

const fixturePath = fileURLToPath(new URL(
  '../fixtures/evaluation-core/scoring-equivalence-v1.json',
  import.meta.url,
));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

function replayExecutor(scores: readonly number[]): ExecutorFn {
  let cursor = 0;
  return async (): Promise<ExecResult> => {
    const score = scores[cursor];
    cursor += 1;
    if (score === undefined) throw new Error('fixed-response replay exhausted');
    return {
      ok: true,
      output: JSON.stringify({
        score,
        reason: `score ${score}`,
        reasoning: `reasoning ${score}`,
      }),
      durationMs: 1,
      durationApiMs: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0.001,
      stopReason: 'end_turn',
      numTurns: 1,
    };
  };
}

describe('Evaluation Core scoring migration legacy baseline', () => {
  it('binds the fixture format and legacy source revision', () => {
    assert.equal(fixture.schemaVersion, 'omk.evaluation-scoring-equivalence-fixture/v1');
    assert.equal(fixture.legacyBaseline.commit, '38648427');
  });

  it('freezes every scoring prompt identity used by the migration', () => {
    const scoringPrompts = PROMPT_REGISTRY.filter((entry) => (
      entry.measurementInvariant
      && entry.module === 'src/shared/llm-prompts/judge-prompts.ts'
    ));
    assert.deepEqual(
      scoringPrompts.map((entry) => entry.promptId).sort(),
      Object.keys(fixture.legacyBaseline.promptHashes).sort(),
    );
    const actual = Object.fromEntries(scoringPrompts
      .map((entry) => [entry.promptId, entry.getHash?.()]));
    assert.deepEqual(actual, fixture.legacyBaseline.promptHashes);
  });

  it('freezes deterministic assertion details and layered aggregation', () => {
    const input = fixture.deterministicAssertions;
    const result = runAssertions(input.output, input.assertions, input.context);
    assert.deepEqual(result, input.expected);
    assert.deepEqual(
      computeLayeredScores({ assertions: result, llmScore: 4 }),
      input.expectedLayered,
    );
  });

  it('freezes semantic and RAG assertions under fixed provider responses', async () => {
    const input = fixture.fixedResponseAssertions;
    const result = await runAsyncAssertions(input.output, input.assertions, {
      executor: replayExecutor(input.replayScores),
      judgeModel: 'fixture:judge',
      sample: input.sample,
      samplesDir: '.',
    });
    assert.deepEqual(result, input.expected);
  });

  it('freezes judge replicate failures, aggregation, and usage', async () => {
    const result = await llmJudgeRepeat({
      output: 'fixture output',
      rubric: 'fixture rubric',
      prompt: 'fixture prompt',
      executor: replayExecutor(fixture.judgeRepeat.replayScores),
      model: 'fixture:judge',
    }, fixture.judgeRepeat.replayScores.length);
    assert.deepEqual(result, fixture.judgeRepeat.expected);
  });

  it('freezes ensemble member aggregation without collapsing member evidence', async () => {
    const executors = Object.fromEntries(fixture.judgeEnsemble.members.map((member) => [
      member.executor,
      replayExecutor(member.replayScores),
    ]));
    const judges = fixture.judgeEnsemble.members.map(({ executor, model }) => ({ executor, model }));
    const result = await llmJudgeEnsemble({
      output: 'fixture output',
      rubric: 'fixture rubric',
      prompt: 'fixture prompt',
      executor: executors[judges[0].executor],
      model: judges[0].model,
    }, judges, (name) => executors[name], 2);
    assert.deepEqual(result, fixture.judgeEnsemble.expected);
  });

  it('freezes bootstrap random stream, pairing, rounding, and alpha scale', () => {
    const input = fixture.statistics;
    const seed = fixture.legacyBaseline.bootstrapSeed;
    const pairs = input.control.map((a, index) => ({ a, b: input.treatment[index] }));
    assert.deepEqual(
      bootstrapMeanCI(input.treatment, input.alpha, input.resamples, seed),
      input.mean,
    );
    assert.deepEqual(
      bootstrapDiffCI(input.control, input.treatment, input.alpha, input.resamples, seed),
      input.independentDifference,
    );
    assert.deepEqual(
      bootstrapPairedDiffCI(pairs, input.alpha, input.resamples, seed),
      input.pairedDifference,
    );
    assert.deepEqual(computeAgreementWithCI(
      input.ratings.map(([coderA, coderB], index) => ({
        unitId: `u${index}`,
        coderA,
        coderB,
      })),
      { samples: input.resamples, seed, alpha: input.alpha },
    ), input.agreement);
  });

  it('freezes statistical behavior for empty, singleton, and constant inputs', () => {
    const input = fixture.statistics;
    const seed = fixture.legacyBaseline.bootstrapSeed;
    assert.deepEqual(
      bootstrapMeanCI([], input.alpha, input.resamples, seed),
      input.degenerate.emptyMean,
    );
    assert.deepEqual(
      bootstrapMeanCI([4], input.alpha, input.resamples, seed),
      input.degenerate.singletonMean,
    );
    assert.deepEqual(
      bootstrapDiffCI([], [4], input.alpha, input.resamples, seed),
      input.degenerate.emptyDifference,
    );
    assert.deepEqual(
      bootstrapPairedDiffCI([{ a: 2, b: 4 }], input.alpha, input.resamples, seed),
      input.degenerate.singletonPairedDifference,
    );
    const constantAgreement = computeAgreementWithCI([
      { unitId: 'u0', coderA: 3, coderB: 3 },
      { unitId: 'u1', coderA: 3, coderB: 3 },
    ], { samples: input.resamples, seed, alpha: input.alpha });
    assert.equal(input.degenerate.constantAgreement, 'NaN');
    assert.ok(Number.isNaN(constantAgreement.alpha));
    assert.ok(Number.isNaN(constantAgreement.alphaCI.low));
    assert.ok(Number.isNaN(constantAgreement.alphaCI.high));
    assert.ok(Number.isNaN(constantAgreement.alphaCI.estimate));
    assert.ok(Number.isNaN(constantAgreement.weightedKappa));
    assert.ok(Number.isNaN(constantAgreement.pearson));
    assert.equal(constantAgreement.sampleCount, 2);
  });
});

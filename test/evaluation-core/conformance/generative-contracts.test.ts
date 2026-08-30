import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestArtifactPayload,
  digestCanonicalJson,
  verifyAnalysisBundle,
  verifyDecisionResult,
  verifyEvaluationBundle,
  verifyExecutionBundle,
  type AnalysisBundle,
  type DecisionResult,
  type EvaluationBundle,
  type EvaluationDefinition,
  type ExecutionBundle,
  type JsonValue,
  type MeasurementPolicy,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import { createBuiltinAnalysisSchemaValidators } from '../../../src/evaluation-core/analysis/index.js';
import { testRuntime, validDefinition, validPolicy } from '../compiler/fixtures.js';
import { runConformanceScenario } from './harness.js';

const GENERATOR_SEED = 0x5eed_0441;
const STAGE_DIGEST_FIELDS = {
  execution: 'executionPlanDigest',
  evaluation: 'evaluationPlanDigest',
  analysis: 'analysisPlanDigest',
  decision: 'decisionPlanDigest',
  run: 'runContractDigest',
} as const;

type Stage = keyof typeof STAGE_DIGEST_FIELDS;
type Generator = () => number;

function generator(seed: number): Generator {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function integer(random: Generator, maximum: number): number {
  return Math.floor(random() * maximum);
}

function shuffle<Value>(values: readonly Value[], random: Generator): Value[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = integer(random, index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function generatedJson(random: Generator, depth = 0): JsonValue {
  const scalar = (): JsonValue => {
    switch (integer(random, 4)) {
      case 0: return null;
      case 1: return random() >= 0.5;
      case 2: return integer(random, 20_001) - 10_000;
      default: return `value-${integer(random, 1_000_000).toString(36)}`;
    }
  };
  if (depth >= 3) return scalar();
  const shape = integer(random, 4);
  if (shape === 0) return scalar();
  if (shape === 1) {
    return Array.from(
      { length: 1 + integer(random, 4) },
      () => generatedJson(random, depth + 1),
    );
  }
  const result: Record<string, JsonValue> = {};
  const size = 1 + integer(random, 5);
  for (let index = 0; index < size; index += 1) {
    result[`k-${depth}-${index}-${integer(random, 1_000).toString(36)}`] = generatedJson(
      random,
      depth + 1,
    );
  }
  return result;
}

function permutePropertyOrder(value: JsonValue, random: Generator): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => permutePropertyOrder(entry, random));
  }
  if (value === null || typeof value !== 'object') return value;
  const original = Object.entries(value).map(([key, entry]) => (
    [key, permutePropertyOrder(entry, random)] as const
  ));
  const permuted = shuffle(original, random);
  if (permuted.length > 1
      && permuted.every(([key], index) => key === original[index][0])) {
    permuted.push(permuted.shift() as typeof permuted[number]);
  }
  return Object.fromEntries(permuted);
}

async function compile(
  mutate?: (definition: EvaluationDefinition, policy: MeasurementPolicy) => void,
) {
  const definition = validDefinition();
  const policy = validPolicy();
  mutate?.(definition, policy);
  return prepareEvaluationPlan(definition, policy, testRuntime());
}

function expectStageChanges(
  before: Awaited<ReturnType<typeof compile>>,
  after: Awaited<ReturnType<typeof compile>>,
  changed: readonly Stage[],
  label: string,
): void {
  for (const [stage, field] of Object.entries(STAGE_DIGEST_FIELDS) as Array<[
    Stage,
    typeof STAGE_DIGEST_FIELDS[Stage],
  ]>) {
    if (changed.includes(stage)) {
      expect(after.digests[field], `${label}: ${stage} must change`).not.toBe(
        before.digests[field],
      );
    } else {
      expect(after.digests[field], `${label}: ${stage} must remain stable`).toBe(
        before.digests[field],
      );
    }
  }
}

function foreignDigest(random: Generator): Sha256Digest {
  const alphabet = '0123456789abcdef';
  const hex = Array.from({ length: 64 }, () => alphabet[integer(random, alphabet.length)]).join('');
  return `sha256:${hex}`;
}

function resealExecutionBundle(
  source: ExecutionBundle,
  mutate: (draft: ExecutionBundle) => void,
): ExecutionBundle {
  const draft = structuredClone(source);
  mutate(draft);
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
}

function resealEvaluationBundle(
  source: EvaluationBundle,
  mutate: (draft: EvaluationBundle) => void,
): EvaluationBundle {
  const draft = structuredClone(source);
  mutate(draft);
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
}

function resealAnalysisBundle(
  source: AnalysisBundle,
  mutate: (draft: AnalysisBundle) => void,
): AnalysisBundle {
  const draft = structuredClone(source);
  mutate(draft);
  for (const record of draft.records) {
    const payload: Record<string, unknown> = { ...record };
    delete payload.recordDigest;
    record.recordDigest = digestCanonicalJson(payload);
  }
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
}

function resealDecisionResult(
  source: DecisionResult,
  mutate: (draft: DecisionResult) => void,
): DecisionResult {
  const draft = structuredClone(source);
  mutate(draft);
  const payload: Record<string, unknown> = { ...draft };
  delete payload.decisionDigest;
  draft.decisionDigest = digestCanonicalJson(payload);
  return draft;
}

function expectSemanticRejection(verify: () => unknown, label: string): void {
  let failure: unknown;
  try {
    verify();
  } catch (error) {
    failure = error;
  }
  expect(failure, label).toBeInstanceOf(Error);
  const code = failure !== null
      && typeof failure === 'object'
      && 'code' in failure
      && typeof failure.code === 'string'
    ? failure.code
    : undefined;
  expect(code, `${label}: rejection must use a structured contract code`).toBeDefined();
  expect(code, `${label}: fully resealed input must pass digest verification`).not.toContain(
    'DIGEST_MISMATCH',
  );
}

describe('Evaluation Core fixed-seed generative contract guards', () => {
  it('keeps canonical JSON and plan digests invariant under generated property permutations', async () => {
    const random = generator(GENERATOR_SEED);
    for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
      const value = generatedJson(random);
      const permuted = permutePropertyOrder(value, random);
      const label = `seed=${GENERATOR_SEED}, canonical-case=${caseIndex}`;
      expect(canonicalizeJson(permuted), label).toBe(canonicalizeJson(value));
      expect(digestCanonicalJson(permuted), label).toBe(digestCanonicalJson(value));
    }

    for (let caseIndex = 0; caseIndex < 12; caseIndex += 1) {
      const value = { payload: generatedJson(random), caseIndex } satisfies JsonValue;
      const permuted = permutePropertyOrder(value, random);
      const before = await compile((definition) => {
        definition.dataset.samples[0].input = value;
      });
      const after = await compile((definition) => {
        definition.dataset.samples[0].input = permuted;
      });
      const label = `seed=${GENERATOR_SEED}, plan-order-case=${caseIndex}`;
      expect(JSON.stringify(permuted), `${label}: property order must change`).not.toBe(
        JSON.stringify(value),
      );
      expect(after.digests, label).toEqual(before.digests);
    }
  });

  it('invalidates exactly the owning stage and downstream for generated single changes', async () => {
    const random = generator(GENERATOR_SEED ^ 0x1a11_da7a);
    const baseline = await compile();
    const stages = shuffle([
      'annotation',
      'execution',
      'evaluation',
      'analysis',
      'decision',
      'run',
    ] as const, random);

    for (let caseIndex = 0; caseIndex < 30; caseIndex += 1) {
      const mutationKind = stages[caseIndex % stages.length];
      const value = 1 + integer(random, 1_000_000);
      const changed: readonly Stage[] = mutationKind === 'annotation'
        ? []
        : mutationKind === 'execution'
          ? ['execution', 'evaluation', 'analysis', 'decision', 'run']
          : mutationKind === 'evaluation'
            ? ['evaluation', 'analysis', 'decision', 'run']
            : mutationKind === 'analysis'
              ? ['analysis', 'decision', 'run']
              : mutationKind === 'decision'
                ? ['decision', 'run']
                : ['run'];
      const after = await compile((definition, policy) => {
        if (mutationKind === 'annotation') {
          definition.dataset.samples[0].annotations = { generatedCase: value };
        } else if (mutationKind === 'execution') {
          definition.dataset.samples[0].input = {
            ...(definition.dataset.samples[0].input as Record<string, JsonValue>),
            generatedCase: value,
          };
        } else if (mutationKind === 'evaluation') {
          definition.dataset.samples[0].expected = { answer: `generated-${value}` };
        } else if (mutationKind === 'analysis') {
          definition.analysisGraph.nodes[0].parameters = {
            minimumCoverage: 0.1 + (value % 6) / 10,
          };
        } else if (mutationKind === 'decision') {
          definition.decisionPolicy!.parameters = {
            threshold: 0.01 + (value % 90) / 100,
          };
        } else {
          const writerMode = value % 2 === 0 ? 'optional' : 'required';
          policy.eventDelivery = {
            writerMode,
            backpressureMode: 'block',
            writerFailureMode: writerMode === 'required' || value % 3 === 0
              ? 'fail-run'
              : 'ignore',
          };
        }
      });
      const label = `seed=${GENERATOR_SEED}, invalidation-case=${caseIndex}, kind=${mutationKind}`;
      expectStageChanges(baseline, after, changed, label);
      if (mutationKind === 'annotation') {
        expect(after.digests.datasetRevisionDigest, label).not.toBe(
          baseline.digests.datasetRevisionDigest,
        );
      }
    }
  });

  it('fails closed for generated, fully resealed artifact contradictions', async () => {
    const random = generator(GENERATOR_SEED ^ 0xfa11_c105);
    const result = await runConformanceScenario('function', {
      suffix: 'generative-fail-closed',
    });
    if (result.decision === undefined) throw new Error('Expected a Decision artifact.');

    const contradictions = [
      {
        name: 'terminal-state',
        verify: () => verifyExecutionBundle(resealExecutionBundle(
          result.execution,
          (draft) => {
            draft.executionBundleStatus = 'completed';
            draft.terminationReasonCode = 'generated-status-contradiction';
          },
        ), result.plan),
      },
      {
        name: 'coverage',
        verify: () => verifyExecutionBundle(resealExecutionBundle(
          result.execution,
          (draft) => {
            draft.coverage.succeeded -= 1;
            draft.coverage.failed += 1;
          },
        ), result.plan),
      },
      {
        name: 'parent',
        verify: () => verifyEvaluationBundle(resealEvaluationBundle(
          result.evaluation,
          (draft) => { draft.executionBundleDigest = foreignDigest(random); },
        ), result.plan, result.executionSource),
      },
      {
        name: 'provenance',
        verify: () => verifyExecutionBundle(resealExecutionBundle(
          result.execution,
          (draft) => { draft.provenance.parentDigests = [foreignDigest(random)]; },
        ), result.plan),
      },
      {
        name: 'cache',
        verify: () => verifyExecutionBundle(resealExecutionBundle(
          result.execution,
          (draft) => {
            const record = draft.records.find((entry) => entry.executionStatus === 'completed');
            if (record?.executionStatus !== 'completed') throw new Error('Missing active record.');
            record.cache = {
              cacheStatus: 'transparent-hit',
              cacheKeyDigest: foreignDigest(random),
              sourceRecordDigest: foreignDigest(random),
            };
          },
        ), result.plan),
      },
      {
        name: 'runtime-identity',
        verify: () => verifyExecutionBundle(resealExecutionBundle(
          result.execution,
          (draft) => {
            const record = draft.records.find((entry) => entry.executionStatus === 'completed');
            if (record?.executionStatus !== 'completed') throw new Error('Missing active record.');
            record.runtime.fingerprint = `generated-${integer(random, 1_000_000)}`;
          },
        ), result.plan),
      },
      {
        name: 'runtime-dependencies',
        verify: () => verifyAnalysisBundle(resealAnalysisBundle(
          result.analysis,
          (draft) => { draft.records[0].runtimeDependencies = []; },
        ), result.plan, result.executionSource, result.evaluationSource, {
          schemaValidators: createBuiltinAnalysisSchemaValidators(),
        }),
      },
      {
        name: 'decision-parent',
        verify: () => verifyDecisionResult(resealDecisionResult(
          result.decision as DecisionResult,
          (draft) => { draft.analysisBundleDigest = foreignDigest(random); },
        ), result.plan, result.executionSource, result.evaluationSource, result.analysisSource),
      },
    ];

    for (const [caseIndex, contradiction] of shuffle(contradictions, random).entries()) {
      expectSemanticRejection(
        contradiction.verify,
        `seed=${GENERATOR_SEED}, contradiction-case=${caseIndex}, kind=${contradiction.name}`,
      );
    }
  });
});

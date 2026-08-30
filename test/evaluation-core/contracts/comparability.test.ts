import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  COMPARABILITY_POLICY_SCHEMA_VERSION,
  ComparabilityPolicySchema,
  assessComparability,
  createComparabilityPolicy,
  computeRuntimeIdentityDigest,
  digestArtifactPayload,
  digestCanonicalJson,
  parseComparabilityAssessment,
  parseComparabilityAssessmentDocument,
  parseComparabilityPolicyDocument,
  parseEvaluationBundle,
  parseExecutionBundle,
  type ComparabilityPolicy,
  type ComparabilitySourcePrefix,
  type ExecutionBundle,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type SealedRunPlan,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../compiler/fixtures.js';
import {
  runConformanceScenario,
  type ConformanceResult,
} from '../conformance/harness.js';

type PlanMutation = (
  definition: ReturnType<typeof validDefinition>,
  measurementPolicy: ReturnType<typeof validPolicy>,
) => void;

async function preparePlan(
  mutate?: PlanMutation,
  runtimeOptions: Parameters<typeof testRuntime>[0] = {},
): Promise<SealedRunPlan> {
  const definition = validDefinition();
  const measurementPolicy = validPolicy();
  mutate?.(definition, measurementPolicy);
  return prepareEvaluationPlan(definition, measurementPolicy, testRuntime(runtimeOptions));
}

function policy(
  scope: ComparabilityPolicy['comparisonScope'] = 'evaluation',
): ComparabilityPolicy {
  return createComparabilityPolicy({
    schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
    designMode: 'exact-measurement-design',
    comparisonScope: scope,
    subjects: [{
      subjectId: 'candidate',
      leftTargetId: 'treatment',
      rightTargetId: 'treatment',
    }],
  });
}

function reasonCodes(source: ReturnType<typeof assessComparability>): string[] {
  return source.assessment.reasons.map((reason) => reason.reasonCode);
}

function sourcePrefix(result: ConformanceResult): ComparabilitySourcePrefix {
  return {
    execution: result.executionSource,
    evaluation: result.evaluationSource,
    analysis: result.analysisSource,
    ...(result.decisionSource === undefined ? {} : { decision: result.decisionSource }),
  };
}

describe('Evaluation Core comparability contract', () => {
  it('creates a canonical content-addressed policy and rejects ambiguous mappings', () => {
    const value = createComparabilityPolicy({
      schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
      designMode: 'exact-measurement-design',
      comparisonScope: 'analysis',
      subjects: [
        { subjectId: 'z', leftTargetId: 'left-z', rightTargetId: 'right-z' },
        { subjectId: 'a', leftTargetId: 'left-a', rightTargetId: 'right-a' },
      ],
    });

    expect(value.subjects.map((subject) => subject.subjectId)).toEqual(['a', 'z']);
    expect(parseComparabilityPolicyDocument(structuredClone(value))).toEqual(value);
    expect(() => parseComparabilityPolicyDocument({
      ...structuredClone(value),
      policyDigest: `sha256:${'0'.repeat(64)}`,
    })).toThrowError(expect.objectContaining({
      code: 'COMPARABILITY_POLICY_DIGEST_MISMATCH',
    }));
    expect(ComparabilityPolicySchema.safeParse({
      ...structuredClone(value),
      subjects: [
        { subjectId: 'a', leftTargetId: 'same', rightTargetId: 'right-a' },
        { subjectId: 'z', leftTargetId: 'same', rightTargetId: 'right-z' },
      ],
    }).success).toBe(false);
    expect(ComparabilityPolicySchema.safeParse({
      ...structuredClone(value),
      subjects: [
        { subjectId: 'same', leftTargetId: 'left-a', rightTargetId: 'right-a' },
        { subjectId: 'same', leftTargetId: 'left-z', rightTargetId: 'right-z' },
      ],
    }).success).toBe(false);
  });

  it('keeps declared subject change compatible while rejecting undeclared drift', async () => {
    const baseline = await preparePlan();
    const subjectChanged = await preparePlan((definition) => {
      definition.targets[1].config = { release: 'candidate' };
    });
    const undeclaredChanged = await preparePlan((definition) => {
      definition.targets[0].config = { release: 'changed-control' };
    });

    const declared = assessComparability(policy(), baseline, subjectChanged);
    expect(declared.assessment.designStatus).toBe('compatible');
    expect(declared.assessment.comparabilityStatus).toBe('conditional');
    expect(reasonCodes(declared)).toContain(
      'comparability-identity-declared-subject-change',
    );
    expect(reasonCodes(declared)).not.toContain(
      'comparability-design-undeclared-subject-change',
    );

    const undeclared = assessComparability(policy(), baseline, undeclaredChanged);
    expect(undeclared.assessment.designStatus).toBe('incompatible');
    expect(reasonCodes(undeclared)).toContain(
      'comparability-design-undeclared-subject-change',
    );

    const runtimeChanged = await preparePlan(undefined, {
      executorFingerprint: 'different-executor-fingerprint',
    });
    const allTargetsPolicy = createComparabilityPolicy({
      schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
      designMode: 'exact-measurement-design',
      comparisonScope: 'evaluation',
      subjects: [
        { subjectId: 'control', leftTargetId: 'control', rightTargetId: 'control' },
        { subjectId: 'candidate', leftTargetId: 'treatment', rightTargetId: 'treatment' },
      ],
    });
    const runtimeAssessment = assessComparability(
      allTargetsPolicy,
      baseline,
      runtimeChanged,
    );
    expect(runtimeAssessment.assessment.designStatus).toBe('compatible');
    expect(reasonCodes(runtimeAssessment)).toContain(
      'comparability-identity-declared-subject-change',
    );
  });

  it('fails closed when a subject mapping does not resolve on both sides', async () => {
    const plan = await preparePlan();
    const invalidPolicy = createComparabilityPolicy({
      schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
      designMode: 'exact-measurement-design',
      comparisonScope: 'evaluation',
      subjects: [{
        subjectId: 'candidate',
        leftTargetId: 'treatment',
        rightTargetId: 'missing-target',
      }],
    });

    const assessment = assessComparability(invalidPolicy, plan, plan);
    expect(assessment.assessment.designStatus).toBe('incompatible');
    expect(reasonCodes(assessment)).toContain(
      'comparability-design-subject-mapping-invalid',
    );
  });

  it('implements the normative evaluation and randomization change matrix', async () => {
    const baseline = await preparePlan();
    const cases: Array<{
      mutate: PlanMutation;
      reasonCode: string;
    }> = [
      {
        mutate: (definition) => {
          definition.dataset.samples[0].expected = { answer: 'different' };
        },
        reasonCode: 'comparability-design-evaluation-input-mismatch',
      },
      {
        mutate: (definition) => {
          definition.evaluators[0].config = { rubricVersion: 2 };
        },
        reasonCode: 'comparability-design-evaluation-instrument-mismatch',
      },
      {
        mutate: (definition) => {
          definition.experiment.seed = 'different-root-seed';
        },
        reasonCode: 'comparability-design-sampling-mismatch',
      },
      {
        mutate: (_definition, measurementPolicy) => {
          measurementPolicy.eventDelivery.writerMode = 'optional';
        },
        reasonCode: 'comparability-design-projection-mismatch',
      },
    ];

    for (const entry of cases) {
      const changed = await preparePlan(entry.mutate);
      const assessment = assessComparability(policy(), baseline, changed);
      expect(assessment.assessment.designStatus).toBe('incompatible');
      expect(reasonCodes(assessment)).toContain(entry.reasonCode);
    }

    const uncontrolled = await preparePlan((definition) => {
      definition.experiment.sampling.seedCoupling = 'uncontrolled';
    }, { deterministic: false, seedControl: 'unsupported' });
    const uncontrolledAssessment = assessComparability(policy(), uncontrolled, uncontrolled);
    expect(reasonCodes(uncontrolledAssessment)).toContain(
      'comparability-design-randomization-mismatch',
    );
  });

  it('keeps analysis and decision changes outside earlier scopes', async () => {
    const baseline = await preparePlan();
    const analysisChanged = await preparePlan((definition) => {
      definition.analysisGraph.nodes[0].parameters = { minimumCoverage: 0.9 };
    });
    const comparisonChanged = await preparePlan((definition) => {
      definition.comparisons[0].comparisonId = 'renamed-comparison';
    });
    const decisionChanged = await preparePlan((definition) => {
      if (definition.decisionPolicy === undefined) throw new Error('missing policy');
      definition.decisionPolicy.parameters = { threshold: 0.2 };
    });
    const estimatorChanged = await preparePlan((definition) => {
      definition.experiment.sampling.estimatorId = 'bootstrap.other-estimator/v1';
    });

    expect(assessComparability(
      policy('evaluation'), baseline, analysisChanged,
    ).assessment.designStatus).toBe('compatible');
    expect(reasonCodes(assessComparability(
      policy('analysis'), baseline, analysisChanged,
    ))).toContain('comparability-design-analysis-mismatch');
    expect(reasonCodes(assessComparability(
      policy('analysis'), baseline, comparisonChanged,
    ))).toContain('comparability-design-comparison-mismatch');
    expect(assessComparability(
      policy('analysis'), baseline, decisionChanged,
    ).assessment.designStatus).toBe('compatible');
    expect(assessComparability(
      policy('evaluation'), baseline, estimatorChanged,
    ).assessment.designStatus).toBe('compatible');
    expect(reasonCodes(assessComparability(
      policy('analysis'), baseline, estimatorChanged,
    ))).toContain('comparability-design-analysis-mismatch');
    expect(reasonCodes(assessComparability(
      policy('decision'), baseline, decisionChanged,
    ))).toContain('comparability-design-decision-mismatch');

    const extensionNamespace = 'urn:example:analysis-extension';
    const extensionDigest = digestCanonicalJson({ schema: 'analysis-extension/v1' });
    const withExtension = async (version: number): Promise<SealedRunPlan> => preparePlan(
      (definition) => {
        definition.extensions = {
          [extensionNamespace]: {
            schemaUri: 'urn:example:analysis-extension-schema',
            schemaDigest: extensionDigest,
            data: { version },
          },
        };
      },
      { extensionStages: { [extensionNamespace]: 'analysis' } },
    );
    const extensionLeft = await withExtension(1);
    const extensionRight = await withExtension(2);
    expect(assessComparability(
      policy('evaluation'), extensionLeft, extensionRight,
    ).assessment.designStatus).toBe('compatible');
    expect(reasonCodes(assessComparability(
      policy('analysis'), extensionLeft, extensionRight,
    ))).toContain('comparability-design-schema-mismatch');

    const withoutDecision = await preparePlan((definition) => {
      delete definition.decisionPolicy;
    });
    expect(assessComparability(
      policy('decision'), withoutDecision, withoutDecision,
    ).assessment.designStatus).toBe('compatible');
  });

  it('treats comparison-family identity as Analysis design rather than Decision policy', async () => {
    const scenario = (primaryHypothesisId: string) => runConformanceScenario('function', {
      suffix: `comparability-${primaryHypothesisId}`,
      mutate(definition) {
        definition.comparisons.push({
          ...structuredClone(definition.comparisons[0]),
          comparisonId: 'secondary-comparison',
        });
        definition.analysisGraph.nodes = [
          {
            analysisNodeKind: 'estimator',
            nodeId: 'hypothesis-primary',
            implementationId: 'conformance.hypothesis/v1',
            inputs: [
              { inputKind: 'metric-observations', referenceId: 'correct' },
              {
                inputKind: 'comparison',
                referenceId: 'control-vs-treatment',
                treatmentTargetId: 'treatment',
                metricId: 'correct',
              },
            ],
            outputResultId: 'hypothesis-primary-result',
            parameters: {},
          },
          {
            analysisNodeKind: 'estimator',
            nodeId: 'hypothesis-secondary',
            implementationId: 'conformance.hypothesis/v1',
            inputs: [
              { inputKind: 'metric-observations', referenceId: 'correct' },
              {
                inputKind: 'comparison',
                referenceId: 'secondary-comparison',
                treatmentTargetId: 'treatment',
                metricId: 'correct',
              },
            ],
            outputResultId: 'hypothesis-secondary-result',
            parameters: {},
          },
          {
            analysisNodeKind: 'correction',
            nodeId: 'bonferroni-family',
            implementationId: 'bonferroni/v1',
            inputs: [
              { inputKind: 'analysis-result', referenceId: 'hypothesis-primary-result' },
              { inputKind: 'analysis-result', referenceId: 'hypothesis-secondary-result' },
            ],
            outputResultId: 'corrected-family',
            parameters: { alpha: 0.05 },
          },
        ];
        definition.decisionPolicy = {
          decisionPolicyId: 'family-gate',
          implementationId: 'conformance.family-gate/v1',
          analysisResultIds: ['corrected-family'],
          comparisonFamily: [
            {
              comparisonId: 'control-vs-treatment',
              treatmentTargetId: 'treatment',
              metricId: 'correct',
              analysisResultId: 'hypothesis-primary-result',
              hypothesisId: primaryHypothesisId,
            },
            {
              comparisonId: 'secondary-comparison',
              treatmentTargetId: 'treatment',
              metricId: 'correct',
              analysisResultId: 'hypothesis-secondary-result',
              hypothesisId: 'hypothesis-secondary',
            },
          ],
          multipleComparisonPolicyId: 'bonferroni/v1',
          minimumEvidenceStatus: 'complete',
          parameters: {},
        };
      },
    });
    const [left, right] = await Promise.all([
      scenario('hypothesis-primary'),
      scenario('hypothesis-primary-v2'),
    ]);

    expect(assessComparability(
      policy('evaluation'), left.plan, right.plan,
    ).assessment.designStatus).toBe('compatible');
    const analysis = assessComparability(policy('analysis'), left.plan, right.plan);
    expect(analysis.assessment.designStatus).toBe('incompatible');
    expect(reasonCodes(analysis)).toContain('comparability-design-comparison-mismatch');
    const decision = assessComparability(policy('decision'), left.plan, right.plan);
    expect(reasonCodes(decision)).toContain('comparability-design-comparison-mismatch');
    expect(reasonCodes(decision)).not.toContain('comparability-design-decision-mismatch');
  });

  it('upgrades Runtime assurance only through an exact trusted attestation map', async () => {
    const plan = await preparePlan(undefined, { executorAssurance: 'declared' });
    const unverified = assessComparability(policy(), plan, plan);
    expect(reasonCodes(unverified)).toContain(
      'comparability-evidence-assurance-unverified',
    );

    const executor = plan.execution.runtimes[0];
    const identityDigest = computeRuntimeIdentityDigest(
      executor.identity as unknown as Parameters<typeof computeRuntimeIdentityDigest>[0],
    );
    const verified = assessComparability(
      policy(),
      plan,
      plan,
      undefined,
      undefined,
      {
        verifiedRuntimeAttestations: new Map([[
          identityDigest,
          {
            attestationDigest: digestCanonicalJson({ identityDigest, verifier: 'host' }),
            verifiedAssuranceLevel: 'verified',
          },
        ]]),
      },
    );
    expect(reasonCodes(verified)).not.toContain(
      'comparability-evidence-assurance-unverified',
    );
    expect(verified.assessment.left.runtimeQualification[0]).toMatchObject({
      effectiveAssuranceLevel: 'verified',
    });

    const attestationDigest = digestCanonicalJson({ identityDigest, verifier: 'other-realm' });
    const crossRealmMap = runInNewContext(
      'new Map([[identityDigest, attestation]])',
      {
        identityDigest,
        attestation: {
          attestationDigest,
          verifiedAssuranceLevel: 'verified',
        },
      },
    ) as ReadonlyMap<Sha256Digest, {
      attestationDigest: Sha256Digest;
      verifiedAssuranceLevel: 'verified';
    }>;
    expect(crossRealmMap).not.toBeInstanceOf(Map);
    const crossRealmVerified = assessComparability(
      policy(),
      plan,
      plan,
      undefined,
      undefined,
      { verifiedRuntimeAttestations: crossRealmMap },
    );
    expect(crossRealmVerified.assessment.left.runtimeQualification[0]).toMatchObject({
      effectiveAssuranceLevel: 'verified',
      verifiedByAttestationDigest: attestationDigest,
    });
  });

  it('conditions only on opaque invariant Runtime identities', async () => {
    const invariantOpaque = await preparePlan(undefined, {
      evaluatorFingerprintBasis: 'opaque',
    });
    expect(reasonCodes(assessComparability(
      policy(), invariantOpaque, invariantOpaque,
    ))).toContain('comparability-evidence-runtime-identity-opaque');

    const subjectOpaque = await preparePlan(undefined, {
      executorFingerprintBasis: 'opaque',
    });
    const allTargetsPolicy = createComparabilityPolicy({
      schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
      designMode: 'exact-measurement-design',
      comparisonScope: 'evaluation',
      subjects: [
        { subjectId: 'control', leftTargetId: 'control', rightTargetId: 'control' },
        { subjectId: 'candidate', leftTargetId: 'treatment', rightTargetId: 'treatment' },
      ],
    });
    expect(reasonCodes(assessComparability(
      allTargetsPolicy, subjectOpaque, subjectOpaque,
    ))).not.toContain('comparability-evidence-runtime-identity-opaque');
  });

  it('ignores annotations and JSON property insertion order', async () => {
    const baseline = await preparePlan();
    const reordered = await preparePlan((definition) => {
      definition.dataset.annotations = { changed: true };
      definition.dataset.samples[0].annotations = { owner: 'different' };
      definition.dataset.samples[0].input = { cohort: 'a', question: 'Q' };
    });

    const assessment = assessComparability(policy('decision'), baseline, reordered);
    expect(assessment.assessment.designStatus).toBe('compatible');
    expect(reasonCodes(assessment).filter((code) => code.includes('-design-'))).toEqual([]);
  });

  it('distinguishes missing, indeterminate, and untrusted source evidence', async () => {
    const result = await runConformanceScenario('function', { suffix: 'comparability' });
    const missing = assessComparability(policy(), result.plan, result.plan);
    expect(reasonCodes(missing)).toContain('comparability-evidence-source-absent');

    const verified = assessComparability(
      policy(),
      result.plan,
      result.plan,
      { execution: result.executionSource, evaluation: result.evaluationSource },
      { execution: result.executionSource, evaluation: result.evaluationSource },
    );
    expect(verified.assessment.evidenceQualificationStatus).toBe('verified');
    expect(verified.assessment.comparabilityStatus).toBe('compatible');

    const transportedExecution = parseExecutionBundle(
      structuredClone(result.execution),
      result.plan,
    );
    const transportedEvaluation = parseEvaluationBundle(
      structuredClone(result.evaluation),
      result.plan,
      transportedExecution,
    );
    const indeterminate = assessComparability(
      policy(),
      result.plan,
      result.plan,
      { execution: transportedExecution, evaluation: transportedEvaluation },
      { execution: transportedExecution, evaluation: transportedEvaluation },
    );
    expect(reasonCodes(indeterminate)).toContain(
      'comparability-evidence-verification-indeterminate',
    );

    const untrustedDocument = structuredClone(result.execution) as ExecutionBundle;
    untrustedDocument.provenance.trust = 'untrusted';
    untrustedDocument.bundleDigest = digestArtifactPayload(
      untrustedDocument,
      'bundleDigest',
    );
    const untrustedExecution = parseExecutionBundle(untrustedDocument, result.plan);
    const untrusted = assessComparability(
      policy(),
      result.plan,
      result.plan,
      { execution: untrustedExecution },
      { execution: untrustedExecution },
    );
    expect(untrusted.assessment.evidenceQualificationStatus).toBe('rejected');
    expect(untrusted.assessment.comparabilityStatus).toBe('incompatible');
    expect(reasonCodes(untrusted)).toContain('comparability-evidence-source-untrusted');
  });

  it('requires plan-aware recomputation before a transported assessment is authoritative', async () => {
    const result = await runConformanceScenario('function', { suffix: 'transport' });
    const original = assessComparability(
      policy('decision'),
      result.plan,
      result.plan,
      sourcePrefix(result),
      sourcePrefix(result),
    );
    const parsed = parseComparabilityAssessment(
      structuredClone(original.assessment),
      policy('decision'),
      result.plan,
      result.plan,
      sourcePrefix(result),
      sourcePrefix(result),
    );
    expect(parsed.assessment).toEqual(original.assessment);

    const forged = structuredClone(original.assessment);
    forged.left.planDigests.datasetRevisionDigest = `sha256:${'f'.repeat(64)}`;
    const candidatePayload = { ...forged.left };
    delete (candidatePayload as Partial<typeof candidatePayload>).candidateDigest;
    forged.left.candidateDigest = digestCanonicalJson(candidatePayload);
    const assessmentPayload = { ...forged };
    delete (assessmentPayload as Partial<typeof assessmentPayload>).assessmentDigest;
    forged.assessmentDigest = digestCanonicalJson(assessmentPayload);
    expect(parseComparabilityAssessmentDocument(forged)).toEqual(forged);
    expect(() => parseComparabilityAssessment(
      forged,
      policy('decision'),
      result.plan,
      result.plan,
      sourcePrefix(result),
      sourcePrefix(result),
    )).toThrowError(expect.objectContaining({
      code: 'COMPARABILITY_ASSESSMENT_RECOMPUTATION_MISMATCH',
    }));

    const duplicateArtifact = structuredClone(original.assessment);
    const extraDigest = `sha256:${'e'.repeat(64)}`;
    duplicateArtifact.left.artifacts.push({
      stage: 'execution',
      artifactDigest: extraDigest,
    });
    const stageOrder = { execution: 0, evaluation: 1, analysis: 2, decision: 3 } as const;
    duplicateArtifact.left.artifacts.sort((left, right) => (
      stageOrder[left.stage] - stageOrder[right.stage]
      || left.artifactDigest.localeCompare(right.artifactDigest)
    ));
    expect(() => parseComparabilityAssessmentDocument(duplicateArtifact)).toThrow();
  });

  it('rejects malformed verification context and source-prefix holes', async () => {
    const result = await runConformanceScenario('function', { suffix: 'fail-closed' });
    expect(() => assessComparability(
      policy(),
      result.plan,
      result.plan,
      { evaluation: result.evaluationSource },
    )).toThrowError(expect.objectContaining({ code: 'COMPARABILITY_SOURCE_PREFIX_INVALID' }));
    expect(() => assessComparability(
      policy(),
      result.plan,
      result.plan,
      undefined,
      undefined,
      {
        verifiedRuntimeAttestations: new Map([[
          `sha256:${'1'.repeat(64)}` as Sha256Digest,
          {
            attestationDigest: 'invalid' as Sha256Digest,
            verifiedAssuranceLevel: 'verified',
          },
        ]]),
      },
    )).toThrowError(expect.objectContaining({
      code: 'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
    }));
  });
});

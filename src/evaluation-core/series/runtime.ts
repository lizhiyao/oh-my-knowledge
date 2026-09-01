import { z } from 'zod';
import {
  AssumptionCheckSchema,
  EVALUATION_SERIES_REPORT_SCHEMA_VERSION,
  SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
  SeriesAnalysisRecordSchema,
  SeriesDecisionResultSchema,
  assertEvaluationSeriesMemberSource,
  canonicalizeJson,
  createComparabilityPolicy,
  assessComparability,
  deepFreezeCanonicalJson,
  deriveSeriesMemberCoverage,
  digestCanonicalJson,
  digestSeriesArtifact,
  parseEvaluationSeriesPlan,
  parseEvaluationSeriesReportDocument,
  parseSeriesAnalysisBundleDocument,
  parseWireDocument,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type EvaluationError,
  type EvaluationSeriesMemberSource,
  type EvaluationSeriesPlan,
  type EvaluationSeriesReport,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
  type SeriesAnalysisBundle,
  type SeriesAnalysisRecord,
  type SeriesComparabilityAssessment,
  type SeriesDecisionResult,
  type Sha256Digest,
} from '../contracts/index.js';

export interface SeriesAnalysisNodeContext {
  readonly plan: EvaluationSeriesPlan;
  readonly node: EvaluationSeriesPlan['definition']['analysisGraph']['nodes'][number];
  readonly members: readonly EvaluationSeriesMemberSource[];
  readonly coverage: SeriesAnalysisBundle['coverage'];
  readonly inputs: readonly SeriesAnalysisNodeInput[];
}

export type SeriesAnalysisNodeInput = {
  readonly seriesInputKind: 'members';
  readonly referenceId: string;
  readonly members: readonly EvaluationSeriesMemberSource[];
} | {
  readonly seriesInputKind: 'analysis-result';
  readonly referenceId: string;
  readonly record: Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }>;
};

export type SeriesAnalysisNodeOutput = {
  analysisStatus: 'completed';
  resultType: Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }>['resultType'];
  value: JsonValue;
  assumptionChecks?: readonly Omit<z.infer<typeof AssumptionCheckSchema>, 'nodeId'>[];
} | {
  analysisStatus: 'inconclusive';
  reasonCodes: readonly string[];
  assumptionChecks?: readonly Omit<z.infer<typeof AssumptionCheckSchema>, 'nodeId'>[];
};

export interface SeriesAnalysisNodeRuntime {
  readonly identity: RuntimeIdentity;
  readonly outputSchema: SchemaIdentity;
  analyze(context: Readonly<SeriesAnalysisNodeContext>): Promise<SeriesAnalysisNodeOutput>;
}

export interface SeriesDecisionContext {
  readonly plan: EvaluationSeriesPlan;
  readonly bundle: SeriesAnalysisBundle;
  readonly records: readonly Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }>[];
}

export type SeriesDecisionOutput = {
  decisionStatus: 'decided';
  verdict: string;
  reasonCodes: readonly string[];
} | {
  decisionStatus: 'not-decided';
  reasonCodes: readonly string[];
};

const SeriesDecisionOutputSchema = z.discriminatedUnion('decisionStatus', [
  z.object({
    decisionStatus: z.literal('decided'),
    verdict: z.string().min(1).max(256),
    reasonCodes: z.array(z.string().min(1).max(256)).min(1),
  }).strict(),
  z.object({
    decisionStatus: z.literal('not-decided'),
    reasonCodes: z.array(z.string().min(1).max(256)).min(1),
  }).strict(),
]);

export interface SeriesDecisionRuntime {
  readonly identity: RuntimeIdentity;
  decide(context: Readonly<SeriesDecisionContext>): Promise<SeriesDecisionOutput>;
}

export interface EvaluationSeriesRuntimePorts {
  readonly analysisNodesByNodeId: ReadonlyMap<string, SeriesAnalysisNodeRuntime>;
  readonly decisionPoliciesByDecisionPolicyId: ReadonlyMap<string, SeriesDecisionRuntime>;
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
}

export interface EvaluationSeriesRunOptions {
  readonly bundleId: string;
  readonly reportId: string;
}

export interface EvaluationSeriesRunResult {
  readonly analysis: SeriesAnalysisBundle;
  readonly decision?: SeriesDecisionResult;
  readonly report: EvaluationSeriesReport;
}

function safeError(runtimeKind: 'analysis' | 'decision'): EvaluationError {
  return {
    code: `series-${runtimeKind}-runtime-failed`,
    stage: 'analysis',
    message: 'Evaluation Series Runtime 执行失败。',
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

function minimumTrust(
  values: readonly ('untrusted' | 'unknown' | 'declared' | 'verified')[],
): 'untrusted' | 'unknown' | 'declared' | 'verified' {
  return [...values].sort((left, right) => TRUST_LEVEL[left] - TRUST_LEVEL[right])[0]
    ?? 'unknown';
}

function memberSourcePrefix(
  member: EvaluationSeriesMemberSource,
  scope: EvaluationSeriesPlan['definition']['comparabilityPolicy']['comparisonScope'],
) {
  if (scope === 'evaluation') {
    return {
      execution: member.sources.execution,
      evaluation: member.sources.evaluation,
    };
  }
  if (scope === 'analysis') {
    return {
      execution: member.sources.execution,
      evaluation: member.sources.evaluation,
      analysis: member.sources.analysis,
    };
  }
  if (member.sources.decision === undefined) return undefined;
  return {
    execution: member.sources.execution,
    evaluation: member.sources.evaluation,
    analysis: member.sources.analysis,
    decision: member.sources.decision,
  };
}

function validateMembers(
  plan: EvaluationSeriesPlan,
  input: readonly EvaluationSeriesMemberSource[],
): EvaluationSeriesMemberSource[] {
  for (const member of input) assertEvaluationSeriesMemberSource(member);
  const members = [...input].sort((left, right) => (
    left.reference.replicateIndex - right.reference.replicateIndex
    || compareStrings(left.reference.memberId, right.reference.memberId)
  ));
  if (new Set(members.map((member) => member.reference.memberId)).size !== members.length
      || new Set(members.map((member) => member.reference.replicateIndex)).size !== members.length
      || new Set(members.map((member) => member.reference.reportDigest)).size !== members.length) {
    throw new TypeError('Evaluation Series contains duplicate member identity.');
  }
  const slots = new Map(plan.definition.members.map((slot) => [slot.memberId, slot]));
  for (const member of members) {
    const slot = slots.get(member.reference.memberId);
    if (slot === undefined
        || slot.replicateIndex !== member.reference.replicateIndex
        || (slot.expectedRunContractDigest !== undefined
          && slot.expectedRunContractDigest !== member.reference.runContractDigest)) {
      throw new TypeError('Evaluation Series member does not match its sealed slot.');
    }
    if (plan.definition.analysisMode === 'preregistered') {
      const membership = member.plan.definition.seriesMembership;
      if (membership === undefined
          || membership.seriesDesignDigest !== plan.definition.seriesDesignDigest
          || membership.memberId !== slot.memberId
          || membership.replicateIndex !== slot.replicateIndex) {
        throw new TypeError(
          'Preregistered Series members must bind the Series design before Run execution.',
        );
      }
    }
  }
  return members;
}

function comparableMembers(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
): { memberIds: Set<string>; assessments: SeriesComparabilityAssessment[] } {
  const memberIds = new Set<string>();
  const assessments: SeriesComparabilityAssessment[] = [];
  const anchor = members[0];
  if (anchor === undefined) return { memberIds, assessments };
  memberIds.add(anchor.reference.memberId);
  const scope = plan.definition.comparabilityPolicy.comparisonScope;
  const targetIds = anchor.plan.execution.targets.map((target) => target.targetId).sort(compareStrings);
  for (const candidate of members.slice(1)) {
    const leftSource = memberSourcePrefix(anchor, scope);
    const rightSource = memberSourcePrefix(candidate, scope);
    const policy = createComparabilityPolicy({
      schemaVersion: 'omk.comparability-policy/v1',
      designMode: 'exact-measurement-design',
      comparisonScope: scope,
      subjects: targetIds.map((targetId) => ({
        subjectId: targetId,
        leftTargetId: targetId,
        rightTargetId: targetId,
      })),
    });
    const assessment = assessComparability(
      policy,
      anchor.plan,
      candidate.plan,
      leftSource,
      rightSource,
    ).assessment;
    assessments.push({
      anchorMemberId: anchor.reference.memberId,
      memberId: candidate.reference.memberId,
      assessment,
    });
    if (assessment.comparabilityStatus === 'compatible'
        || (assessment.comparabilityStatus === 'conditional'
          && plan.definition.comparabilityPolicy.minimumStatus === 'conditional')) {
      memberIds.add(candidate.reference.memberId);
    }
  }
  return { memberIds, assessments };
}

function recordDigest(record: Omit<SeriesAnalysisRecord, 'recordDigest'>): Sha256Digest {
  return digestCanonicalJson(record);
}

function topologicalSeriesNodes(
  plan: EvaluationSeriesPlan,
): EvaluationSeriesPlan['definition']['analysisGraph']['nodes'] {
  const producerByResult = new Map(plan.definition.analysisGraph.nodes.map((node) => [
    node.outputResultId,
    node.nodeId,
  ]));
  const nodeById = new Map(plan.definition.analysisGraph.nodes.map((node) => [node.nodeId, node]));
  const remaining = new Set(nodeById.keys());
  const ordered: EvaluationSeriesPlan['definition']['analysisGraph']['nodes'][number][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((nodeId) => {
      const node = nodeById.get(nodeId);
      if (node === undefined) return false;
      return node.inputs.every((input) => input.seriesInputKind === 'members'
        || !remaining.has(producerByResult.get(input.referenceId) ?? ''));
    }).sort(compareStrings);
    if (ready.length === 0) throw new TypeError('Series analysis graph must be acyclic.');
    for (const nodeId of ready) {
      const node = nodeById.get(nodeId);
      if (node === undefined) throw new TypeError('Series analysis node is missing.');
      ordered.push(node);
      remaining.delete(nodeId);
    }
  }
  return ordered;
}

async function runAnalysisNodes(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
  comparableIds: ReadonlySet<string>,
  coverage: SeriesAnalysisBundle['coverage'],
  ports: EvaluationSeriesRuntimePorts,
): Promise<SeriesAnalysisRecord[]> {
  const comparable = members.filter((member) => comparableIds.has(member.reference.memberId));
  const records: SeriesAnalysisRecord[] = [];
  const recordsByResult = new Map<string, SeriesAnalysisRecord>();
  for (const node of topologicalSeriesNodes(plan)) {
    const eligible = comparable.filter((member) => (
      member.reference.status.runStatus === 'completed'
      && (member.reference.status.evidenceStatus === 'complete'
        || (member.reference.status.evidenceStatus === 'partial'
          && node.minimumMemberEvidenceStatus === 'partial'))
    ));
    const candidateBinding = plan.runtimes.find((binding) => binding.referenceId === node.nodeId);
    if (candidateBinding?.runtimeKind !== 'series-analysis-node') {
      throw new TypeError('Series Analysis Runtime binding is missing from the sealed plan.');
    }
    const assumptionChecks: SeriesAnalysisRecord['assumptionChecks'] = [];
    const inputs: SeriesAnalysisNodeInput[] = [];
    const unavailableResults: string[] = [];
    const parentDigests = new Set<Sha256Digest>();
    for (const input of node.inputs) {
      if (input.seriesInputKind === 'members') {
        inputs.push({ ...input, members: eligible });
        for (const member of eligible) {
          parentDigests.add(member.reference.reportDigest as Sha256Digest);
        }
      } else {
        const parent = recordsByResult.get(input.referenceId);
        if (parent?.analysisStatus !== 'completed') {
          unavailableResults.push(input.referenceId);
        } else {
          inputs.push({ ...input, record: parent });
          parentDigests.add(parent.recordDigest as Sha256Digest);
        }
      }
    }
    const base = {
      resultId: node.outputResultId,
      nodeId: node.nodeId,
      analysisStandardId: node.analysisStandardId,
      implementation: candidateBinding.identity,
      outputSchema: candidateBinding.outputSchema,
      inputReferences: node.inputs,
      memberIds: eligible.map((member) => member.reference.memberId).sort(compareStrings),
      coverage,
      assumptionChecks,
      analysisMode: plan.definition.analysisMode,
      parentDigests: [...parentDigests].sort(compareStrings),
    };
    if (unavailableResults.length > 0
        || (node.inputs.some((input) => input.seriesInputKind === 'members')
          && eligible.length < 2)) {
      const payload = {
        ...base,
        runtimeExecutionStatus: 'not-executed' as const,
        analysisStatus: 'inconclusive' as const,
        reasonCodes: unavailableResults.length > 0
          ? ['series-analysis-dependency-unavailable']
          : ['series-comparable-members-insufficient'],
      };
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...payload,
        recordDigest: recordDigest(payload),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
      continue;
    }
    const runtime = ports.analysisNodesByNodeId.get(node.nodeId);
    if (runtime === undefined
        || canonicalizeJson(runtime.identity) !== canonicalizeJson(candidateBinding.identity)
        || canonicalizeJson(runtime.outputSchema)
          !== canonicalizeJson(candidateBinding.outputSchema)) {
      throw new TypeError('Series Analysis Runtime does not match the sealed plan.');
    }
    const validator = ports.schemaValidators.get(schemaIdentityKey(candidateBinding.outputSchema));
    if (validator === undefined
        || canonicalizeJson(validator.schema) !== canonicalizeJson(candidateBinding.outputSchema)) {
      throw new TypeError('Series Analysis output schema validator is missing or mismatched.');
    }
    try {
      const output = await runtime.analyze(deepFreezeCanonicalJson({
        plan,
        node,
        members: eligible,
        coverage,
        inputs,
      }) as unknown as SeriesAnalysisNodeContext);
      const checks = (output.assumptionChecks ?? []).map((check) => parseWireDocument(
        AssumptionCheckSchema,
        { ...check, nodeId: node.nodeId },
      )).sort((left, right) => compareStrings(left.assumptionId, right.assumptionId));
      const assumptionsPassed = checks.every((check) => check.checkStatus === 'passed');
      const normalized = output.analysisStatus === 'completed' && assumptionsPassed
        ? {
          ...base,
          assumptionChecks: checks,
          runtimeExecutionStatus: 'executed' as const,
          analysisStatus: 'completed' as const,
          resultType: output.resultType,
          value: output.value,
        }
        : output.analysisStatus === 'completed'
          ? {
            ...base,
            assumptionChecks: checks,
            runtimeExecutionStatus: 'executed' as const,
            analysisStatus: 'inconclusive' as const,
            reasonCodes: ['series-analysis-assumption-failed'],
          }
          : {
            ...base,
            assumptionChecks: checks,
            runtimeExecutionStatus: 'executed' as const,
            analysisStatus: 'inconclusive' as const,
            reasonCodes: [...output.reasonCodes].sort(compareStrings),
          };
      if (normalized.analysisStatus === 'completed') {
        const envelope = { resultType: normalized.resultType, value: normalized.value };
        if (canonicalizeJson(validator.parse(envelope, {
          validationKind: 'analysis-output',
          parameters: node.parameters ?? {},
          inputFacts: { resamplingUnitCount: eligible.length },
        })) !== canonicalizeJson(envelope)) {
          throw new TypeError('Series Analysis output validator must preserve the sealed envelope.');
        }
      }
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...normalized,
        recordDigest: recordDigest(normalized),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
    } catch {
      const payload = {
        ...base,
        runtimeExecutionStatus: 'executed' as const,
        analysisStatus: 'failed' as const,
        error: safeError('analysis'),
      };
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...payload,
        recordDigest: recordDigest(payload),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
    }
  }
  return records.sort((left, right) => compareStrings(left.nodeId, right.nodeId));
}

function makeBundle(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
  coverage: SeriesAnalysisBundle['coverage'],
  records: readonly SeriesAnalysisRecord[],
  comparability: readonly SeriesComparabilityAssessment[],
  bundleId: string,
): SeriesAnalysisBundle {
  const parentDigests = members.map((member) => member.reference.reportDigest).sort(compareStrings);
  const trust = minimumTrust([
    ...members.map((member) => member.reference.effectiveTrust),
    ...records
      .filter((record) => record.runtimeExecutionStatus === 'executed')
      .map((record) => record.implementation.assuranceLevel),
  ]);
  const payload = {
    schemaVersion: SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
    bundleId,
    seriesPlanDigest: plan.seriesPlanDigest,
    members: members.map((member) => member.reference),
    comparability,
    coverage,
    records,
    provenance: {
      provenanceKind: 'derived' as const,
      trust,
      parentDigests,
    },
  };
  return parseSeriesAnalysisBundleDocument({
    ...payload,
    bundleDigest: digestSeriesArtifact(payload as unknown as Record<string, JsonValue>, 'bundleDigest'),
  });
}

async function makeDecision(
  plan: EvaluationSeriesPlan,
  bundle: SeriesAnalysisBundle,
  ports: EvaluationSeriesRuntimePorts,
): Promise<SeriesDecisionResult | undefined> {
  const policy = plan.definition.decisionPolicy;
  if (policy === undefined) return undefined;
  const binding = plan.runtimes.find((runtime) => (
    runtime.runtimeKind === 'series-decision-policy'
      && runtime.referenceId === policy.decisionPolicyId
  ));
  if (binding?.runtimeKind !== 'series-decision-policy') {
    throw new TypeError('Series Decision Runtime binding is missing from the sealed plan.');
  }
  const records = bundle.records.filter(
    (record): record is Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }> => (
      record.analysisStatus === 'completed'
    ),
  );
  const comparableMemberIds = new Set(bundle.records
    .filter((record) => policy.analysisResultIds.includes(record.resultId))
    .flatMap((record) => record.memberIds));
  const qualifiedMembers = bundle.members.filter((member) => (
    comparableMemberIds.has(member.memberId)
    && member.status.runStatus === 'completed'
    && (member.status.evidenceStatus === 'complete'
      || (member.status.evidenceStatus === 'partial'
        && policy.minimumMemberEvidenceStatus === 'partial'))
  )).length;
  const coverageRatio = bundle.coverage.planned === 0
    ? 0
    : qualifiedMembers / bundle.coverage.planned;
  const required = new Set(policy.analysisResultIds);
  const gatesPassed = coverageRatio >= policy.minimumCoverageRatio
    && [...required].every((resultId) => records.some((record) => record.resultId === resultId))
    && records.every((record) => record.assumptionChecks.every((check) => check.checkStatus === 'passed'));
  const policyDigest = digestCanonicalJson({
    seriesPlanDigest: plan.seriesPlanDigest,
    policy,
    runtime: binding.identity,
  });
  const base = {
    decisionPolicyId: policy.decisionPolicyId,
    implementation: binding.identity,
    seriesPlanDigest: plan.seriesPlanDigest,
    analysisBundleDigest: bundle.bundleDigest,
    analysisResultIds: [...policy.analysisResultIds].sort(compareStrings),
    policyDigest,
  };
  if (!gatesPassed) {
    const payload = {
      ...base,
      policyExecutionStatus: 'not-executed' as const,
      decisionStatus: 'not-decided' as const,
      reasonCodes: ['series-coverage-or-assumption-gate-failed'],
    };
    return parseWireDocument(SeriesDecisionResultSchema, {
      ...payload,
      decisionDigest: digestSeriesArtifact(
        payload as unknown as Record<string, JsonValue>,
        'decisionDigest',
      ),
    });
  }
  const runtime = ports.decisionPoliciesByDecisionPolicyId.get(policy.decisionPolicyId);
  if (runtime === undefined
      || canonicalizeJson(binding.identity) !== canonicalizeJson(runtime.identity)) {
    throw new TypeError('Series Decision Runtime does not match the sealed plan.');
  }
  let output: SeriesDecisionOutput;
  try {
    output = parseWireDocument(SeriesDecisionOutputSchema, await runtime.decide(
      deepFreezeCanonicalJson({ plan, bundle, records }) as unknown as SeriesDecisionContext,
    ));
  } catch {
    const payload = {
      ...base,
      policyExecutionStatus: 'executed' as const,
      decisionStatus: 'failed' as const,
      error: safeError('decision'),
    };
    return parseWireDocument(SeriesDecisionResultSchema, {
      ...payload,
      decisionDigest: digestSeriesArtifact(
        payload as unknown as Record<string, JsonValue>,
        'decisionDigest',
      ),
    });
  }
  const payload = output.decisionStatus === 'decided'
    ? {
      ...base,
      policyExecutionStatus: 'executed' as const,
      decisionStatus: 'decided' as const,
      verdict: output.verdict,
      reasonCodes: [...new Set(output.reasonCodes)].sort(compareStrings),
    }
    : {
      ...base,
      policyExecutionStatus: 'executed' as const,
      decisionStatus: 'not-decided' as const,
      reasonCodes: [...output.reasonCodes].sort(compareStrings),
    };
  return parseWireDocument(SeriesDecisionResultSchema, {
    ...payload,
    decisionDigest: digestSeriesArtifact(
      payload as unknown as Record<string, JsonValue>,
      'decisionDigest',
    ),
  });
}

export async function runEvaluationSeries(
  planInput: unknown,
  memberInputs: readonly EvaluationSeriesMemberSource[],
  ports: EvaluationSeriesRuntimePorts,
  options: EvaluationSeriesRunOptions,
): Promise<EvaluationSeriesRunResult> {
  const plan = parseEvaluationSeriesPlan(planInput);
  const members = validateMembers(plan, memberInputs);
  const comparability = comparableMembers(plan, members);
  const coverage = deriveSeriesMemberCoverage(plan, members, comparability.memberIds);
  const records = await runAnalysisNodes(
    plan,
    members,
    comparability.memberIds,
    coverage,
    ports,
  );
  const analysis = makeBundle(
    plan,
    members,
    coverage,
    records,
    comparability.assessments,
    options.bundleId,
  );
  const decision = await makeDecision(plan, analysis, ports);
  const payload = {
    schemaVersion: EVALUATION_SERIES_REPORT_SCHEMA_VERSION,
    reportId: options.reportId,
    seriesPlanDigest: plan.seriesPlanDigest,
    analysisBundleDigest: analysis.bundleDigest,
    ...(decision !== undefined ? { decision } : {}),
    provenance: {
      provenanceKind: 'derived' as const,
      trust: minimumTrust([
        analysis.provenance.trust,
        ...(decision?.policyExecutionStatus === 'executed'
          ? [decision.implementation.assuranceLevel]
          : []),
      ]),
      parentDigests: [
        analysis.bundleDigest,
        ...(decision === undefined ? [] : [decision.decisionDigest]),
      ],
    },
  };
  const report = parseEvaluationSeriesReportDocument({
    ...payload,
    reportDigest: digestSeriesArtifact(
      payload as unknown as Record<string, JsonValue>,
      'reportDigest',
    ),
  });
  return deepFreezeCanonicalJson({
    analysis,
    ...(decision !== undefined ? { decision } : {}),
    report,
  });
}

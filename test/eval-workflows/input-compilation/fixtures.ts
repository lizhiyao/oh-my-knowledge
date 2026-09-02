import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../../src/eval-core/contracts/index.js';
import {
  RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION,
  RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
  type ResolvedCliEvaluationInput,
  type ResolvedHostResource,
  type ResolvedResourceDescriptor,
} from '../../../src/eval-workflows/input-compilation/index.js';

function descriptor(
  resourceId: string,
  value: JsonValue,
  classification: ResolvedResourceDescriptor['classification'] = 'public',
  mediaType = 'application/json',
): ResolvedResourceDescriptor {
  return {
    resourceId,
    digest: digestCanonicalJson(value),
    mediaType,
    classification,
    size: Buffer.byteLength(canonicalizeJson(value)),
  };
}

function hostResource(
  resourceKind: ResolvedHostResource['resourceKind'],
  descriptorValue: ResolvedResourceDescriptor,
  locator: string,
  lineage?: JsonValue,
): ResolvedHostResource {
  return {
    resourceKind,
    descriptor: descriptorValue,
    locator,
    ...(lineage === undefined ? {} : { lineage }),
    verification: {
      verificationKind: resourceKind === 'workspace' ? 'tree-digest' : 'content-digest',
      verifiedDigest: descriptorValue.digest,
    },
  };
}

export function validResolvedCliInput(): ResolvedCliEvaluationInput {
  const controlArtifact = descriptor('artifact-control', { body: '' }, 'public', 'text/markdown');
  const treatmentArtifact = descriptor(
    'artifact-treatment',
    { body: '# Skill\nDo the task carefully.' },
    'public',
    'text/markdown',
  );
  const workspace = descriptor('workspace-tree', { files: ['README.md'] }, 'sensitive');
  const mcp = descriptor('mcp-config', { servers: ['search'] }, 'secret');
  const mockRule = descriptor(
    'mock-search-rule',
    { tool: 'search', match: { input: { query: 'Q' } } },
    'secret',
  );
  const mockPayload = descriptor('mock-search-response', { answer: 'A' }, 'secret');
  const rubric = descriptor('rubric-correctness', { rubric: 'correctness' });
  const gold = descriptor('gold-dataset', { version: 1 }, 'gold');
  const resources = [
    hostResource('artifact', controlArtifact, '/repo/skills/baseline.md', {
      repository: 'example/repo', commit: 'a1', sourcePath: 'skills/baseline.md',
    }),
    hostResource('artifact', treatmentArtifact, '/repo/skills/treatment.md', {
      repository: 'example/repo', commit: 'b2', sourcePath: 'skills/treatment.md',
    }),
    hostResource('workspace', workspace, '/repo/workspace'),
    hostResource('mcp-config', mcp, '/repo/mcp.json'),
    hostResource('mock-rule', mockRule, '/repo/mocks/search-rule.json'),
    hostResource('mock-payload', mockPayload, '/repo/mocks/search.json'),
    hostResource('content', rubric, '/repo/rubrics/correctness.json'),
    hostResource('gold-dataset', gold, '/repo/gold/v1'),
  ];
  return {
    schemaVersion: RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION,
    dataset: {
      datasetId: 'dataset-cli-input',
      analysisCohorts: [
        {
          cohortId: 'train',
          cohortSetId: 'holdout-split',
          cohortSetKind: 'partition',
          classification: 'gold',
          disclosure: 'identity-only',
          derivation: {
            algorithmId: 'omk.hash-holdout/v1',
            seed: 'holdout-seed',
          },
        },
        {
          cohortId: 'holdout',
          cohortSetId: 'holdout-split',
          cohortSetKind: 'partition',
          classification: 'gold',
          disclosure: 'identity-only',
          derivation: {
            algorithmId: 'omk.hash-holdout/v1',
            seed: 'holdout-seed',
          },
        },
      ],
      samples: [
        {
          sampleId: 'sample-2',
          input: { question: 'Q2' },
          executionContext: {
            mock: {
              strict: true,
              payload: {
                resourceId: mockPayload.resourceId,
                digest: mockPayload.digest,
                mediaType: mockPayload.mediaType,
                classification: mockPayload.classification,
              },
            },
          },
          expected: { answer: 'A2' },
          evaluationContext: { rubricId: rubric.resourceId, rubricDigest: rubric.digest },
          analysis: { memberships: [{ cohortId: 'holdout' }] },
        },
        {
          sampleId: 'sample-1',
          input: { question: 'Q1' },
          expected: { answer: 'A1' },
          evaluationContext: { rubricId: rubric.resourceId, rubricDigest: rubric.digest },
          analysis: { memberships: [{ cohortId: 'train' }] },
        },
      ],
    },
    targets: [
      {
        targetId: 'treatment',
        experimentRole: 'treatment',
        targetKind: 'skill',
        protocolId: 'omk.invoke/v1',
        executor: {
          implementationId: 'codex-adapter/v1',
          versionConstraint: '^1.0.0',
          model: 'gpt-example',
          effort: 'low',
        },
        behavior: {
          systemInstructions: 'required',
          artifact: treatmentArtifact,
          mcpConfig: mcp,
          sandbox: {
            sandboxId: 'omk.local-sandbox/v1',
            config: { classification: 'public', value: { network: 'mock-only' } },
          },
          mocks: [{
            sampleIds: ['sample-2'],
            strict: true,
            rule: mockRule,
            payloads: [mockPayload],
          }],
        },
        executionControls: {
          defaults: {
            workspace: {
              workspaceMode: 'copy-on-write-overlay',
              descriptor: { ...workspace, classification: 'sensitive' },
            },
            tools: { toolPolicyKind: 'allow-list', allowedTools: ['search'] },
          },
          sampleOverrides: [],
        },
      },
      {
        targetId: 'control',
        experimentRole: 'control',
        targetKind: 'baseline',
        protocolId: 'omk.invoke/v1',
        executor: {
          implementationId: 'codex-adapter/v1',
          versionConstraint: '^1.0.0',
          model: 'gpt-example',
          effort: 'low',
        },
        behavior: {
          systemInstructions: 'not-required',
          artifact: controlArtifact,
          mcpConfig: mcp,
          allowedSkills: [],
          mocks: [{
            sampleIds: ['sample-2'],
            strict: true,
            rule: mockRule,
            payloads: [mockPayload],
          }],
        },
        executionControls: {
          defaults: {
            workspace: {
              workspaceMode: 'copy-on-write-overlay',
              descriptor: { ...workspace, classification: 'sensitive' },
            },
            tools: { toolPolicyKind: 'allow-list', allowedTools: ['search'] },
          },
          sampleOverrides: [],
        },
      },
    ],
    evaluatorTemplates: [
      {
        evaluatorId: 'assertion',
        evaluatorKind: 'assertion',
        runtimeBindingKind: 'builtin',
        implementationId: 'omk.assertion/v1',
        instrumentId: 'assertion-suite-v1',
        replicateGroupId: 'assertion-primary',
        metricIds: ['assertion-score'],
        inputs: [
          { bindingId: 'actual', sourceKind: 'output', pointer: '' },
          { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
        ],
      },
      {
        evaluatorId: 'rubric',
        evaluatorKind: 'llm-rubric',
        runtimeBindingKind: 'judge',
        implementationId: 'omk.rubric-judge/v1',
        instrumentId: 'rubric-correctness-v1',
        runtimePromptVariant: 'rubric-length-debias-on/v1',
        replicateGroupId: 'rubric-primary',
        metricIds: ['rubric-score', 'dimension-score', 'rag-score'],
        inputs: [
          { bindingId: 'actual', sourceKind: 'output', pointer: '' },
          { bindingId: 'rubric', sourceKind: 'evaluation-context', pointer: '' },
        ],
        config: {
          classification: 'public',
          value: {
            dimensions: ['correctness'],
            lengthDebias: true,
            neutralizePresentation: true,
          },
        },
        resources: [rubric],
      },
    ],
    judges: {
      enabled: true,
      replicateCount: 2,
      members: [
        {
          ensembleMemberId: 'judge-b',
          executorId: 'openai-api',
          model: 'judge-b',
        },
        {
          ensembleMemberId: 'judge-a',
          executorId: 'anthropic-api',
          model: 'judge-a',
        },
      ],
    },
    metrics: [
      {
        metricId: 'assertion-score', valueType: 'boolean', scope: 'sample',
        direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      },
      {
        metricId: 'rubric-score', valueType: 'numeric', scope: 'sample',
        scale: { min: 0, max: 5 }, direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      },
      {
        metricId: 'dimension-score', valueType: 'numeric', scope: 'sample',
        scale: { min: 0, max: 5 }, direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      },
      {
        metricId: 'rag-score', valueType: 'numeric', scope: 'sample',
        scale: { min: 0, max: 1 }, direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      },
    ],
    experiment: {
      trials: 1,
      seed: 'experiment-seed',
      sampling: {
        experimentalUnit: 'sample',
        pairingKey: '/sampleId',
        repeatedMeasures: true,
        resamplingUnit: 'paired-block',
        estimatorId: 'bootstrap.mean-difference/v1',
        seedCoupling: 'shared-within-block',
      },
      scheduling: { schedulingKind: 'randomized-block', blockSize: 2 },
    },
    analysisGraph: {
      analysisMode: 'preregistered',
      nodes: [
        {
          analysisNodeKind: 'reducer',
          nodeId: 'composite-score',
          implementationId: 'omk.composite/v1',
          inputs: [
            { inputKind: 'metric-observations', referenceId: 'rubric-score' },
            { inputKind: 'metric-observations', referenceId: 'assertion-score' },
          ],
          outputResultId: 'composite-result',
          parameters: { weights: { assertion: 0.5, rubric: 0.5 } },
        },
        {
          analysisNodeKind: 'estimator',
          nodeId: 'bootstrap-difference',
          implementationId: 'bootstrap.mean-difference/v1',
          inputs: [{
            inputKind: 'comparison',
            referenceId: 'control-vs-treatment',
            treatmentTargetId: 'treatment',
            metricId: 'rubric-score',
          }],
          outputResultId: 'bootstrap-difference-result',
          cohortFilter: { includeCohortIds: ['holdout'] },
          parameters: { resamples: 1000, alpha: 0.05 },
        },
      ],
    },
    decisionPolicy: {
      decisionPolicyId: 'release-gate',
      implementationId: 'omk.progress-gate/v1',
      analysisResultIds: ['bootstrap-difference-result', 'composite-result'],
      minimumEvidenceStatus: 'complete',
      parameters: { threshold: 3.5, trivialDifference: 0.1 },
    },
    policy: {
      executionConcurrency: 3,
      evaluationConcurrency: 2,
      executionTimeoutMs: 120_000,
      evaluationTimeoutMs: 60_000,
      retryCount: 2,
      cache: {
        executionMode: 'disabled',
        evaluationMode: 'disabled',
      },
      budget: {
        totalProviderCostUSD: 10,
        perCoordinateProviderCostUSD: 1,
        perCoordinateActiveDurationMs: 30_000,
        runMaxInvocations: 100,
        executionMaxInvocations: 40,
        evaluationMaxInvocations: 60,
      },
    },
    hostResources: {
      schemaVersion: RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
      resources,
    },
    orchestration: {
      dryRun: false,
      batch: false,
      resumeSourceLocator: '/repo/.omk/eval/previous.json',
      preflight: { doctor: 'required', connectivity: 'required' },
      diagnostic: 'enabled-outside-core',
      managedEvidence: 'append',
      gold: { resourceId: gold.resourceId, comparisonMode: 'exploratory-post-hoc' },
      independentSeries: { repeatCount: 3, seriesInstanceId: 'repeat-series-run-20260830' },
    },
    presentation: {
      outputDirectoryLocator: '/repo/.omk/eval',
      indexScope: 'project',
      language: 'zh',
      serve: true,
      verbose: false,
      layeredView: true,
      exitMode: 'gate',
    },
    staticRunMetadata: { annotations: { source: 'cli' } },
  };
}

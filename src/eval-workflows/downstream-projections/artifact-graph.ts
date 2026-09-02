import {
  digestCanonicalJson,
  type AnalysisRecord,
  type EvaluationRecord,
  type ExecutionRecord,
} from '../../evaluation-core/contracts/index.js';
import { parseArtifactGraphDocument } from '../../artifact-graph/schema.js';
import type {
  ArtifactGraphDocument,
  ArtifactGraphEdge,
  ArtifactGraphEdgeKind,
  ArtifactGraphEvidenceRef,
  ArtifactGraphNode,
  ArtifactGraphNodeKind,
  ArtifactGraphStatus,
} from '../../artifact-graph/contracts.js';
import { CORE_RUN_DOCUMENT_FILES, type StoredCoreRunArtifacts } from '../artifact-store/index.js';
import { CoreDownstreamProjectionError } from './contracts.js';
import { assertCoreProjectionSource } from './source.js';

export interface ProjectCoreArtifactGraphInput {
  readonly source: Readonly<StoredCoreRunArtifacts>;
  readonly cwd: string;
  readonly generatedAt: string;
  readonly sourcePath?: string;
  readonly cliVersion?: string;
}

function artifactStatus(
  status: StoredCoreRunArtifacts['report']['status'],
): ArtifactGraphStatus {
  if (status.runStatus === 'failed') return 'failed';
  if (status.runStatus !== 'completed') return 'warning';
  return status.evidenceStatus === 'complete' && status.conclusionStatus === 'conclusive'
    ? 'ok'
    : 'warning';
}

function executionStatus(record: ExecutionRecord): ArtifactGraphStatus {
  if (record.executionStatus === 'completed') return 'ok';
  if (record.executionStatus === 'failed') return 'failed';
  if (record.executionStatus === 'cancelled') return 'skipped';
  return 'not_measured';
}

function evaluationStatus(record: EvaluationRecord): ArtifactGraphStatus {
  if (record.evaluationStatus === 'completed') return 'ok';
  if (record.evaluationStatus === 'failed') return 'failed';
  if (record.evaluationStatus === 'cancelled') return 'skipped';
  return 'not_measured';
}

function analysisStatus(record: AnalysisRecord): ArtifactGraphStatus {
  if (record.analysisStatus === 'completed') return 'ok';
  if (record.analysisStatus === 'failed') return 'failed';
  if (record.analysisStatus === 'inconclusive') return 'warning';
  return 'not_measured';
}

function evidence(
  sourceId: string,
  contentHash: string,
  path: string,
  value: string,
): ArtifactGraphEvidenceRef[] {
  return [{
    sourceKind: 'evaluation-core-document',
    sourceId,
    path,
    selector: { selectorKind: 'json-pointer', value },
    contentHash,
    redaction: 'redacted',
  }];
}

function nodeId(stableKey: string): string {
  return `node:${digestCanonicalJson({ stableKey })}`;
}

function edgeId(stableKey: string): string {
  return `edge:${digestCanonicalJson({ stableKey })}`;
}

/**
 * Build a privacy-safe topology view from persisted Core facts. Statuses come
 * only from explicit stage states; numeric observations are display metrics,
 * never verdict thresholds.
 */
export function projectCoreArtifactGraph(
  input: Readonly<ProjectCoreArtifactGraphInput>,
): ArtifactGraphDocument {
  assertCoreProjectionSource(input.source);
  const { plan, execution, evaluation, analysis, report, manifest } = input.source;
  const documentHash = new Map(manifest.documents.map((document) => [
    document.documentKind,
    document.documentDigest,
  ]));
  const nodes: ArtifactGraphNode[] = [];
  const edges: ArtifactGraphEdge[] = [];
  const nodesByStableKey = new Map<string, string>();

  const addNode = (
    stableKey: string,
    nodeKind: ArtifactGraphNodeKind,
    label: string,
    extra: Omit<Partial<ArtifactGraphNode>, 'id' | 'stableKey' | 'nodeKind' | 'label'> = {},
  ): string => {
    const previous = nodesByStableKey.get(stableKey);
    if (previous !== undefined) return previous;
    const id = nodeId(stableKey);
    nodesByStableKey.set(stableKey, id);
    nodes.push({
      id,
      stableKey,
      nodeKind,
      nodeRole: 'entity',
      layer: 'measurement',
      label,
      ...extra,
    });
    return id;
  };
  const addEdge = (
    stableKey: string,
    fromNodeId: string,
    toNodeId: string,
    edgeKind: ArtifactGraphEdgeKind,
    extra: Omit<Partial<ArtifactGraphEdge>, 'id' | 'fromNodeId' | 'toNodeId' | 'edgeKind'> = {},
  ): void => {
    edges.push({
      id: edgeId(stableKey),
      fromNodeId,
      toNodeId,
      edgeKind,
      layer: 'measurement',
      ...extra,
    });
  };

  const runKey = `core:v1:run:${manifest.runId}:${report.reportDigest}`;
  const runNode = addNode(runKey, 'evaluation_run', report.reportId, {
    nodeRole: 'aggregate',
    status: artifactStatus(report.status),
    binding: {
      bindingStrength: 'content-hash',
      keys: {
        runId: manifest.runId,
        runContractDigest: plan.digests.runContractDigest,
        reportDigest: report.reportDigest,
      },
    },
    attrs: { display: { ...report.status } },
    evidenceRefs: evidence(
      report.reportId,
      documentHash.get('evaluation-report')!,
      CORE_RUN_DOCUMENT_FILES.evaluationReport,
      '',
    ),
  });

  const targetNodes = new Map(plan.execution.targets.map((target, index) => {
    const key = `core:v1:target:${plan.digests.executionPlanDigest}:${target.targetId}`;
    const id = addNode(key, 'target', target.targetId, {
      binding: { bindingStrength: 'explicit', keys: { targetId: target.targetId } },
      attrs: {
        display: {
          targetKind: target.targetKind,
          protocolId: target.protocolId,
          executorId: target.executorId,
        },
      },
      evidenceRefs: evidence(
        plan.digests.runContractDigest,
        documentHash.get('run-plan')!,
        'run-plan.json',
        `/execution/targets/${index}`,
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    return [target.targetId, id] as const;
  }));

  const sampleNodes = new Map(plan.execution.samples.map((sample, index) => {
    const key = `core:v1:sample:${plan.digests.datasetRevisionDigest}:${sample.sampleId}`;
    const id = addNode(key, 'sample', sample.sampleId, {
      binding: { bindingStrength: 'explicit', keys: { sampleId: sample.sampleId } },
      evidenceRefs: evidence(
        plan.digests.runContractDigest,
        documentHash.get('run-plan')!,
        'run-plan.json',
        `/execution/samples/${index}`,
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    return [sample.sampleId, id] as const;
  }));

  const evaluatorNodes = new Map(plan.evaluation.evaluators.map((evaluator, index) => {
    const key = `core:v1:evaluator:${plan.digests.evaluationPlanDigest}:${evaluator.evaluatorId}`;
    const id = addNode(key, 'evaluator', evaluator.evaluatorId, {
      binding: {
        bindingStrength: 'explicit',
        keys: {
          evaluatorId: evaluator.evaluatorId,
          instrumentId: evaluator.measurement.instrumentId,
          ensembleMemberId: evaluator.measurement.ensembleMemberId,
          replicateGroupId: evaluator.measurement.replicateGroupId,
          replicateIndex: String(evaluator.measurement.replicateIndex),
        },
      },
      attrs: {
        producer: {
          evaluatorKind: evaluator.evaluatorKind,
          implementationId: evaluator.implementationId,
        },
      },
      evidenceRefs: evidence(
        plan.digests.runContractDigest,
        documentHash.get('run-plan')!,
        'run-plan.json',
        `/evaluation/evaluators/${index}`,
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    return [evaluator.evaluatorId, id] as const;
  }));

  const metricNodes = new Map(plan.evaluation.metrics.map((metric, index) => {
    const key = `core:v1:metric:${plan.digests.evaluationPlanDigest}:${metric.metricId}`;
    const id = addNode(key, 'metric', metric.metricId, {
      binding: { bindingStrength: 'explicit', keys: { metricId: metric.metricId } },
      attrs: {
        display: {
          valueType: metric.valueType,
          scope: metric.scope,
          ...(metric.unit === undefined ? {} : { unit: metric.unit }),
          ...(metric.direction === undefined ? {} : { direction: metric.direction }),
          ...(metric.scale === undefined ? {} : { scale: metric.scale }),
        },
      },
      evidenceRefs: evidence(
        plan.digests.runContractDigest,
        documentHash.get('run-plan')!,
        'run-plan.json',
        `/evaluation/metrics/${index}`,
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    return [metric.metricId, id] as const;
  }));

  for (const evaluator of plan.evaluation.evaluators) {
    const evaluatorNode = evaluatorNodes.get(evaluator.evaluatorId);
    if (evaluatorNode === undefined) continue;
    for (const metricId of evaluator.metricIds) {
      const metricNode = metricNodes.get(metricId);
      if (metricNode !== undefined) {
        addEdge(
          `${runKey}:evaluator:${evaluator.evaluatorId}:declares:${metricId}`,
          evaluatorNode,
          metricNode,
          'declares',
        );
      }
    }
  }

  const executionNodes = new Map<string, string>();
  execution.records.forEach((record, index) => {
    const key = `core:v1:execution-result:${execution.bundleDigest}:${record.trialId}`;
    const id = addNode(key, 'execution_result', `${record.targetId} / ${record.sampleId}`, {
      nodeRole: 'observation',
      status: executionStatus(record),
      binding: { bindingStrength: 'content-hash', keys: { trialId: record.trialId } },
      metrics: record.executionStatus === 'budget-censored'
        ? undefined
        : {
          ...(record.timing.durationMs === undefined ? {} : {
            durationMs: record.timing.durationMs,
          }),
        },
      attrs: {
        display: {
          executionStatus: record.executionStatus,
          trialIndex: record.trialIndex,
        },
      },
      evidenceRefs: evidence(
        execution.bundleId,
        documentHash.get('execution-bundle')!,
        'execution-bundle.json',
        `/records/${index}`,
      ),
    });
    executionNodes.set(record.trialId, id);
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    const targetNode = targetNodes.get(record.targetId);
    const sampleNode = sampleNodes.get(record.sampleId);
    if (targetNode !== undefined) {
      addEdge(`${key}:derived-from:target`, id, targetNode, 'derived_from');
    }
    if (sampleNode !== undefined) {
      addEdge(`${key}:evaluates:sample`, id, sampleNode, 'evaluates');
    }
  });

  evaluation.records.forEach((record, index) => {
    const key = `core:v1:evaluation-result:${evaluation.bundleDigest}:${record.evaluationId}`;
    const numericMetrics = record.evaluationStatus === 'completed'
      ? Object.fromEntries(record.observations.flatMap((observation) => (
        observation.observationStatus === 'observed'
          && observation.valueType === 'numeric'
          && Number.isFinite(observation.value)
          ? [[observation.metricId, observation.value]]
          : []
      )))
      : undefined;
    const id = addNode(key, 'evaluation_result', `${record.evaluatorId} / ${record.sampleId}`, {
      nodeRole: 'observation',
      status: evaluationStatus(record),
      binding: {
        bindingStrength: 'content-hash',
        keys: { evaluationId: record.evaluationId },
      },
      metrics: numericMetrics !== undefined && Object.keys(numericMetrics).length > 0
        ? numericMetrics
        : undefined,
      attrs: {
        display: {
          evaluationStatus: record.evaluationStatus,
          trialIndex: record.trialIndex,
        },
      },
      evidenceRefs: evidence(
        evaluation.bundleId,
        documentHash.get('evaluation-bundle')!,
        'evaluation-bundle.json',
        `/records/${index}`,
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    const evaluatorNode = evaluatorNodes.get(record.evaluatorId);
    const executionNode = executionNodes.get(record.trialId);
    const sampleNode = sampleNodes.get(record.sampleId);
    if (evaluatorNode !== undefined) {
      addEdge(`${key}:derived-from:evaluator`, id, evaluatorNode, 'derived_from');
    }
    if (executionNode !== undefined) {
      addEdge(`${key}:derived-from:execution`, id, executionNode, 'derived_from');
    }
    if (sampleNode !== undefined) {
      addEdge(`${key}:evaluates:sample`, id, sampleNode, 'evaluates');
    }
    if (record.evaluationStatus === 'completed') {
      for (const observation of record.observations) {
        const metricNode = metricNodes.get(observation.metricId);
        if (metricNode !== undefined) {
          addEdge(
            `${key}:observes:${observation.observationId}`,
            id,
            metricNode,
            'observes',
          );
        }
      }
    }
  });

  const analysisNodes = new Map(analysis.records.map((record, index) => {
    const key = `core:v1:analysis-result:${analysis.bundleDigest}:${record.resultId}`;
    const id = addNode(key, 'analysis_result', record.resultId, {
      nodeRole: 'aggregate',
      status: analysisStatus(record),
      binding: { bindingStrength: 'content-hash', keys: { recordDigest: record.recordDigest } },
      attrs: {
        display: {
          analysisStatus: record.analysisStatus,
          analysisNodeKind: record.analysisNodeKind,
          analysisMode: record.analysisMode,
          included: record.coverage.included,
          excluded: record.coverage.excluded,
        },
      },
      evidenceRefs: evidence(
        analysis.bundleId,
        documentHash.get('analysis-bundle')!,
        'analysis-bundle.json',
        `/records/${index}`,
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    return [record.resultId, id] as const;
  }));
  analysis.records.forEach((record) => {
    const key = `core:v1:analysis-result:${analysis.bundleDigest}:${record.resultId}`;
    const id = analysisNodes.get(record.resultId);
    if (id === undefined) return;
    for (const reference of record.inputReferences) {
      if (reference.inputKind === 'metric-observations') {
        const metricNode = metricNodes.get(reference.referenceId);
        if (metricNode !== undefined) {
          addEdge(
            `${key}:input:metric-observations:${reference.referenceId}`,
            id,
            metricNode,
            'derived_from',
          );
        }
      } else if (reference.inputKind === 'analysis-result') {
        const parent = analysisNodes.get(reference.referenceId);
        if (parent !== undefined) {
          addEdge(
            `${key}:input:analysis-result:${reference.referenceId}`,
            id,
            parent,
            'derived_from',
          );
        }
      } else {
        const targetNode = targetNodes.get(reference.treatmentTargetId);
        const metricNode = metricNodes.get(reference.metricId);
        if (targetNode !== undefined) {
          addEdge(
            `${key}:input:comparison:${reference.referenceId}:target:${reference.treatmentTargetId}`,
            id,
            targetNode,
            'derived_from',
          );
        }
        if (metricNode !== undefined) {
          addEdge(
            `${key}:input:comparison:${reference.referenceId}:metric:${reference.metricId}`,
            id,
            metricNode,
            'derived_from',
          );
        }
      }
    }
  });

  if (report.decision !== undefined) {
    const decision = report.decision;
    const key = `core:v1:decision:${decision.decisionDigest}`;
    const id = addNode(key, 'decision', decision.decisionPolicyId, {
      nodeRole: 'aggregate',
      status: decision.decisionStatus === 'decided'
        ? 'ok'
        : decision.decisionStatus === 'failed' ? 'failed' : 'warning',
      binding: {
        bindingStrength: 'content-hash',
        keys: { decisionDigest: decision.decisionDigest },
      },
      attrs: {
        display: {
          decisionStatus: decision.decisionStatus,
          ...(decision.decisionStatus === 'decided' ? { verdict: decision.verdict } : {}),
        },
      },
      evidenceRefs: evidence(
        report.reportId,
        documentHash.get('evaluation-report')!,
        CORE_RUN_DOCUMENT_FILES.evaluationReport,
        '/decision',
      ),
    });
    addEdge(`${runKey}:contains:${key}`, runNode, id, 'contains');
    for (const resultId of decision.analysisResultIds) {
      const analysisNode = analysisNodes.get(resultId);
      if (analysisNode !== undefined) {
        addEdge(`${key}:derived-from:${resultId}`, id, analysisNode, 'derived_from');
      }
    }
  }

  const targetKinds = new Set(plan.execution.targets.map((target) => target.targetKind));
  const artifactKind = targetKinds.size === 1
    && ['skill', 'prompt', 'agent', 'workflow'].includes([...targetKinds][0])
    ? [...targetKinds][0] as ArtifactGraphDocument['scope']['artifactKind']
    : undefined;
  const document: ArtifactGraphDocument = {
    documentKind: 'artifact-graph',
    schemaVersion: 1,
    graphId: `core-eval:${report.reportDigest}`,
    generatedAt: input.generatedAt,
    source: {
      sourceKind: 'eval',
      sourceId: report.reportId,
      ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
    },
    scope: {
      cwd: input.cwd,
      ...(artifactKind === undefined ? {} : { artifactKind }),
      sampleSetHash: plan.digests.datasetRevisionDigest,
    },
    nodes,
    edges,
    summaries: [{
      summaryKind: 'coverage',
      title: 'Evaluation Core stage coverage',
      severity: report.status.evidenceStatus === 'complete' ? 'info' : 'medium',
      nodeIds: [runNode],
      evidenceRefs: evidence(
        manifest.reportId,
        digestCanonicalJson(manifest),
        'manifest.json',
        '/status',
      ),
    }],
  };
  if (parseArtifactGraphDocument(document) === null) {
    throw new CoreDownstreamProjectionError(
      'CORE_PROJECTION_SOURCE_INVALID',
      'Core artifact graph projection produced an invalid graph document.',
    );
  }
  return document;
}

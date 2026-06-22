import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { graphFileName } from '../eval-core/artifact-file-names.js';
import type {
  ArtifactGraphBinding,
  ArtifactGraphDocument,
  ArtifactGraphEdge,
  ArtifactGraphEdgeKind,
  ArtifactGraphEvidenceRef,
  ArtifactGraphNode,
  ArtifactGraphNodeKind,
  ArtifactGraphNodeRole,
  ArtifactGraphStatus,
  EvaluationReport,
  SampleCoverageTarget,
  SampleCoverageTargetKind,
  SampleSnapshot,
  VariantConfig,
  VariantResult,
} from '../types/index.js';

export interface BuildEvalGraphOptions {
  report: EvaluationReport;
  sourcePath: string;
  generatedAt?: string;
}

export interface PersistEvalGraphOptions extends BuildEvalGraphOptions {
  outputDir: string;
  fileStem?: string;
}

export interface PersistEvalGraphResult {
  graphPath: string;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function jsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function sampleSetHash(sampleHashes: Record<string, string> | undefined): string | undefined {
  if (!sampleHashes || Object.keys(sampleHashes).length === 0) return undefined;
  const canonical = Object.entries(sampleHashes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, hash]) => `${id}:${hash}`)
    .join('|');
  return shortHash(canonical);
}

function statusFromScore(score: number | undefined): ArtifactGraphStatus {
  // Display band only. This is not the verdict gate and intentionally does not
  // reference DEFAULT_GATE_THRESHOLD or statistical significance decisions.
  if (score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= 4) return 'ok';
  if (score >= 3) return 'warning';
  return 'failed';
}

function assertionStatus(result: VariantResult): ArtifactGraphStatus {
  // Assertion topology status only. Pure LLM-scored samples have no assertion
  // pass/fail edge, so they stay unknown here even when compositeScore is high.
  if (result.error || !result.ok) return 'failed';
  const details = result.assertions?.details;
  if (!details || details.length === 0) return 'unknown';
  return details.every((detail) => detail.passed) ? 'ok' : 'failed';
}

function artifactBinding(variant: string, hash: string | undefined): ArtifactGraphBinding {
  if (hash && hash !== 'no-skill') {
    return { bindingStrength: 'content-hash', keys: { artifactHash: hash } };
  }
  return { bindingStrength: 'name-only', keys: { variantName: variant } };
}

function sampleBinding(sampleId: string, hash: string | undefined): ArtifactGraphBinding {
  if (hash) {
    return { bindingStrength: 'content-hash', keys: { sampleHash: hash } };
  }
  return { bindingStrength: 'name-only', keys: { sampleId } };
}

function variantConfigByName(report: EvaluationReport): Map<string, VariantConfig> {
  return new Map((report.meta.variantConfigs ?? []).map((config) => [config.variant, config]));
}

function scopeArtifactKind(report: EvaluationReport): ArtifactGraphDocument['scope']['artifactKind'] {
  const kinds = new Set((report.meta.variantConfigs ?? [])
    .map((config) => config.artifactKind)
    .filter((kind) => kind !== 'baseline'));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

function sampleEvidence(report: EvaluationReport, sampleId: string): ArtifactGraphEvidenceRef[] {
  return [{
    sourceKind: 'sample',
    sourceId: sampleId,
    selector: { selectorKind: 'sample-id', value: sampleId },
    contentHash: report.meta.sampleHashes?.[sampleId],
    label: sampleId,
  }];
}

function evalResultEvidence(report: EvaluationReport, resultIndex: number, variant: string): ArtifactGraphEvidenceRef[] {
  return [{
    sourceKind: 'eval-report',
    sourceId: report.id,
    selector: {
      selectorKind: 'json-pointer',
      value: `/results/${resultIndex}/variants/${jsonPointerToken(variant)}`,
    },
    label: `${variant} result`,
  }];
}

function assertionEvidence(
  report: EvaluationReport,
  sampleId: string,
  index: number,
  resultIndex?: number,
  variant?: string,
): ArtifactGraphEvidenceRef[] {
  if (report.sampleSnapshots?.[sampleId]?.assertions?.[index]) {
    return [{
      sourceKind: 'sample',
      sourceId: sampleId,
      selector: {
        selectorKind: 'json-pointer',
        value: `/sampleSnapshots/${jsonPointerToken(sampleId)}/assertions/${index}`,
      },
      contentHash: report.meta.sampleHashes?.[sampleId],
      label: `assertion ${index + 1}`,
    }];
  }
  if (resultIndex !== undefined && variant !== undefined) {
    return [{
      sourceKind: 'eval-report',
      sourceId: report.id,
      selector: {
        selectorKind: 'json-pointer',
        value: `/results/${resultIndex}/variants/${jsonPointerToken(variant)}/assertions/details/${index}`,
      },
      label: `${variant} assertion ${index + 1}`,
    }];
  }
  return [{
    sourceKind: 'sample',
    sourceId: sampleId,
    contentHash: report.meta.sampleHashes?.[sampleId],
    label: `assertion ${index + 1}`,
  }];
}

function sampleStableKey(report: EvaluationReport, sampleId: string): string {
  const hash = report.meta.sampleHashes?.[sampleId];
  return hash ? `v1:sample:${hash}` : `v1:sample:${report.id}:${sampleId}`;
}

function assertionStableKey(report: EvaluationReport, sampleId: string, index: number): string {
  return `${sampleStableKey(report, sampleId)}:assertion:${index}`;
}

function sampleAttrs(snapshot: SampleSnapshot | undefined): ArtifactGraphNode['attrs'] | undefined {
  if (!snapshot) return undefined;
  const display: Record<string, unknown> = {};
  if (snapshot.capability?.length) display.capability = snapshot.capability;
  if (snapshot.construct) display.construct = snapshot.construct;
  if (snapshot.difficulty) display.difficulty = snapshot.difficulty;
  if (snapshot.provenance) display.provenance = snapshot.provenance;
  if (snapshot.tripwire) display.tripwire = true;
  if (snapshot.assertions?.length) display.assertionCount = snapshot.assertions.length;
  if (snapshot.covers?.length) display.declaredCoverageTargetCount = snapshot.covers.length;
  return Object.keys(display).length > 0 ? { display } : undefined;
}

const COVERAGE_TARGET_NODE_KIND: Record<SampleCoverageTargetKind, ArtifactGraphNodeKind> = {
  skill: 'skill',
  skill_file: 'skill_file',
  frontmatter: 'frontmatter',
  reference: 'reference',
  script: 'script',
  hard_rule: 'hard_rule',
  workflow: 'workflow',
  workflow_node: 'workflow_node',
};

function normalizeCoverageRef(target: SampleCoverageTarget): string {
  const raw = target.ref.trim().replaceAll('\\', '/');
  if (target.targetKind === 'reference' || target.targetKind === 'script' || target.targetKind === 'skill_file') {
    return raw.replace(/^\/+/, '').replace(/^\.\//, '');
  }
  return raw;
}

function coverageTargetStableKey(target: SampleCoverageTarget, artifactHash: string): string {
  const ref = normalizeCoverageRef(target);
  switch (target.targetKind) {
    case 'skill':
      return `v1:skill:${artifactHash}`;
    case 'skill_file':
      return `v1:skill-file:${artifactHash}:${ref || 'SKILL.md'}`;
    case 'frontmatter':
      return `v1:frontmatter:${artifactHash}`;
    case 'reference':
      return `v1:reference:${artifactHash}:${ref}`;
    case 'script':
      return `v1:script:${artifactHash}:${ref}`;
    case 'hard_rule':
      return `v1:hard-rule:${artifactHash}:${ref}`;
    case 'workflow':
      return `v1:workflow:${artifactHash}:${ref}`;
    case 'workflow_node':
      return `v1:workflow-node:${artifactHash}:${ref}`;
  }
}

function coverageTargetLabel(target: SampleCoverageTarget): string {
  const ref = normalizeCoverageRef(target);
  switch (target.targetKind) {
    case 'skill':
      return ref && ref !== 'skill' ? ref : 'SKILL.md';
    case 'skill_file':
      return ref || 'SKILL.md';
    case 'frontmatter':
      return 'frontmatter';
    default:
      return ref;
  }
}

function coverageEvidence(
  report: EvaluationReport,
  sampleId: string,
  targetIndex: number,
  target: SampleCoverageTarget,
): ArtifactGraphEvidenceRef[] {
  return [{
    sourceKind: 'sample',
    sourceId: sampleId,
    selector: {
      selectorKind: 'json-pointer',
      value: `/sampleSnapshots/${jsonPointerToken(sampleId)}/covers/${targetIndex}`,
    },
    contentHash: report.meta.sampleHashes?.[sampleId],
    label: `${sampleId} covers ${target.targetKind}:${normalizeCoverageRef(target)}`,
  }];
}

export function evalGraphDirForReportOutput(reportOutputDir: string): string {
  return basename(reportOutputDir) === 'reports'
    ? join(dirname(reportOutputDir), 'graphs', 'eval')
    : join(reportOutputDir, 'graphs', 'eval');
}

export function buildEvalArtifactGraph(options: BuildEvalGraphOptions): ArtifactGraphDocument {
  const { report, sourcePath } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const nodes: ArtifactGraphNode[] = [];
  const edges: ArtifactGraphEdge[] = [];
  const nodeIdsByStableKey = new Map<string, string>();
  const configs = variantConfigByName(report);
  const skillArtifacts = report.meta.variants
    .map((variant) => ({
      variant,
      artifactHash: report.meta.artifactHashes?.[variant],
      config: configs.get(variant),
    }))
    .filter((item): item is { variant: string; artifactHash: string; config: VariantConfig } =>
      item.config?.artifactKind === 'skill'
        && typeof item.artifactHash === 'string'
        && item.artifactHash.length > 0
        && item.artifactHash !== 'no-skill',
    );

  const addNode = (
    stableKey: string,
    nodeKind: ArtifactGraphNodeKind,
    nodeRole: ArtifactGraphNodeRole,
    label: string,
    extra: Partial<ArtifactGraphNode> = {},
  ): string => {
    const existing = nodeIdsByStableKey.get(stableKey);
    if (existing) return existing;
    const id = `node:${shortHash(stableKey)}`;
    nodeIdsByStableKey.set(stableKey, id);
    nodes.push({
      id,
      stableKey,
      nodeKind,
      nodeRole,
      layer: 'measurement',
      label,
      ...extra,
    });
    return id;
  };

  const addEdge = (
    fromNodeId: string,
    toNodeId: string,
    edgeKind: ArtifactGraphEdgeKind,
    extra: Partial<ArtifactGraphEdge> = {},
  ): void => {
    const id = `edge:${shortHash(`${fromNodeId}|${edgeKind}|${toNodeId}|${edges.length}`)}`;
    edges.push({
      id,
      fromNodeId,
      toNodeId,
      edgeKind,
      layer: 'measurement',
      ...extra,
    });
  };

  const addCoverageEdges = (sampleId: string, sampleNodeId: string, snapshot: SampleSnapshot): void => {
    if (!snapshot.covers?.length || skillArtifacts.length === 0) return;
    const seen = new Set<string>();
    snapshot.covers.forEach((target, targetIndex) => {
      const targetRef = normalizeCoverageRef(target);
      if (!targetRef && target.targetKind !== 'skill' && target.targetKind !== 'frontmatter') return;
      for (const artifact of skillArtifacts) {
        const stableKey = coverageTargetStableKey(target, artifact.artifactHash);
        const dedupeKey = `${sampleNodeId}|${stableKey}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const evidenceRefs = coverageEvidence(report, sampleId, targetIndex, target);
        const targetNodeId = addNode(
          stableKey,
          COVERAGE_TARGET_NODE_KIND[target.targetKind],
          'entity',
          coverageTargetLabel(target),
          {
            binding: { bindingStrength: 'content-hash', keys: { artifactHash: artifact.artifactHash } },
            attrs: {
              display: {
                targetKind: target.targetKind,
                ref: targetRef,
                variant: artifact.variant,
                sourceLocator: artifact.config.locator,
              },
            },
            evidenceRefs,
          },
        );
        addEdge(sampleNodeId, targetNodeId, 'covers', {
          confidence: 1,
          binding: {
            bindingStrength: 'explicit',
            keys: {
              sampleId,
              targetKind: target.targetKind,
              targetRef,
              artifactHash: artifact.artifactHash,
            },
          },
          attrs: { producer: { source: 'sample.covers' } },
          evidenceRefs,
        });
      }
    });
  };

  const variantNodeIds = new Map<string, string>();
  for (const variant of report.meta.variants) {
    const artifactHash = report.meta.artifactHashes?.[variant];
    const config = configs.get(variant);
    const variantNodeId = addNode(
      `v1:variant:${report.id}:${variant}`,
      'variant',
      'entity',
      variant,
      {
        status: statusFromScore(report.summary?.[variant]?.avgCompositeScore),
        binding: artifactBinding(variant, artifactHash),
        metrics: {
          ...(report.summary?.[variant]?.avgCompositeScore !== undefined
            ? { avgCompositeScore: report.summary[variant].avgCompositeScore as number }
            : {}),
          ...(report.summary?.[variant]?.totalSamples !== undefined
            ? { totalSamples: report.summary[variant].totalSamples }
            : {}),
        },
        attrs: {
          display: {
            ...(config ? {
              artifactKind: config.artifactKind,
              artifactSource: config.artifactSource,
              experimentRole: config.experimentRole,
              executionStrategy: config.executionStrategy,
            } : {}),
          },
        },
        evidenceRefs: [{
          sourceKind: 'eval-report',
          sourceId: report.id,
          selector: { selectorKind: 'json-pointer', value: `/summary/${jsonPointerToken(variant)}` },
          label: `${variant} summary`,
        }],
      },
    );
    variantNodeIds.set(variant, variantNodeId);

    if (config?.artifactKind === 'skill' && artifactHash && artifactHash !== 'no-skill') {
      const skillNodeId = addNode(
        `v1:skill:${artifactHash}`,
        'skill',
        'entity',
        variant,
        {
          binding: { bindingStrength: 'content-hash', keys: { artifactHash } },
          attrs: {
            display: {
              variant,
              sourceLocator: config.locator,
            },
          },
          evidenceRefs: [{
            sourceKind: 'eval-report',
            sourceId: report.id,
            selector: { selectorKind: 'json-pointer', value: `/meta/artifactHashes/${jsonPointerToken(variant)}` },
            contentHash: artifactHash,
            label: `${variant} artifact hash`,
          }],
        },
      );
      addEdge(variantNodeId, skillNodeId, 'derived_from');
    }
  }

  for (const [sampleId, snapshot] of Object.entries(report.sampleSnapshots ?? {})) {
    const sampleNodeId = addNode(
      sampleStableKey(report, sampleId),
      'sample',
      'entity',
      sampleId,
      {
        binding: sampleBinding(sampleId, report.meta.sampleHashes?.[sampleId]),
        attrs: sampleAttrs(snapshot),
        evidenceRefs: sampleEvidence(report, sampleId),
      },
    );
    snapshot.assertions?.forEach((assertion, index) => {
      const assertionNodeId = addNode(
        assertionStableKey(report, sampleId, index),
        'assertion',
        'entity',
        `assertion: ${assertion.type}`,
        {
          attrs: { display: { type: assertion.type, weight: assertion.weight ?? 1 } },
          evidenceRefs: assertionEvidence(report, sampleId, index),
        },
      );
      addEdge(sampleNodeId, assertionNodeId, 'contains');
    });
    addCoverageEdges(sampleId, sampleNodeId, snapshot);
  }

  for (const [resultIndex, result] of report.results.entries()) {
    const sampleNodeId = addNode(
      sampleStableKey(report, result.sample_id),
      'sample',
      'entity',
      result.sample_id,
      {
        binding: sampleBinding(result.sample_id, report.meta.sampleHashes?.[result.sample_id]),
        attrs: sampleAttrs(report.sampleSnapshots?.[result.sample_id]),
        evidenceRefs: sampleEvidence(report, result.sample_id),
      },
    );

    for (const [variant, variantResult] of Object.entries(result.variants)) {
      const variantNodeId = variantNodeIds.get(variant);
      if (!variantNodeId) continue;
      addEdge(variantNodeId, sampleNodeId, 'evaluates', {
        status: assertionStatus(variantResult),
        evidenceRefs: evalResultEvidence(report, resultIndex, variant),
      });

      const evalResultNodeId = addNode(
        `v1:eval-result:${report.id}:${variant}:${result.sample_id}`,
        'eval_result',
        'observation',
        `${variant} / ${result.sample_id}`,
        {
          status: assertionStatus(variantResult),
          metrics: {
            durationMs: variantResult.durationMs,
            costUSD: variantResult.costUSD,
            ...(variantResult.compositeScore !== undefined ? { compositeScore: variantResult.compositeScore } : {}),
            ...(variantResult.llmScore !== undefined ? { llmScore: variantResult.llmScore } : {}),
            ...(variantResult.assertions ? { assertionScore: variantResult.assertions.score } : {}),
          },
          attrs: {
            display: {
              ok: variantResult.ok,
              ...(variantResult.error ? { error: variantResult.error } : {}),
            },
          },
          evidenceRefs: evalResultEvidence(report, resultIndex, variant),
        },
      );
      addEdge(evalResultNodeId, variantNodeId, 'derived_from');
      addEdge(evalResultNodeId, sampleNodeId, 'evaluates');

      variantResult.assertions?.details.forEach((detail, index) => {
        const assertionNodeId = addNode(
          assertionStableKey(report, result.sample_id, index),
          'assertion',
          'entity',
          `assertion: ${detail.type}`,
          {
            attrs: { display: { type: detail.type, weight: detail.weight } },
            evidenceRefs: assertionEvidence(report, result.sample_id, index, resultIndex, variant),
          },
        );
        addEdge(evalResultNodeId, assertionNodeId, detail.passed ? 'passes' : 'fails', {
          status: detail.passed ? 'ok' : 'failed',
          evidenceRefs: evalResultEvidence(report, resultIndex, variant),
        });
      });

      for (const [dimension, dimensionResult] of Object.entries(variantResult.dimensions ?? {})) {
        const dimensionNodeId = addNode(
          `v1:judge-dimension:${report.id}:${variant}:${result.sample_id}:${dimension}`,
          'judge_dimension',
          'observation',
          dimension,
          {
            status: statusFromScore(dimensionResult.score),
            metrics: { score: dimensionResult.score },
            attrs: { display: { reason: dimensionResult.reason } },
            evidenceRefs: evalResultEvidence(report, resultIndex, variant),
          },
        );
        addEdge(dimensionNodeId, evalResultNodeId, 'derived_from');
      }

      if (variantResult.diagnostic) {
        const diagnosticNodeId = addNode(
          `v1:diagnostic:${report.id}:${variant}:${result.sample_id}`,
          'diagnostic',
          'observation',
          `diagnostic: ${variant} / ${result.sample_id}`,
          {
            status: variantResult.diagnostic.ok ? 'warning' : 'failed',
            attrs: {
              display: {
                rootCause: variantResult.diagnostic.rootCause,
                failureModes: variantResult.diagnostic.failureModes ?? [],
              },
            },
            evidenceRefs: evalResultEvidence(report, resultIndex, variant),
          },
        );
        addEdge(diagnosticNodeId, evalResultNodeId, 'diagnoses', {
          status: variantResult.diagnostic.ok ? 'warning' : 'failed',
        });
      }
    }
  }

  return {
    documentKind: 'artifact-graph',
    schemaVersion: 1,
    graphId: `eval:${report.id}`,
    generatedAt,
    source: {
      sourceKind: 'eval',
      sourceId: report.id,
      sourcePath,
      cliVersion: report.meta.cliVersion,
    },
    scope: {
      cwd: process.cwd(),
      artifactKind: scopeArtifactKind(report),
      sourceLocator: report.meta.request?.samplesPath,
      sampleSetHash: sampleSetHash(report.meta.sampleHashes),
    },
    nodes,
    edges,
    summaries: [{
      summaryKind: 'coverage',
      title: 'Eval measurement graph',
      severity: report.results.some((result) => Object.values(result.variants).some((variant) => assertionStatus(variant) === 'failed'))
        ? 'medium'
        : 'info',
    }],
  };
}

export function persistEvalGraphSidecar(options: PersistEvalGraphOptions): PersistEvalGraphResult {
  const graphDir = evalGraphDirForReportOutput(options.outputDir);
  if (!existsSync(graphDir)) mkdirSync(graphDir, { recursive: true });
  const fileStem = options.fileStem ?? options.report.id;
  const graphPath = join(graphDir, graphFileName(fileStem));
  const graph = buildEvalArtifactGraph(options);
  writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  return { graphPath };
}

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, _resetSkillIndexCache } from '../../src/server/skill-index.js';
import { renderSkillDetail } from '../../src/renderer/skill-detail-renderer.js';
import { renderSkillList } from '../../src/renderer/skill-list-renderer.js';
import { graphFileName, reportFileName } from '../../src/eval-core/artifact-file-names.js';
import type { ArtifactGraphDocument, DoctorReport, EvaluationReport, SkillIndex } from '../../src/types/index.js';

function makeEvalReport(): EvaluationReport {
  return {
    kind: 'evaluation',
    id: 'service-guide-20260621T120000-abcd',
    meta: {
      variants: ['baseline', 'service-guide', 'release-helper'],
      model: 'fixture',
      executor: 'fixture',
      sampleCount: 2,
      taskCount: 4,
      totalCostUSD: 0,
      timestamp: '2026-06-21T12:00:00.000Z',
      cliVersion: '0.0.0-test',
      nodeVersion: process.version,
      artifactHashes: { baseline: 'no-skill', 'service-guide': 'hash-service-guide', 'release-helper': 'hash-release-helper' },
      sampleHashes: { s001: 'sample-1', s002: 'sample-2' },
      judgeModels: [],
      variantConfigs: [
        {
          variant: 'service-guide',
          artifactKind: 'skill',
          artifactSource: 'file-path',
          artifactPath: '/repo/skills/service-guide/SKILL.md',
          executionStrategy: 'system-prompt',
          experimentType: 'artifact-injection',
          experimentRole: 'treatment',
          hasArtifactContent: true,
          cwd: null,
          locator: '/repo/skills/service-guide/SKILL.md',
        },
        {
          variant: 'release-helper',
          artifactKind: 'skill',
          artifactSource: 'file-path',
          artifactPath: '/repo/skills/release-helper/SKILL.md',
          executionStrategy: 'system-prompt',
          experimentType: 'artifact-injection',
          experimentRole: 'treatment',
          hasArtifactContent: true,
          cwd: null,
          locator: '/repo/skills/release-helper/SKILL.md',
        },
      ],
    },
    summary: {
      'service-guide': {
        totalSamples: 2,
        successCount: 2,
        errorCount: 0,
        errorRate: 0,
        avgCompositeScore: 3.2,
      },
      'release-helper': {
        totalSamples: 2,
        successCount: 2,
        errorCount: 0,
        errorRate: 0,
        avgCompositeScore: 2.1,
      },
    },
    sampleSnapshots: {
      s001: { sample_id: 's001', prompt: '检查发布风险', assertions: [{ type: 'contains_any', values: ['rollback'] }] },
      s002: { sample_id: 's002', prompt: '处理回滚缺口', assertions: [{ type: 'contains_all', values: ['owner'] }] },
    },
    results: [
      {
        sample_id: 's001',
        variants: {
          'service-guide': {
            ok: true,
            durationMs: 10,
            durationApiMs: 8,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            execCostUSD: 0,
            judgeCostUSD: 0,
            costUSD: 0,
            numTurns: 1,
            compositeScore: 4,
            assertions: { passed: 1, total: 1, score: 5, details: [{ type: 'contains_any', value: 'rollback', weight: 1, passed: true }] },
          },
          'release-helper': {
            ok: true,
            durationMs: 10,
            durationApiMs: 8,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            execCostUSD: 0,
            judgeCostUSD: 0,
            costUSD: 0,
            numTurns: 1,
            compositeScore: 1.5,
            assertions: { passed: 0, total: 1, score: 1, details: [{ type: 'contains_any', value: 'handoff', weight: 1, passed: false }] },
            diagnostic: { ok: false, rootCause: ['missing_handoff'], failureModes: ['other'] },
          },
        },
      },
      {
        sample_id: 's002',
        variants: {
          'service-guide': {
            ok: true,
            durationMs: 10,
            durationApiMs: 8,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            execCostUSD: 0,
            judgeCostUSD: 0,
            costUSD: 0,
            numTurns: 1,
            compositeScore: 2.5,
            assertions: { passed: 0, total: 1, score: 1, details: [{ type: 'contains_all', value: 'owner', weight: 1, passed: false }] },
            diagnostic: { ok: true, rootCause: ['missing_owner'], failureModes: ['skill-doc-gap'] },
          },
          'release-helper': {
            ok: true,
            durationMs: 10,
            durationApiMs: 8,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            execCostUSD: 0,
            judgeCostUSD: 0,
            costUSD: 0,
            numTurns: 1,
            compositeScore: 2.7,
            assertions: { passed: 1, total: 1, score: 5, details: [{ type: 'contains_all', value: 'owner', weight: 1, passed: true }] },
          },
        },
      },
    ],
  } as unknown as EvaluationReport;
}

function makeDoctorReport(): DoctorReport {
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: 'service-guide-doctor-20260621T115900-abcd',
    timestamp: '2026-06-21T11:59:00.000Z',
    cliVersion: '0.0.0-test',
    cwd: '/repo',
    executorName: 'fixture',
    model: 'fixture',
    outcome: 'passed',
    totals: { pass: 1, warn: 0, fail: 0 },
    ruleStats: { pass: 1, warn: 0, fail: 0, skipped: 0, total: 1 },
    skills: [{
      skillName: 'service-guide',
      skillPath: '/repo/skills/service-guide/SKILL.md',
      status: 'pass',
      results: [{
        ruleId: 'skill_readable',
        severity: 'fatal',
        labelKey: 'cli.doctor.rule.skill_readable',
        status: 'pass',
        message: 'readable',
        durationMs: 1,
      }],
    }],
  } as DoctorReport;
}

function doctorGraph(): ArtifactGraphDocument {
  return {
    documentKind: 'artifact-graph',
    schemaVersion: 1,
    graphId: 'doctor:service-guide-doctor-20260621T115900-abcd:service-guide',
    generatedAt: '2026-06-21T11:59:00.000Z',
    source: { sourceKind: 'doctor', sourceId: 'service-guide-doctor-20260621T115900-abcd', sourcePath: '/repo/.omk/doctors/service-guide.report.json' },
    scope: { cwd: '/repo', artifactKind: 'skill', skillName: 'service-guide', artifactHash: 'hash-service-guide', sourceLocator: '/repo/skills/service-guide/SKILL.md' },
    nodes: [
      { id: 'skill', stableKey: 'v1:skill:hash-service-guide', nodeKind: 'skill', nodeRole: 'entity', layer: 'definition', label: 'service-guide', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-service-guide' } } },
      { id: 'ref', stableKey: 'v1:reference:hash-service-guide:references/a.md', nodeKind: 'reference', nodeRole: 'entity', layer: 'definition', label: 'references/a.md' },
      { id: 'script', stableKey: 'v1:script:hash-service-guide:scripts/a.sh', nodeKind: 'script', nodeRole: 'entity', layer: 'definition', label: 'scripts/a.sh' },
      { id: 'frontmatter', stableKey: 'v1:frontmatter:hash-service-guide', nodeKind: 'frontmatter', nodeRole: 'entity', layer: 'definition', label: 'frontmatter' },
      { id: 'wf', stableKey: 'v1:workflow:hash-service-guide:release', nodeKind: 'workflow', nodeRole: 'entity', layer: 'definition', label: 'release' },
      { id: 'wfn', stableKey: 'v1:workflow-node:hash-service-guide:release.check', nodeKind: 'workflow_node', nodeRole: 'entity', layer: 'definition', label: '检查发布' },
      { id: 'rule', stableKey: 'v1:hard-rule:hash-service-guide:cite', nodeKind: 'hard_rule', nodeRole: 'entity', layer: 'definition', label: 'cite' },
      { id: 'rule2', stableKey: 'v1:hard-rule:hash-service-guide:rollback', nodeKind: 'hard_rule', nodeRole: 'entity', layer: 'definition', label: 'rollback' },
      { id: 'rule3', stableKey: 'v1:hard-rule:hash-service-guide:handoff', nodeKind: 'hard_rule', nodeRole: 'entity', layer: 'definition', label: 'handoff', status: 'ok' },
    ],
    edges: [
      { id: 'e1', fromNodeId: 'skill', toNodeId: 'ref', edgeKind: 'references', layer: 'definition' },
      { id: 'e2', fromNodeId: 'skill', toNodeId: 'script', edgeKind: 'contains', layer: 'definition' },
    ],
  };
}

function evalGraph(): ArtifactGraphDocument {
  return {
    documentKind: 'artifact-graph',
    schemaVersion: 1,
    graphId: 'eval:service-guide-20260621T120000-abcd',
    generatedAt: '2026-06-21T12:00:00.000Z',
    source: { sourceKind: 'eval', sourceId: 'service-guide-20260621T120000-abcd', sourcePath: '/repo/.omk/reports/service-guide.report.json' },
    scope: { cwd: '/repo', artifactKind: 'skill', sourceLocator: '/repo/.omk/samples.json', sampleSetHash: 'sample-set' },
    nodes: [
      { id: 'skill', stableKey: 'v1:skill:hash-service-guide', nodeKind: 'skill', nodeRole: 'entity', layer: 'measurement', label: 'service-guide', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-service-guide' } }, attrs: { display: { sourceLocator: '/repo/skills/service-guide/SKILL.md' } } },
      { id: 'variant', stableKey: 'v1:variant:service-guide-20260621T120000-abcd:service-guide', nodeKind: 'variant', nodeRole: 'entity', layer: 'measurement', label: 'service-guide', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-service-guide' } } },
      { id: 'skill-other', stableKey: 'v1:skill:hash-release-helper', nodeKind: 'skill', nodeRole: 'entity', layer: 'measurement', label: 'release-helper', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-release-helper' } }, attrs: { display: { sourceLocator: '/repo/skills/release-helper/SKILL.md' } } },
      { id: 'variant-other', stableKey: 'v1:variant:service-guide-20260621T120000-abcd:release-helper', nodeKind: 'variant', nodeRole: 'entity', layer: 'measurement', label: 'release-helper', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-release-helper' } } },
      { id: 's001', stableKey: 'v1:sample:sample-1', nodeKind: 'sample', nodeRole: 'entity', layer: 'measurement', label: 's001' },
      { id: 's002', stableKey: 'v1:sample:sample-2', nodeKind: 'sample', nodeRole: 'entity', layer: 'measurement', label: 's002' },
      { id: 'a1', stableKey: 'v1:sample:sample-1:assertion:0', nodeKind: 'assertion', nodeRole: 'entity', layer: 'measurement', label: 'assertion: contains_any' },
      { id: 'a2', stableKey: 'v1:sample:sample-2:assertion:0', nodeKind: 'assertion', nodeRole: 'entity', layer: 'measurement', label: 'assertion: contains_all' },
      { id: 'a3', stableKey: 'v1:sample:sample-1:assertion:extra', nodeKind: 'assertion', nodeRole: 'entity', layer: 'measurement', label: 'assertion: contains_any' },
      { id: 'er1', stableKey: 'v1:eval-result:service-guide-20260621T120000-abcd:service-guide:s001', nodeKind: 'eval_result', nodeRole: 'observation', layer: 'measurement', label: 'service-guide / s001' },
      { id: 'er2', stableKey: 'v1:eval-result:service-guide-20260621T120000-abcd:service-guide:s002', nodeKind: 'eval_result', nodeRole: 'observation', layer: 'measurement', label: 'service-guide / s002' },
      { id: 'er-other', stableKey: 'v1:eval-result:service-guide-20260621T120000-abcd:release-helper:s001', nodeKind: 'eval_result', nodeRole: 'observation', layer: 'measurement', label: 'release-helper / s001' },
      { id: 'diag', stableKey: 'v1:diagnostic:service-guide-20260621T120000-abcd:service-guide:s002', nodeKind: 'diagnostic', nodeRole: 'observation', layer: 'measurement', label: 'diagnostic: service-guide / s002' },
      { id: 'diag-other', stableKey: 'v1:diagnostic:service-guide-20260621T120000-abcd:release-helper:s001', nodeKind: 'diagnostic', nodeRole: 'observation', layer: 'measurement', label: 'diagnostic: release-helper / s001' },
      { id: 'cover-ref', stableKey: 'v1:reference:hash-service-guide:references/a.md', nodeKind: 'reference', nodeRole: 'entity', layer: 'measurement', label: 'references/a.md', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-service-guide' } } },
      { id: 'cover-workflow', stableKey: 'v1:workflow:hash-service-guide:release', nodeKind: 'workflow', nodeRole: 'entity', layer: 'measurement', label: 'release', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-service-guide' } } },
      { id: 'cover-other', stableKey: 'v1:reference:hash-release-helper:references/a.md', nodeKind: 'reference', nodeRole: 'entity', layer: 'measurement', label: 'references/a.md', binding: { bindingStrength: 'content-hash', keys: { artifactHash: 'hash-release-helper' } } },
    ],
    edges: [
      { id: 'e1', fromNodeId: 'variant', toNodeId: 'skill', edgeKind: 'derived_from', layer: 'measurement' },
      { id: 'e2', fromNodeId: 'variant-other', toNodeId: 'skill-other', edgeKind: 'derived_from', layer: 'measurement' },
      { id: 'e3', fromNodeId: 'variant', toNodeId: 's001', edgeKind: 'evaluates', layer: 'measurement', status: 'ok' },
      { id: 'e4', fromNodeId: 'variant', toNodeId: 's002', edgeKind: 'evaluates', layer: 'measurement', status: 'failed' },
      { id: 'e5', fromNodeId: 'er1', toNodeId: 'variant', edgeKind: 'derived_from', layer: 'measurement' },
      { id: 'e6', fromNodeId: 'er1', toNodeId: 's001', edgeKind: 'evaluates', layer: 'measurement' },
      { id: 'e7', fromNodeId: 'er1', toNodeId: 'a1', edgeKind: 'passes', layer: 'measurement', status: 'ok' },
      { id: 'e8', fromNodeId: 'er2', toNodeId: 'variant', edgeKind: 'derived_from', layer: 'measurement' },
      { id: 'e9', fromNodeId: 'er2', toNodeId: 's002', edgeKind: 'evaluates', layer: 'measurement' },
      { id: 'e10', fromNodeId: 'er2', toNodeId: 'a2', edgeKind: 'fails', layer: 'measurement', status: 'failed' },
      { id: 'e11', fromNodeId: 'diag', toNodeId: 'er2', edgeKind: 'diagnoses', layer: 'measurement', status: 'warning' },
      { id: 'e12', fromNodeId: 'variant-other', toNodeId: 's001', edgeKind: 'evaluates', layer: 'measurement', status: 'failed' },
      { id: 'e13', fromNodeId: 'er-other', toNodeId: 'variant-other', edgeKind: 'derived_from', layer: 'measurement' },
      { id: 'e14', fromNodeId: 'er-other', toNodeId: 's001', edgeKind: 'evaluates', layer: 'measurement' },
      { id: 'e15', fromNodeId: 'er-other', toNodeId: 'a3', edgeKind: 'fails', layer: 'measurement', status: 'failed' },
      { id: 'e16', fromNodeId: 'diag-other', toNodeId: 'er-other', edgeKind: 'diagnoses', layer: 'measurement', status: 'failed' },
      { id: 'e17', fromNodeId: 's001', toNodeId: 'cover-ref', edgeKind: 'covers', layer: 'measurement', binding: { bindingStrength: 'explicit', keys: { sampleId: 's001', targetKind: 'reference', targetRef: 'references/a.md', artifactHash: 'hash-service-guide' } } },
      { id: 'e18', fromNodeId: 's002', toNodeId: 'cover-workflow', edgeKind: 'covers', layer: 'measurement', binding: { bindingStrength: 'explicit', keys: { sampleId: 's002', targetKind: 'workflow', targetRef: 'release', artifactHash: 'hash-service-guide' } } },
      { id: 'e19', fromNodeId: 's001', toNodeId: 'cover-other', edgeKind: 'covers', layer: 'measurement', binding: { bindingStrength: 'explicit', keys: { sampleId: 's001', targetKind: 'reference', targetRef: 'references/a.md', artifactHash: 'hash-release-helper' } } },
    ],
  };
}

describe('SkillIndex graph projection', () => {
  const cleanup: string[] = [];
  let oldIndexDir: string | undefined;

  beforeEach(() => {
    _resetSkillIndexCache();
    oldIndexDir = process.env.OMK_ARTIFACT_INDEX_DIR;
    const indexDir = mkdtempSync(join(tmpdir(), 'omk-graph-index-cards-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = indexDir;
    cleanup.push(indexDir);
  });

  afterEach(() => {
    if (oldIndexDir === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = oldIndexDir;
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('merges doctor and eval sidecar graphs into a skill-centric projection', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-skill-map-index-'));
    cleanup.push(tmp);
    const doctorsDir = join(tmp, '.omk', 'doctors');
    const analysesDir = join(tmp, '.omk', 'observe-health');
    const observationsDir = join(tmp, '.omk', 'observe-inbox');
    const doctorGraphDir = join(tmp, '.omk', 'graphs', 'doctor');
    const evalGraphDir = join(tmp, '.omk', 'graphs', 'eval');
    mkdirSync(doctorsDir, { recursive: true });
    mkdirSync(doctorGraphDir, { recursive: true });
    mkdirSync(evalGraphDir, { recursive: true });

    const report = makeEvalReport();
    const doctor = makeDoctorReport();
    writeFileSync(join(doctorsDir, reportFileName('service-guide-doctor-20260621T115900-abcd')), JSON.stringify(doctor, null, 2));
    writeFileSync(join(doctorGraphDir, graphFileName('service-guide-doctor-20260621T115900-abcd')), JSON.stringify(doctorGraph(), null, 2));
    writeFileSync(join(evalGraphDir, graphFileName(report.id)), JSON.stringify(evalGraph(), null, 2));

    const idx = buildSkillIndex([report], analysesDir, doctorsDir, observationsDir, {
      evalGraphDirs: [evalGraphDir],
      doctorGraphDirs: [doctorGraphDir],
    });

    const entry = idx.entries.find((item) => item.skillName === 'service-guide');
    assert.ok(entry);
    assert.equal(entry.graph?.bindingStrength, 'content-hash');
    assert.equal(entry.graph?.artifactHash, 'hash-service-guide');
    assert.equal(entry.graph?.doctor?.references, 1);
    assert.equal(entry.graph?.doctor?.scripts, 1);
    assert.equal(entry.graph?.doctor?.workflows, 1);
    assert.equal(entry.graph?.doctor?.workflowNodes, 1);
    assert.equal(entry.graph?.eval?.samples, 2);
    assert.equal(entry.graph?.eval?.assertions, 2);
    assert.equal(entry.graph?.eval?.failedAssertionEdges, 1);
    assert.equal(entry.graph?.eval?.diagnostics, 1);
    assert.equal(entry.graph?.eval?.variantName, 'service-guide');
    assert.equal(entry.graph?.eval?.nodeCount, 11);
    assert.equal(entry.graph?.eval?.edgeCount, 12);
    assert.equal(entry.graph?.eval?.coverageEdges, 2);
    assert.deepEqual(entry.graph?.eval?.declaredCoverageStableKeys, [
      'v1:reference:hash-service-guide:references/a.md',
      'v1:workflow:hash-service-guide:release',
    ]);
    assert.deepEqual(entry.graph?.eval?.declaredCoverageEdges, [
      {
        sampleStableKey: 'v1:sample:sample-1',
        sampleLabel: 's001',
        sampleStatus: 'ok',
        targetStableKey: 'v1:reference:hash-service-guide:references/a.md',
        targetNodeKind: 'reference',
        targetLabel: 'references/a.md',
      },
      {
        sampleStableKey: 'v1:sample:sample-2',
        sampleLabel: 's002',
        sampleStatus: 'failed',
        targetStableKey: 'v1:workflow:hash-service-guide:release',
        targetNodeKind: 'workflow',
        targetLabel: 'release',
      },
    ]);
    assert.equal(entry.graph?.eval?.measurementNodes.find((node) => node.label === 's002')?.status, 'failed');
    assert.equal(entry.graph?.eval?.measurementNodes.find((node) => node.label === 'assertion: contains_all')?.status, 'failed');
    assert.equal(
      entry.graph?.eval?.measurementNodes.find((node) => node.label === 'assertion: contains_all')?.parentSampleStableKey,
      'v1:sample:sample-2',
    );
    assert.equal(
      entry.graph?.eval?.measurementNodes.find((node) => node.nodeKind === 'diagnostic')?.parentSampleStableKey,
      'v1:sample:sample-2',
    );

    const html = renderSkillDetail(entry, report, 'zh');
    assert.match(html, /Skill Map/);
    assert.match(html, /复制图谱摘要/);
    assert.ok(html.includes('class="sm-svg"'));
    assert.ok(html.includes('class="sm-edge sm-edge--definition"'));
    assert.ok(html.includes('class="sm-edge sm-edge--measurement"'));
    assert.ok(!html.includes('class="sm-note"'));
    assert.ok(!html.includes('d="M 470 260 C'));
    assert.ok(html.includes('data-sm-leaf="1"'));
    assert.ok(html.includes('data-sm-draggable="1"'));
    assert.match(html, /data-sm-root[^>]*data-sm-node-id="skill-root"[^>]*data-sm-draggable="1"/);
    assert.match(html, /data-sm-root[^>]*role="button"[^>]*tabindex="0"/);
    assert.ok(html.includes('data-sm-node-id="definition-'));
    assert.ok(html.includes('data-sm-edge-to="definition-'));
    assert.ok(html.includes('data-sm-edge-from-node="skill-root"'));
    assert.ok(html.includes('data-sm-more-toggle="definition-group-references"'));
    assert.ok(html.includes('data-sm-more-toggle="definition-group-workflow"'));
    assert.ok(html.includes('data-sm-more-toggle="definition-group-rules"'));
    assert.ok(!html.includes('data-sm-more-toggle="definition-group-assets"'));
    assert.match(html, /data-sm-node-id="definition-group-references"[^>]*data-sm-draggable="1"/);
    assert.match(html, /data-sm-node-id="definition-group-rules-node-0"[^>]*data-sm-draggable="1"/);
    assert.match(html, /data-sm-node-id="definition-asset-0"[^>]*data-sm-draggable="1"/);
    assert.match(html, /data-sm-node-id="definition-asset-1"[^>]*data-sm-draggable="1"/);
    assert.ok(html.includes('<div class="sm-node-title">执行脚本</div>'));
    assert.ok(html.includes('<div class="sm-node-title">元信息</div>'));
    assert.ok(!html.includes('<div class="sm-node-kind">script</div>'));
    assert.ok(!html.includes('<div class="sm-node-kind">meta</div>'));
    assert.ok(html.includes('data-sm-overflow-group="definition-group-rules" hidden'));
    assert.ok(html.includes('data-sm-edge-from-node="definition-group-rules"'));
    assert.ok(html.includes('class="sm-node-toggle-icon"'));
    assert.ok(html.includes('border-right:1.8px solid currentColor'));
    assert.ok(!html.includes(".sm-node-toggle-icon::before { content:'+' }"));
    assert.ok(!html.includes(".sm-node[data-sm-more-toggle][aria-expanded=\"true\"] .sm-node-toggle-icon::before { content:'−' }"));
    assert.ok(html.includes('data-sm-collapsed-label="展开约束规则"'));
    assert.ok(html.includes('data-sm-expanded-label="收起约束规则"'));
    assert.ok(!html.includes('<div class="sm-node-title">收起'));
    assert.ok(html.includes('updateEdgesFromNode'));
    assert.ok(html.includes('refreshEdges'));
    assert.ok(html.includes('function nodesOverlapAt'));
    assert.ok(html.includes('function nearestOpenPosition'));
    assert.ok(html.includes('layoutVisibleNodes(false)'));
    assert.ok(html.includes('if (positionHasCollision(node, nextX, nextY)) return'));
    assert.ok(html.includes('suppressMoreClickUntil'));
    assert.ok(html.includes('data-sm-origin-x="'));
    assert.ok(html.includes('data-sm-root-x="560"'));
    assert.ok(html.includes('data-sm-boundary-x="560"'));
    assert.ok(html.includes('data-sm-evidence-x="125"'));
    assert.ok(html.includes('data-sm-chain="measurement-sample-0"'));
    assert.ok(html.includes('data-sm-parent-sample="measurement-sample-0"'));
    assert.ok(html.includes('data-sm-edge-from-node="measurement-sample-0"'));
    assert.ok(html.includes('评测用例'));
    assert.ok(html.includes('断言与诊断'));
    assert.ok(html.includes('关联知识'));
    assert.ok(html.includes('focusedChainId'));
    assert.ok(html.includes('sm-node.is-muted'));
    assert.ok(html.includes('applyViewPositions'));
    assert.ok(!html.includes('class="sm-bind"'));
    assert.ok(html.includes('class="sm-detail" data-sm-detail'));
    assert.ok(html.includes('data-sm-detail-title="SKILL.md"'));
    assert.ok(html.includes('data-sm-detail-kind="Skill 根节点"'));
    assert.ok(html.includes('data-sm-detail-kind="知识分组"'));
    assert.ok(html.includes('data-sm-detail-kind="引用文档"'));
    assert.ok(html.includes('data-sm-detail-coverage="已由评测用例声明"'));
    assert.ok(html.includes('data-sm-detail-coverage="尚未由评测用例声明"'));
    assert.ok(html.includes('data-sm-detail-expanded-status="已展开"'));
    assert.ok(html.includes('data-sm-detail-collapsed-status="已收起"'));
    assert.ok(html.includes('data-sm-detail-row="scope"'));
    assert.ok(html.includes('data-sm-detail-value="status"'));
    assert.ok(html.includes('setSelectedNode'));
    assert.ok(html.includes('aria-pressed'));
    assert.ok(!html.includes('aria-selected'));
    assert.ok(!html.includes('alert(1)'));
    assert.ok(!html.includes('ok" onclick'));
    assert.ok(!html.includes('ok&quot; onclick'));
    assert.ok(html.includes('sm-node--ok'));
    assert.ok(html.includes('sm-node--coverage-declared'));
    assert.ok(html.includes('sm-node--coverage-undeclared'));
    assert.ok(html.includes('class="sm-evidence-strip"'));
    assert.ok(!html.includes('当前短板'));
    assert.ok(html.includes('边界覆盖'));
    assert.ok(html.includes('未声明'));
    assert.ok(html.includes('失败证据'));
    assert.ok(!html.includes('<span class="si-sect-meta">2 条评测用例声明了 2/8 个结构节点</span>'));
    assert.ok(html.includes('引用材料'));
    assert.ok(html.includes('执行流程'));
    assert.ok(html.includes('约束规则'));
    assert.ok(!html.includes('辅助资产'));
    assert.ok(!html.includes('<div class="sm-node-kind">group</div>'));
    assert.ok(html.includes('sm-edge--coverage'));
    assert.ok(html.includes('data-sm-evidence-edge="1"'));
    assert.ok(html.includes('data-sm-detail-evidence='));
    assert.ok(html.includes('data-sm-detail-action='));
    assert.ok(html.includes('优先查看这条失败用例'));
    assert.ok(html.includes('由 s001 声明覆盖'));
    assert.ok(html.includes('s002（失败）'));
    assert.ok(html.includes('data-sm-detail-kind="评测用例"'));
    assert.ok(html.includes('sm-node-signal--failed'));
    assert.ok(html.includes('2 条评测用例声明了 2/8 个结构节点'));
    assert.ok(html.includes('这些关系来自 sample.covers'));
    assert.ok(html.includes('尚未声明只表示还没有被评测用例显式标注'));
    assert.ok(html.includes('background-size:auto,28px 28px,28px 28px,auto'));
    assert.ok(html.includes('outline:4px solid rgba(79,70,229,.07)'));
    assert.ok(html.includes('title="sample: s001"'));
    assert.ok(html.includes('<div class="sm-node-title">s001</div>'));
    assert.ok(html.includes('class="sm-stage-rail"'));
    assert.ok(html.indexOf('class="sm-stage-rail"') < html.indexOf('class="sm-toolbar"'));
    assert.ok(html.indexOf('class="sm-toolbar"') < html.indexOf('class="sm-canvas"'));
    assert.ok(!html.includes('sm-edge--stage'));
    assert.ok(html.includes('data-sm-action="zoom-in"'));
    assert.ok(html.includes('data-sm-action="zoom-out"'));
    assert.ok(html.includes('data-sm-view="boundary"'));
    assert.ok(html.includes('data-sm-view-button="boundary"'));
    assert.ok(html.includes('data-sm-view-button="evidence"'));
    assert.ok(html.includes('边界图'));
    assert.ok(html.includes('证据视图'));
    assert.ok(!html.includes('data-sm-toggle-layer="stage"'));
    assert.ok(!html.includes('data-sm-toggle-layer="measurement"'));
    assert.ok(html.includes('data-sm-toggle-leaves'));
    assert.ok(!html.includes('sm-branch'));
    assert.ok(html.includes('references/a.md'));
    assert.ok(html.includes('scripts/a.sh'));
    assert.ok(html.includes('frontmatter'));
    assert.ok(html.includes('workflow: release'));
    assert.ok(html.includes('sample: s001'));
    assert.ok(html.includes('assertion: contains_all'));
    assert.match(html, /variant 子图/);
    assert.match(html, /artifactHash/);
    assert.match(html, /binding/);
    assert.match(html, /doctorGraphId/);
    assert.match(html, /evalGraphId/);
  });

  it('does not claim content-hash binding when doctor and eval graphs point to different artifact hashes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-skill-map-mixed-'));
    cleanup.push(tmp);
    const doctorsDir = join(tmp, '.omk', 'doctors');
    const analysesDir = join(tmp, '.omk', 'observe-health');
    const observationsDir = join(tmp, '.omk', 'observe-inbox');
    const doctorGraphDir = join(tmp, '.omk', 'graphs', 'doctor');
    const evalGraphDir = join(tmp, '.omk', 'graphs', 'eval');
    mkdirSync(doctorsDir, { recursive: true });
    mkdirSync(doctorGraphDir, { recursive: true });
    mkdirSync(evalGraphDir, { recursive: true });

    const report = makeEvalReport();
    const doctor = makeDoctorReport();
    const staleDoctorGraph = doctorGraph();
    staleDoctorGraph.scope.artifactHash = 'hash-stale-service-guide';
    writeFileSync(join(doctorsDir, reportFileName('service-guide-doctor-20260621T115900-abcd')), JSON.stringify(doctor, null, 2));
    writeFileSync(join(doctorGraphDir, graphFileName('service-guide-doctor-20260621T115900-abcd')), JSON.stringify(staleDoctorGraph, null, 2));
    writeFileSync(join(evalGraphDir, graphFileName(report.id)), JSON.stringify(evalGraph(), null, 2));

    const idx = buildSkillIndex([report], analysesDir, doctorsDir, observationsDir, {
      evalGraphDirs: [evalGraphDir],
      doctorGraphDirs: [doctorGraphDir],
    });

    const entry = idx.entries.find((item) => item.skillName === 'service-guide');
    assert.ok(entry);
    assert.equal(entry.graph?.bindingStrength, 'mixed');
    assert.equal(entry.graph?.artifactHash, undefined);
    const html = renderSkillDetail(entry, report, 'zh');
    assert.ok(!html.includes('class="sm-bind"'));
    assert.match(html, /binding：`mixed`/);
  });

  it('uses the matched skill node locator for eval-only evidence cards instead of samplesPath', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-skill-map-eval-only-'));
    cleanup.push(tmp);
    const doctorsDir = join(tmp, '.omk', 'doctors');
    const analysesDir = join(tmp, '.omk', 'observe-health');
    const observationsDir = join(tmp, '.omk', 'observe-inbox');
    const evalGraphDir = join(tmp, '.omk', 'graphs', 'eval');
    mkdirSync(evalGraphDir, { recursive: true });

    const report = makeEvalReport();
    writeFileSync(join(evalGraphDir, graphFileName(report.id)), JSON.stringify(evalGraph(), null, 2));

    const idx = buildSkillIndex([report], analysesDir, doctorsDir, observationsDir, {
      evalGraphDirs: [evalGraphDir],
    });

    const entry = idx.entries.find((item) => item.skillName === 'service-guide');
    assert.ok(entry);
    assert.equal(entry.graph?.sourceLocator, '/repo/skills/service-guide/SKILL.md');
    assert.equal(entry.graph?.bindingStrength, 'content-hash');
    const html = renderSkillDetail(entry, report, 'zh');
    assert.ok(html.includes('omk doctor /repo/skills/service-guide/SKILL.md'));
    assert.ok(!html.includes('omk doctor /repo/.omk/samples.json'));
  });

  it('indexes prototype-shaped skill names as ordinary identities', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-skill-index-prototype-'));
    cleanup.push(tmp);
    const doctorsDir = join(tmp, '.omk', 'doctors');
    const analysesDir = join(tmp, '.omk', 'observe-health');
    const observationsDir = join(tmp, '.omk', 'observe-inbox');
    mkdirSync(doctorsDir, { recursive: true });

    const doctor = makeDoctorReport();
    const template = doctor.skills[0];
    doctor.id = 'doctor-prototype-shaped-skills';
    doctor.skills = ['__proto__', 'constructor'].map((skillName) => ({
      ...structuredClone(template),
      skillName,
      skillPath: `/repo/skills/${skillName}/SKILL.md`,
    }));
    doctor.totals.pass = 2;
    doctor.ruleStats.pass = 2;
    doctor.ruleStats.total = 2;
    writeFileSync(
      join(doctorsDir, reportFileName('prototype-shaped-skills')),
      JSON.stringify(doctor),
    );

    const index = buildSkillIndex(
      [],
      analysesDir,
      doctorsDir,
      observationsDir,
    );
    assert.deepEqual(
      index.entries.map((entry) => entry.skillName).sort(),
      ['__proto__', 'constructor'],
    );
  });

  it('links the skill list to the skill hub instead of a stage-specific report', () => {
    const idx: SkillIndex = {
      entries: [{
        skillName: 'service-guide',
        doctor: null,
        eval: null,
        observe: null,
        doctorHistory: [],
        evalHistory: [],
        observeHistory: [],
        band: 'gray',
      }],
      summary: { totalSkills: 1, withEval: 0, withObserve: 0, withDoctor: 0, red: 0, yellow: 0, green: 0, gray: 1 },
      insightsBySkill: new Map(),
      diagnosticsBySkill: new Map(),
      diagnosisSummary: {},
    } as unknown as SkillIndex;
    const html = renderSkillList(idx, 'zh');
    assert.ok(html.includes('data-href="/skills/service-guide"'));
  });
});

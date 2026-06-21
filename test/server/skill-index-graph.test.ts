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
    outcome: 'pass',
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
      { id: 'wf', stableKey: 'v1:workflow:hash-service-guide:release', nodeKind: 'workflow', nodeRole: 'entity', layer: 'definition', label: 'release' },
      { id: 'wfn', stableKey: 'v1:workflow-node:hash-service-guide:release.check', nodeKind: 'workflow_node', nodeRole: 'entity', layer: 'definition', label: '检查发布' },
      { id: 'rule', stableKey: 'v1:hard-rule:hash-service-guide:cite', nodeKind: 'hard_rule', nodeRole: 'entity', layer: 'definition', label: 'cite' },
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
    assert.equal(entry.graph?.eval?.nodeCount, 9);
    assert.equal(entry.graph?.eval?.edgeCount, 10);

    const html = renderSkillDetail(entry, report, 'zh');
    assert.match(html, /Skill Map/);
    assert.match(html, /复制 Markdown Evidence Card/);
    assert.ok(html.includes('references / 1'));
    assert.ok(html.includes('samples / 2'));
    assert.match(html, /variant 子图/);
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
    assert.match(html, /混合证据/);
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

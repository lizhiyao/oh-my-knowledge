import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildDoctorArtifactGraph,
  doctorGraphDirForDoctorOutput,
  persistDoctorGraphSidecars,
  renderDoctorEvidenceCard,
} from '../../src/artifact-graph/doctor.js';
import type { DoctorReport } from '../../src/types/index.js';

function makeReport(cwd: string, skillPath: string): DoctorReport {
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: 'doctor-test',
    timestamp: '2026-06-19T00:00:00.000Z',
    cliVersion: '0.0.0-test',
    cwd,
    executorName: 'fixture',
    model: 'fixture',
    outcome: 'warnings_only',
    totals: { pass: 0, warn: 1, fail: 0 },
    ruleStats: { pass: 2, warn: 1, fail: 0, skipped: 0, total: 3 },
    skills: [{
      skillName: 'review-skill',
      skillPath,
      status: 'warn',
      results: [
        {
          ruleId: 'skill_readable',
          severity: 'fatal',
          labelKey: 'cli.doctor.rule.skill_readable',
          status: 'pass',
          message: 'readable',
          durationMs: 1,
        },
        {
          ruleId: 'samples_contract_aligned',
          severity: 'warn',
          labelKey: 'cli.doctor.rule.samples_contract',
          status: 'warn',
          message: 'missing prompt',
          detail: { totalCount: 2, missingCount: 1 },
          durationMs: 2,
        },
      ],
    }],
  };
}

describe('doctor artifact graph', () => {
  it('builds a definition-layer graph without inferred covers edges', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-'));
    try {
      const skillRoot = join(tmp, 'skills', 'review-skill');
      mkdirSync(join(skillRoot, 'references'), { recursive: true });
      mkdirSync(join(skillRoot, 'scripts'), { recursive: true });
      const skillPath = join(skillRoot, 'SKILL.md');
      writeFileSync(skillPath, [
        '---',
        'preflight:',
        '  - yarn test',
        'hardRules:',
        '  - id: cite-source',
        '    rule: 引用证据',
        '    expectedBehavior: 输出必须带证据',
        'workflows:',
        '  - id: review',
        '    nodes:',
        '      - id: inspect',
        '        action: 检查代码',
        '      - id: comment',
        '        action: 输出评论',
        '---',
        '# Code Review Skill',
        '## 工作流程',
        '### Step 1: 读取上下文',
      ].join('\n'));
      writeFileSync(join(skillRoot, 'references', 'api.md'), 'reference');
      writeFileSync(join(skillRoot, 'scripts', 'check.sh'), 'echo ok');

      const report = makeReport(tmp, skillPath);
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctors', 'review-skill-test.report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      assert.equal(graph.documentKind, 'artifact-graph');
      assert.equal(graph.schemaVersion, 1);
      assert.equal(graph.source.sourceKind, 'doctor');
      assert.equal(graph.scope.skillName, 'review-skill');
      assert.equal(typeof graph.scope.artifactHash, 'string');
      assert.ok(graph.nodes.some((node) => node.nodeKind === 'reference' && node.label === 'references/api.md'));
      assert.ok(graph.nodes.some((node) => node.nodeKind === 'script' && node.label === 'scripts/check.sh'));
      assert.ok(graph.nodes.some((node) => node.nodeKind === 'hard_rule' && node.label === 'cite-source'));
      assert.ok(graph.nodes.some((node) => node.nodeKind === 'workflow_node' && node.label === '检查代码'));
      assert.ok(graph.nodes.some((node) => node.nodeKind === 'doctor_rule_result' && node.status === 'warning'));
      assert.ok(!graph.edges.some((edge) => edge.edgeKind === 'covers'));

      const card = renderDoctorEvidenceCard(graph, report.skills[0], 'zh');
      assert.ok(card.includes('Skill Evidence Card'));
      assert.ok(card.includes('doctor 有警告'));
      assert.ok(card.includes('omk eval --control baseline --treatment'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persists graph JSON and Markdown evidence card beside doctor output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-persist-'));
    try {
      const skillRoot = join(tmp, 'skill');
      mkdirSync(skillRoot, { recursive: true });
      const skillPath = join(skillRoot, 'SKILL.md');
      writeFileSync(skillPath, '# Skill\n\n这个 skill 内容足够长，用于测试 graph sidecar。');
      const report = makeReport(tmp, skillPath);
      const outputDir = join(tmp, '.omk', 'doctors');
      const result = persistDoctorGraphSidecars({
        report,
        skill: report.skills[0],
        sourcePath: join(outputDir, 'review-skill-test.report.json'),
        outputDir,
        fileStem: 'review-skill-doctor-test',
        lang: 'zh',
      });

      assert.ok(existsSync(result.graphPath));
      assert.ok(existsSync(result.evidenceCardPath));
      assert.equal(result.graphPath, join(doctorGraphDirForDoctorOutput(outputDir), 'review-skill-doctor-test.graph.json'));
      assert.equal(result.evidenceCardPath, join(doctorGraphDirForDoctorOutput(outputDir), 'review-skill-doctor-test.card.md'));
      const graph = JSON.parse(readFileSync(result.graphPath, 'utf-8')) as { documentKind: string };
      assert.equal(graph.documentKind, 'artifact-graph');
      assert.ok(readFileSync(result.evidenceCardPath, 'utf-8').includes('Skill Evidence Card'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('puts graph sidecars inside non-standard custom output dirs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-custom-out-'));
    try {
      const outputDir = join(tmp, 'custom-output');
      assert.equal(doctorGraphDirForDoctorOutput(outputDir), join(outputDir, 'graphs', 'doctor'));
      assert.equal(
        doctorGraphDirForDoctorOutput(join(tmp, '.omk', 'doctors')),
        join(tmp, '.omk', 'graphs', 'doctor'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats zero eval samples as missing in the evidence card', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-zero-samples-'));
    try {
      const skillPath = join(tmp, 'SKILL.md');
      writeFileSync(skillPath, '# Skill\n\n这个 skill 内容足够长，用于测试。');
      const report = makeReport(tmp, skillPath);
      report.skills[0].results = report.skills[0].results.map((result) => result.ruleId === 'samples_contract_aligned'
        ? { ...result, detail: { count: 0 } }
        : result);
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctors', 'review-skill-test.report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      const card = renderDoctorEvidenceCard(graph, report.skills[0], 'zh');
      assert.ok(card.includes('未检测到 eval samples'));
      assert.ok(card.includes('omk sample'));
      assert.ok(card.includes('samples？'));
      assert.ok(!card.includes('复用当前 0 条用例继续评测'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

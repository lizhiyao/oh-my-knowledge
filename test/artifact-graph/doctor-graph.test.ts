import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildDoctorArtifactGraph,
  persistDoctorGraphSidecars,
  removeDoctorGraphSidecars,
  renderDoctorEvidenceCard,
} from '../../src/artifact-graph/doctor.js';
import type { DoctorReport } from '../../src/knowledge-artifacts/doctor/contracts.js';

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
      writeFileSync(join(skillRoot, 'references', 'api[prod](v1)#x;.md'), 'reference');
      writeFileSync(join(skillRoot, 'scripts', 'check.sh'), 'echo ok');

      const report = makeReport(tmp, skillPath);
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctor', 'review-skill-test', 'report.json'),
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
      assert.ok(card.includes('知识图谱摘要'));
      assert.ok(card.includes('doctor 有警告'));
      assert.ok(card.includes('SKILL.md: review-skill'));
      assert.ok(card.includes('file --> refs'));
      assert.ok(card.includes('refs --> refs_1'));
      assert.ok(card.includes('scripts --> scripts_1'));
      assert.ok(card.includes('workflows --> workflows_1'));
      assert.ok(card.includes('api&#91;prod&#93;&#40;v1&#41;&#35;x&#59;.md'));
      assert.ok(card.includes('doctor --> issue'));
      assert.ok(card.includes('doctor -. next .-> eval'));
      assert.ok(!card.includes('### 图中未展开的结构'));
      assert.ok(card.includes('references/api.md'));
      assert.ok(card.includes('scripts/check.sh'));
      assert.ok(card.includes('review'));
      assert.ok(card.includes('### Doctor 发现'));
      assert.ok(card.includes('警告：samples_contract_aligned'));
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
      const outputDir = join(tmp, '.omk', 'doctor');
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
      assert.equal(result.graphPath, join(outputDir, 'review-skill-doctor-test', 'derived', 'graph.json'));
      assert.equal(result.evidenceCardPath, join(outputDir, 'review-skill-doctor-test', 'derived', 'card.md'));
      const graph = JSON.parse(readFileSync(result.graphPath, 'utf-8')) as { documentKind: string };
      assert.equal(graph.documentKind, 'artifact-graph');
      assert.ok(readFileSync(result.evidenceCardPath, 'utf-8').includes('知识图谱摘要'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects non-canonical sidecar identities instead of sanitizing aliases', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-identity-'));
    try {
      const skillRoot = join(tmp, 'skill');
      mkdirSync(skillRoot, { recursive: true });
      const skillPath = join(skillRoot, 'SKILL.md');
      writeFileSync(skillPath, '# Skill\n\n这个 skill 内容足够长，用于测试 graph sidecar。');
      const report = makeReport(tmp, skillPath);
      const outputDir = join(tmp, '.omk', 'doctor');
      const canonical = persistDoctorGraphSidecars({
        report,
        skill: report.skills[0],
        sourcePath: join(outputDir, 'review-skill-test.report.json'),
        outputDir,
        fileStem: 'a_b',
        lang: 'zh',
      });

      assert.throws(
        () => persistDoctorGraphSidecars({
          report,
          skill: report.skills[0],
          sourcePath: join(outputDir, 'review-skill-test.report.json'),
          outputDir,
          fileStem: 'a/b',
          lang: 'zh',
        }),
        /invalid doctor graph file stem/,
      );
      removeDoctorGraphSidecars(outputDir, 'a/b');
      assert.equal(existsSync(canonical.graphPath), true);
      assert.equal(existsSync(canonical.evidenceCardPath), true);
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
        sourcePath: join(tmp, '.omk', 'doctor', 'review-skill-test', 'report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      const card = renderDoctorEvidenceCard(graph, report.skills[0], 'zh');
      assert.ok(card.includes('未检测到 eval samples'));
      assert.ok(card.includes('omk sample'));
      assert.ok(!card.includes('references / 0'));
      assert.ok(!card.includes('scripts / 0'));
      assert.ok(!card.includes('workflows / 0'));
      assert.ok(!card.includes('复用当前 0 条用例继续评测'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

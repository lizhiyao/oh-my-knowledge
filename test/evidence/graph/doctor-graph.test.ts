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
} from '../../../src/evidence/graph/doctor.js';
import type { DoctorReport } from '../../../src/knowledge-artifacts/doctor/contracts.js';

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

  it('degrades to a source-locator binding when the skill source is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-missing-'));
    try {
      const missingSkillPath = join(tmp, 'deleted-skill', 'SKILL.md');
      const report = makeReport(tmp, missingSkillPath);
      report.skills[0].status = 'fail';
      report.skills[0].results[1] = { ...report.skills[0].results[1], status: 'fail' };
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctor', 'review-skill-test', 'report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      assert.equal(graph.scope.artifactHash, undefined, '源已删除时不得伪造内容哈希');
      const skillNode = graph.nodes.find((node) => node.nodeKind === 'skill');
      assert.equal(skillNode?.binding?.bindingStrength, 'source-locator');
      const skillFileNode = graph.nodes.find((node) => node.nodeKind === 'skill_file');
      assert.ok(skillFileNode?.evidenceRefs?.every((ref) => ref.contentHash === undefined));
      assert.equal(skillFileNode?.evidenceRefs?.[0]?.path, missingSkillPath);
      assert.ok(!graph.nodes.some((node) => ['reference', 'script', 'frontmatter'].includes(node.nodeKind)),
        '读不到源时不得凭空产生结构节点');
      const failedResult = graph.nodes.find((node) => node.nodeKind === 'doctor_rule_result' && node.label === 'samples_contract_aligned');
      assert.equal(failedResult?.status, 'failed', 'doctor fail 必须映射为 failed,不能降级成 warning');
      const diagnoses = graph.edges.find((edge) => edge.fromNodeId === failedResult?.id);
      assert.equal(diagnoses?.edgeKind, 'diagnoses');
      assert.equal(diagnoses?.toNodeId, skillNode?.id);
      assert.equal(diagnoses?.status, 'failed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records a broken frontmatter block as a failed node instead of dropping it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-frontmatter-'));
    try {
      const skillPath = join(tmp, 'SKILL.md');
      writeFileSync(skillPath, ['---', '- not-a-mapping', '---', '# Skill', ''].join('\n'));
      const report = makeReport(tmp, skillPath);
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctor', 'review-skill-test', 'report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      const frontmatterNode = graph.nodes.find((node) => node.nodeKind === 'frontmatter');
      assert.equal(frontmatterNode?.status, 'failed', '损坏的 frontmatter 是观测事实,必须保留为 failed');
      const declares = graph.edges.find((edge) => edge.toNodeId === frontmatterNode?.id);
      assert.equal(declares?.edgeKind, 'declares');
      assert.equal(declares?.status, 'failed');
      assert.ok(!graph.nodes.some((node) => node.nodeKind === 'preflight'),
        'frontmatter 解析失败时不得继续编造其字段节点');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('projects preflight, tools and env declarations as requires edges with honest bindings', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-requires-'));
    try {
      const skillRoot = join(tmp, 'skill');
      mkdirSync(skillRoot, { recursive: true });
      const skillPath = join(skillRoot, 'SKILL.md');
      writeFileSync(skillPath, [
        '---',
        'tools:',
        '  - Bash',
        '  - Read',
        'requires:',
        '  preflight:',
        '    - yarn ci',
        '  env:',
        '    - NODE_ENV',
        '---',
        '# Skill',
      ].join('\n'));
      const report = makeReport(tmp, skillPath);
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctor', 'review-skill-test', 'report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      const skillNode = graph.nodes.find((node) => node.nodeKind === 'skill');
      const preflightNode = graph.nodes.find((node) => node.nodeKind === 'preflight');
      assert.equal(preflightNode?.label, 'yarn ci');
      const envNode = graph.nodes.find((node) => node.nodeKind === 'env');
      assert.equal(envNode?.label, 'NODE_ENV');
      const toolNodes = graph.nodes.filter((node) => node.nodeKind === 'tool');
      assert.deepEqual(toolNodes.map((node) => node.label).sort(), ['Bash', 'Read']);
      for (const node of [...toolNodes, envNode, preflightNode]) {
        const requires = graph.edges.find((edge) => edge.toNodeId === node?.id);
        assert.equal(requires?.edgeKind, 'requires', node?.label);
        assert.equal(requires?.fromNodeId, skillNode?.id, node?.label);
      }
      for (const node of toolNodes) {
        assert.equal(node.binding?.bindingStrength, 'name-only', '工具名只是声明引用,不能伪装成内容绑定');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves a directory skill to its SKILL.md and links workflow steps in order', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-dirskill-'));
    try {
      const skillRoot = join(tmp, 'dir-skill');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), [
        '---',
        'workflows:',
        '  - id: review',
        '    nodes:',
        '      - id: inspect',
        '        action: 检查',
        '      - id: comment',
        '        action: 评论',
        '---',
        '# Skill',
      ].join('\n'));
      const report = makeReport(tmp, skillRoot);
      const graph = buildDoctorArtifactGraph({
        report,
        skill: report.skills[0],
        sourcePath: join(tmp, '.omk', 'doctor', 'review-skill-test', 'report.json'),
        generatedAt: '2026-06-19T00:00:00.000Z',
      });

      const skillFileNode = graph.nodes.find((node) => node.nodeKind === 'skill_file');
      assert.equal(skillFileNode?.evidenceRefs?.[0]?.path, join(skillRoot, 'SKILL.md'),
        '目录 skill 的真身证据必须指向其 SKILL.md');
      assert.equal(typeof graph.scope.artifactHash, 'string');
      const inspect = graph.nodes.find((node) => node.nodeKind === 'workflow_node' && node.label === '检查');
      const comment = graph.nodes.find((node) => node.nodeKind === 'workflow_node' && node.label === '评论');
      const nextStep = graph.edges.find((edge) => edge.edgeKind === 'next_step');
      assert.equal(nextStep?.fromNodeId, inspect?.id);
      assert.equal(nextStep?.toNodeId, comment?.id, 'workflow 步骤顺序必须保留,乱序会误导审查');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes both sidecars for a canonical stem and stays silent for a missing one', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-doctor-graph-remove-'));
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
      assert.ok(existsSync(result.graphPath) && existsSync(result.evidenceCardPath));

      removeDoctorGraphSidecars(outputDir, 'review-skill-doctor-test');
      assert.equal(existsSync(result.graphPath), false, 'prune 正文时 graph sidecar 必须连带删除');
      assert.equal(existsSync(result.evidenceCardPath), false, 'prune 正文时证据卡片必须连带删除');

      assert.doesNotThrow(() => removeDoctorGraphSidecars(outputDir, 'review-skill-doctor-test'),
        '重复删除保持幂等');
      assert.doesNotThrow(() => removeDoctorGraphSidecars(outputDir, 'a/b'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

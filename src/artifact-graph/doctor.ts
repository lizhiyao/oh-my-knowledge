import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { cardFileName, graphFileName, safeArtifactFileStem } from '../measurement-artifacts/file-names.js';
import { hashArtifactSource } from '../inputs/content-hash.js';
import { parseArtifactGraphDocument } from '../shared/artifact-graph.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import {
  extractMarkdownStepWorkflows,
  extractSkillHardRules,
  extractSkillWorkflows,
  parseSkillFrontmatter,
} from '../shared/hard-rules.js';
import type {
  ArtifactGraphDocument,
  ArtifactGraphEdge,
  ArtifactGraphEdgeKind,
  ArtifactGraphEvidenceRef,
  ArtifactGraphBinding,
  ArtifactGraphNode,
  ArtifactGraphNodeKind,
  ArtifactGraphNodeRole,
  ArtifactGraphStatus,
  DoctorReport,
  DoctorRuleResult,
  DoctorSkillReport,
  Lang,
} from '../types/index.js';

export interface BuildDoctorGraphOptions {
  report: DoctorReport;
  skill: DoctorSkillReport;
  sourcePath: string;
  generatedAt?: string;
}

export interface PersistDoctorGraphOptions extends BuildDoctorGraphOptions {
  outputDir: string;
  fileStem: string;
  lang: Lang;
}

export interface PersistDoctorGraphResult {
  graphPath: string;
  evidenceCardPath: string;
}

interface SkillSourceSnapshot {
  skillFilePath: string;
  skillRoot: string;
  isDirectorySkill: boolean;
  content: string;
  artifactHash?: string;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function isCanonicalFileStem(id: string): boolean {
  return id.length > 0 && safeArtifactFileStem(id) === id;
}

export function doctorGraphDirForDoctorOutput(doctorOutputDir: string): string {
  return basename(doctorOutputDir) === 'doctors'
    ? join(dirname(doctorOutputDir), 'graphs', 'doctor')
    : join(doctorOutputDir, 'graphs', 'doctor');
}

function normalizeRelPath(path: string): string {
  return path.split(sep).join('/');
}

function resolveSkillSource(skill: DoctorSkillReport): SkillSourceSnapshot | null {
  const source = resolve(skill.skillPath);
  if (!existsSync(source)) return null;
  const stat = statSync(source);
  const skillFilePath = stat.isDirectory() ? join(source, 'SKILL.md') : source;
  if (!existsSync(skillFilePath)) return null;
  const isDirectorySkill = basename(skillFilePath) === 'SKILL.md';
  const skillRoot = dirname(skillFilePath);
  const content = readFileSync(skillFilePath, 'utf-8');
  let artifactHash: string | undefined;
  try {
    artifactHash = hashArtifactSource(isDirectorySkill ? skillRoot : skillFilePath, isDirectorySkill);
  } catch {
    artifactHash = undefined;
  }
  return { skillFilePath, skillRoot, isDirectorySkill, content, artifactHash };
}

function listFiles(root: string, subdir: 'references' | 'scripts'): string[] {
  const start = join(root, subdir);
  if (!existsSync(start)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(normalizeRelPath(relative(root, full)));
      }
    }
  };
  walk(start);
  out.sort();
  return out;
}

function statusFromRule(status: DoctorRuleResult['status']): ArtifactGraphStatus {
  switch (status) {
    case 'pass':
      return 'ok';
    case 'warn':
      return 'warning';
    case 'fail':
      return 'failed';
    case 'skipped':
      return 'skipped';
  }
}

function sourceKey(snapshot: SkillSourceSnapshot | null, skill: DoctorSkillReport): string {
  return snapshot?.artifactHash ?? `locator:${shortHash(skill.skillPath)}`;
}

function contentBinding(snapshot: SkillSourceSnapshot | null, skill: DoctorSkillReport): ArtifactGraphBinding {
  if (snapshot?.artifactHash) {
    return { bindingStrength: 'content-hash', keys: { artifactHash: snapshot.artifactHash } };
  }
  return { bindingStrength: 'source-locator', keys: { sourceLocatorHash: shortHash(skill.skillPath) } };
}

function skillEvidence(snapshot: SkillSourceSnapshot | null, skill: DoctorSkillReport): ArtifactGraphEvidenceRef[] {
  if (!snapshot) {
    return [{
      sourceKind: 'skill-file',
      path: skill.skillPath,
      label: 'skill source',
    }];
  }
  return [{
    sourceKind: 'skill-file',
    path: snapshot.skillFilePath,
    selector: { selectorKind: 'line-range', value: '1-1' },
    contentHash: snapshot.artifactHash,
    label: 'SKILL.md',
  }];
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function nestedStringList(root: unknown, key: string): string[] {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
  return stringList((root as Record<string, unknown>)[key]);
}

function sampleCountFromDoctor(skill: DoctorSkillReport): number | null {
  for (const result of skill.results) {
    if (result.ruleId !== 'samples_contract_aligned') continue;
    const count = result.detail?.count ?? result.detail?.totalCount;
    return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : null;
  }
  return null;
}

export function buildDoctorArtifactGraph(options: BuildDoctorGraphOptions): ArtifactGraphDocument {
  const { report, skill, sourcePath } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const snapshot = resolveSkillSource(skill);
  const keyBase = sourceKey(snapshot, skill);
  const binding = contentBinding(snapshot, skill);
  const evidence = skillEvidence(snapshot, skill);
  const nodes: ArtifactGraphNode[] = [];
  const edges: ArtifactGraphEdge[] = [];
  const nodeIdsByStableKey = new Map<string, string>();

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
      layer: 'definition',
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
      layer: 'definition',
      ...extra,
    });
  };

  const skillNodeId = addNode(
    `v1:skill:${keyBase}`,
    'skill',
    'entity',
    skill.skillName,
    {
      binding,
      attrs: { display: { sourceLocator: skill.skillPath } },
      evidenceRefs: evidence,
    },
  );

  const skillFileNodeId = addNode(
    `v1:skill-file:${keyBase}:SKILL.md`,
    'skill_file',
    'entity',
    'SKILL.md',
    {
      binding,
      attrs: { display: { path: snapshot ? normalizeRelPath(relative(snapshot.skillRoot, snapshot.skillFilePath)) : skill.skillPath } },
      evidenceRefs: evidence,
    },
  );
  addEdge(skillNodeId, skillFileNodeId, 'contains', { evidenceRefs: evidence });

  if (snapshot) {
    const parsedFrontmatter = parseSkillFrontmatter(snapshot.content);
    if (parsedFrontmatter.hasFrontmatter) {
      const frontmatterNodeId = addNode(
        `v1:frontmatter:${keyBase}`,
        'frontmatter',
        'entity',
        'frontmatter',
        {
          status: parsedFrontmatter.ok ? 'ok' : 'failed',
          binding,
          evidenceRefs: evidence,
          attrs: parsedFrontmatter.ok
            ? { display: { fieldCount: Object.keys(parsedFrontmatter.data ?? {}).length } }
            : { display: { error: parsedFrontmatter.error } },
        },
      );
      addEdge(skillNodeId, frontmatterNodeId, 'declares', { status: parsedFrontmatter.ok ? 'ok' : 'failed' });
    }

    for (const rel of listFiles(snapshot.skillRoot, 'references')) {
      const nodeId = addNode(
        `v1:reference:${keyBase}:${rel}`,
        'reference',
        'entity',
        rel,
        {
          binding,
          attrs: { display: { path: rel } },
          evidenceRefs: [{ sourceKind: 'skill-file', path: join(snapshot.skillRoot, rel), contentHash: snapshot.artifactHash, label: rel }],
        },
      );
      addEdge(skillNodeId, nodeId, 'references');
    }

    for (const rel of listFiles(snapshot.skillRoot, 'scripts')) {
      const nodeId = addNode(
        `v1:script:${keyBase}:${rel}`,
        'script',
        'entity',
        rel,
        {
          binding,
          attrs: { display: { path: rel } },
          evidenceRefs: [{ sourceKind: 'skill-file', path: join(snapshot.skillRoot, rel), contentHash: snapshot.artifactHash, label: rel }],
        },
      );
      addEdge(skillNodeId, nodeId, 'contains');
    }

    const frontmatterData = parsedFrontmatter.ok ? parsedFrontmatter.data ?? {} : {};
    const preflight = [
      ...stringList(frontmatterData.preflight),
      ...nestedStringList(frontmatterData.requires, 'preflight'),
    ];
    preflight.forEach((cmd, index) => {
      const nodeId = addNode(
        `v1:preflight:${keyBase}:${shortHash(cmd)}`,
        'preflight',
        'entity',
        cmd,
        { binding, attrs: { display: { index } }, evidenceRefs: evidence },
      );
      addEdge(skillNodeId, nodeId, 'requires');
    });

    const tools = [
      ...stringList(frontmatterData.tools),
      ...stringList(frontmatterData.allowedTools),
      ...nestedStringList(frontmatterData.requires, 'tools'),
    ];
    tools.forEach((tool) => {
      const nodeId = addNode(
        `v1:tool:${tool}`,
        'tool',
        'entity',
        tool,
        { binding: { bindingStrength: 'name-only', keys: { toolName: tool } }, evidenceRefs: evidence },
      );
      addEdge(skillNodeId, nodeId, 'requires', { binding: { bindingStrength: 'name-only', keys: { toolName: tool } } });
    });

    const env = [
      ...stringList(frontmatterData.env),
      ...nestedStringList(frontmatterData.requires, 'env'),
    ];
    env.forEach((name) => {
      const nodeId = addNode(
        `v1:env:${name}`,
        'env',
        'entity',
        name,
        { binding: { bindingStrength: 'name-only', keys: { envName: name } }, evidenceRefs: evidence },
      );
      addEdge(skillNodeId, nodeId, 'requires', { binding: { bindingStrength: 'name-only', keys: { envName: name } } });
    });

    for (const hardRule of extractSkillHardRules(snapshot.content)) {
      const nodeId = addNode(
        `v1:hard-rule:${keyBase}:${hardRule.id}`,
        'hard_rule',
        'entity',
        hardRule.id,
        {
          binding,
          attrs: { display: { rule: hardRule.rule, expectedBehavior: hardRule.expectedBehavior } },
          evidenceRefs: evidence,
        },
      );
      addEdge(skillNodeId, nodeId, 'declares');
    }

    const workflows = [
      ...extractSkillWorkflows(snapshot.content),
      ...extractMarkdownStepWorkflows(snapshot.content),
    ];
    for (const workflow of workflows) {
      const workflowNodeId = addNode(
        `v1:workflow:${keyBase}:${workflow.id}`,
        'workflow',
        'entity',
        workflow.id,
        {
          binding,
          attrs: { display: { description: workflow.description, source: workflow.source ?? 'frontmatter' } },
          evidenceRefs: evidence,
        },
      );
      addEdge(skillNodeId, workflowNodeId, 'declares');
      let prevNodeId: string | null = null;
      for (const node of workflow.nodes) {
        const stepNodeId = addNode(
          `v1:workflow-node:${keyBase}:${workflow.id}.${node.id}`,
          'workflow_node',
          'entity',
          node.action,
          {
            binding,
            attrs: { display: { workflowId: workflow.id, nodeId: node.id } },
            evidenceRefs: evidence,
          },
        );
        addEdge(workflowNodeId, stepNodeId, 'defines_workflow');
        if (prevNodeId) addEdge(prevNodeId, stepNodeId, 'next_step');
        prevNodeId = stepNodeId;
      }
    }
  }

  skill.results.forEach((result, index) => {
    const nodeId = addNode(
      `v1:doctor-result:${report.id}:${skill.skillName}:${result.ruleId}`,
      'doctor_rule_result',
      'observation',
      result.ruleId,
      {
        status: statusFromRule(result.status),
        metrics: { durationMs: result.durationMs },
        attrs: {
          display: {
            severity: result.severity,
            message: result.message,
            hint: result.hint,
            groupId: result.groupId,
          },
        },
        evidenceRefs: [{
          sourceKind: 'doctor-report',
          sourceId: report.id,
          path: sourcePath,
          selector: { selectorKind: 'json-pointer', value: `/skills/0/results/${index}` },
          label: result.ruleId,
        }],
      },
    );
    addEdge(nodeId, skillNodeId, 'diagnoses', {
      status: statusFromRule(result.status),
      evidenceRefs: [{
        sourceKind: 'doctor-report',
        sourceId: report.id,
        path: sourcePath,
        selector: { selectorKind: 'rule-id', value: result.ruleId },
        label: result.ruleId,
      }],
    });
  });

  const structureCounts = countDoctorGraphStructure(nodes);
  const severity = skill.status === 'fail' ? 'high' : skill.status === 'warn' ? 'medium' : 'info';
  return {
    documentKind: 'artifact-graph',
    schemaVersion: 1,
    graphId: `doctor:${report.id}:${skill.skillName}`,
    generatedAt,
    source: {
      sourceKind: 'doctor',
      sourceId: report.id,
      sourcePath,
      cliVersion: report.cliVersion,
    },
    scope: {
      cwd: report.cwd,
      artifactKind: 'skill',
      skillName: skill.skillName,
      ...(snapshot?.artifactHash ? { artifactHash: snapshot.artifactHash } : {}),
      sourceLocator: skill.skillPath,
    },
    nodes,
    edges,
    summaries: [{
      summaryKind: 'structure',
      title: `references=${structureCounts.references}, scripts=${structureCounts.scripts}, workflows=${structureCounts.workflows}, workflowNodes=${structureCounts.workflowNodes}`,
      severity: 'info',
      nodeIds: [skillNodeId],
    }, {
      summaryKind: 'risk',
      title: `doctor status: ${skill.status}`,
      severity,
      nodeIds: nodes.filter((node) => node.nodeKind === 'doctor_rule_result').map((node) => node.id),
    }],
  };
}

function countDoctorGraphStructure(nodes: ArtifactGraphNode[]): {
  references: number;
  scripts: number;
  workflows: number;
  workflowNodes: number;
  hardRules: number;
} {
  return {
    references: nodes.filter((node) => node.nodeKind === 'reference').length,
    scripts: nodes.filter((node) => node.nodeKind === 'script').length,
    workflows: nodes.filter((node) => node.nodeKind === 'workflow').length,
    workflowNodes: nodes.filter((node) => node.nodeKind === 'workflow_node').length,
    hardRules: nodes.filter((node) => node.nodeKind === 'hard_rule').length,
  };
}

function doctorStatusLabel(skill: DoctorSkillReport, lang: Lang): string {
  if (lang === 'zh') {
    if (skill.status === 'pass') return '已通过';
    if (skill.status === 'warn') return '有警告';
    return '未通过';
  }
  if (skill.status === 'pass') return 'passed';
  if (skill.status === 'warn') return 'warnings';
  return 'failed';
}

function mermaidLabel(label: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '\\': '&#92;',
    '"': '&quot;',
    '[': '&#91;',
    ']': '&#93;',
    '(': '&#40;',
    ')': '&#41;',
    '{': '&#123;',
    '}': '&#125;',
    '|': '&#124;',
    '#': '&#35;',
    ';': '&#59;',
    '<': '&lt;',
    '>': '&gt;',
  };
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[&\\"[\](){}|#;<>]/g, (ch) => entities[ch] ?? ch);
}

function compactLabel(label: string, max = 56): string {
  const normalized = label.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function doctorProblemResults(skill: DoctorSkillReport): DoctorRuleResult[] {
  return skill.results.filter((result) => result.status === 'fail' || result.status === 'warn');
}

function doctorProblemLabel(result: DoctorRuleResult | undefined, lang: Lang): string | null {
  if (!result) return null;
  const zh = lang === 'zh';
  const prefix = result.status === 'fail'
    ? (zh ? '失败' : 'fail')
    : (zh ? '警告' : 'warn');
  return zh ? `${prefix}：${result.ruleId}` : `${prefix}: ${result.ruleId}`;
}

function addExpandedGroup(
  lines: string[],
  parentNodeId: string,
  groupNodeId: string,
  groupLabel: string,
  items: string[],
  lang: Lang,
  max = 3,
): void {
  if (items.length === 0) return;
  lines.push(`  ${groupNodeId}["${mermaidLabel(groupLabel)}"]`);
  lines.push(`  ${parentNodeId} --> ${groupNodeId}`);
  const visible = items.slice(0, max);
  visible.forEach((item, index) => {
    const itemNodeId = `${groupNodeId}_${index + 1}`;
    lines.push(`  ${itemNodeId}["${mermaidLabel(compactLabel(item, 42))}"]`);
    lines.push(`  ${groupNodeId} --> ${itemNodeId}`);
  });
  const rest = items.length - visible.length;
  if (rest > 0) {
    const moreLabel = lang === 'zh' ? `另有 ${rest} 项` : `+${rest} more`;
    lines.push(`  ${groupNodeId}_more["${mermaidLabel(moreLabel)}"]`);
    lines.push(`  ${groupNodeId} --> ${groupNodeId}_more`);
  }
}

function renderMermaid(graph: ArtifactGraphDocument, skill: DoctorSkillReport, lang: Lang): string {
  const references = graphLabelsByKind(graph, 'reference');
  const scripts = graphLabelsByKind(graph, 'script');
  const workflows = graphLabelsByKind(graph, 'workflow');
  const problemLabel = doctorProblemLabel(doctorProblemResults(skill)[0], lang);
  const lines = [
    '```mermaid',
    'flowchart LR',
    `  file["SKILL.md: ${mermaidLabel(skill.skillName)}"]`,
    `  doctor["doctor / ${mermaidLabel(doctorStatusLabel(skill, lang))}"]`,
  ];
  addExpandedGroup(lines, 'file', 'refs', `references / ${references.length}`, references, lang);
  addExpandedGroup(lines, 'file', 'scripts', `scripts / ${scripts.length}`, scripts, lang);
  addExpandedGroup(lines, 'file', 'workflows', `workflows / ${workflows.length}`, workflows, lang);
  lines.push('  file --> doctor');
  if (problemLabel) {
    lines.push(`  issue["${mermaidLabel(compactLabel(problemLabel))}"]`);
    lines.push('  doctor --> issue');
  }
  lines.push(`  eval["${lang === 'zh' ? 'eval 未测量' : 'eval not measured'}"]`);
  lines.push(`  observe["${lang === 'zh' ? 'observe 未接入' : 'observe not connected'}"]`);
  lines.push('  doctor -. next .-> eval');
  lines.push('  eval -. next .-> observe');
  lines.push('  classDef pending fill:#f3f4f6,stroke:#9ca3af,color:#6b7280');
  lines.push('  class eval,observe pending');
  lines.push('```');
  return lines.join('\n');
}

function graphLabelsByKind(graph: ArtifactGraphDocument, kind: ArtifactGraphNodeKind): string[] {
  return graph.nodes
    .filter((node) => node.nodeKind === kind)
    .map((node) => node.label)
    .sort((a, b) => a.localeCompare(b));
}

function formatInlineItems(items: string[], lang: Lang, max = 8): string {
  if (items.length === 0) return lang === 'zh' ? '无' : 'none';
  const visible = items.slice(0, max).map((item) => `\`${item}\``).join(lang === 'zh' ? '、' : ', ');
  const rest = items.length - max;
  if (rest <= 0) return visible;
  return lang === 'zh' ? `${visible}，另有 ${rest} 项` : `${visible}, plus ${rest} more`;
}

function renderStructureDetails(graph: ArtifactGraphDocument, lang: Lang): string[] {
  const zh = lang === 'zh';
  const references = graphLabelsByKind(graph, 'reference');
  const scripts = graphLabelsByKind(graph, 'script');
  const workflows = graphLabelsByKind(graph, 'workflow');
  if (references.length <= 3 && scripts.length <= 3 && workflows.length <= 3) return [];
  return [
    zh ? '### 图中未展开的结构' : '### Hidden Structure',
    '',
    ...(references.length > 3 ? [`- references：${formatInlineItems(references.slice(3), lang)}`] : []),
    ...(scripts.length > 3 ? [`- scripts：${formatInlineItems(scripts.slice(3), lang)}`] : []),
    ...(workflows.length > 3 ? [`- workflows：${formatInlineItems(workflows.slice(3), lang)}`] : []),
  ];
}

function renderDoctorFindings(skill: DoctorSkillReport, lang: Lang): string[] {
  const zh = lang === 'zh';
  const problems = doctorProblemResults(skill).slice(0, 5);
  if (problems.length === 0) {
    return [
      zh ? '### Doctor 发现' : '### Doctor Findings',
      '',
      zh ? '- 暂无失败或警告。' : '- No failures or warnings.',
    ];
  }
  return [
    zh ? '### Doctor 发现' : '### Doctor Findings',
    '',
    ...problems.map((result) => {
      const label = doctorProblemLabel(result, lang) ?? result.ruleId;
      const message = result.message ? `：${compactLabel(result.message, 160)}` : '';
      const hint = result.hint ? (zh ? `；建议：${compactLabel(result.hint, 120)}` : `; hint: ${compactLabel(result.hint, 120)}`) : '';
      return `- ${label}${message}${hint}`;
    }),
  ];
}

function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(path)) return path;
  return JSON.stringify(path);
}

export function renderDoctorEvidenceCard(graph: ArtifactGraphDocument, skill: DoctorSkillReport, lang: Lang): string {
  const zh = lang === 'zh';
  const counts = countDoctorGraphStructure(graph.nodes);
  const sampleCount = sampleCountFromDoctor(skill);
  const doctorStatus = doctorStatusLabel(skill, lang);
  const sampleText = sampleCount == null ? (zh ? '未检测到 eval samples' : 'eval samples not detected') : `${sampleCount}`;
  const source = graph.scope.sourceLocator ?? skill.skillPath;
  const sourceCmd = shellQuotePath(source);
  const statusSentence = zh
    ? `这个 skill 有 ${counts.references} 个 references、${counts.scripts} 个 scripts、${counts.workflows} 个 workflows、${counts.workflowNodes} 个 workflow nodes，当前处于「doctor ${doctorStatus}，eval 未测量，observe 未观察」状态。`
    : `This skill has ${counts.references} references, ${counts.scripts} scripts, ${counts.workflows} workflows, and ${counts.workflowNodes} workflow nodes. Current state: doctor ${doctorStatus}, eval not measured, observe not observed.`;
  const nextSteps = zh
    ? [
      sampleCount == null ? `- 生成用例：\`omk sample ${sourceCmd}\`` : `- 复用当前 ${sampleCount} 条用例继续评测。`,
      `- 测量效果：\`omk eval --control baseline --treatment ${sourceCmd}\``,
      '- 接入生产观察：`omk observe ingest <trace-dir>`',
    ]
    : [
      sampleCount == null ? `- Generate samples: \`omk sample ${sourceCmd}\`` : `- Reuse the current ${sampleCount} sample(s) for eval.`,
      `- Measure impact: \`omk eval --control baseline --treatment ${sourceCmd}\``,
      '- Add production observation: `omk observe ingest <trace-dir>`',
    ];
  const hiddenStructure = renderStructureDetails(graph, lang);

  return [
    `## ${zh ? '知识图谱摘要' : 'Skill Map Summary'}${zh ? '：' : ': '}${skill.skillName}`,
    '',
    statusSentence,
    '',
    renderMermaid(graph, skill, lang),
    '',
    ...hiddenStructure,
    ...(hiddenStructure.length > 0 ? [''] : []),
    ...renderDoctorFindings(skill, lang),
    '',
    zh ? '### 三阶段状态' : '### Stage Status',
    '',
    `| ${zh ? '阶段' : 'Stage'} | ${zh ? '状态' : 'Status'} |`,
    '| --- | --- |',
    `| doctor | ${doctorStatus} |`,
    `| eval | ${zh ? '未测量' : 'not measured'} |`,
    `| observe | ${zh ? '未观察' : 'not observed'} |`,
    '',
    zh ? '### 关键计数' : '### Key Counts',
    '',
    `| references | scripts | workflows | workflow nodes | hard rules | samples | doctor warnings | doctor failures |`,
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${counts.references} | ${counts.scripts} | ${counts.workflows} | ${counts.workflowNodes} | ${counts.hardRules} | ${sampleText} | ${skill.results.filter((r) => r.status === 'warn').length} | ${skill.results.filter((r) => r.status === 'fail').length} |`,
    '',
    zh ? '### 下一步' : '### Next Steps',
    '',
    ...nextSteps,
    '',
    zh ? '### 复现信息' : '### Reproduction',
    '',
    `- source：\`${source}\``,
    `- artifactHash：\`${graph.scope.artifactHash ?? 'unknown'}\``,
    `- doctorReportId：\`${graph.source.sourceId}\``,
    `- graphId：\`${graph.graphId}\``,
    `- generatedAt：\`${graph.generatedAt}\``,
    '',
  ].join('\n');
}

export function persistDoctorGraphSidecars(options: PersistDoctorGraphOptions): PersistDoctorGraphResult {
  const dir = doctorGraphDirForDoctorOutput(options.outputDir);
  mkdirSync(dir, { recursive: true });
  if (!isCanonicalFileStem(options.fileStem)) {
    throw new Error('invalid doctor graph file stem');
  }
  const graph = parseArtifactGraphDocument(buildDoctorArtifactGraph(options));
  if (!graph) throw new Error('invalid doctor artifact graph');
  const fileStem = options.fileStem;
  const graphPath = join(dir, graphFileName(fileStem));
  const evidenceCardPath = join(dir, cardFileName(fileStem));
  writeJsonFileAtomic(graphPath, graph);
  writeFileSync(evidenceCardPath, renderDoctorEvidenceCard(graph, options.skill, options.lang), 'utf8');
  return { graphPath, evidenceCardPath };
}

export function removeDoctorGraphSidecars(doctorOutputDir: string, fileStem: string): void {
  if (!isCanonicalFileStem(fileStem)) return;
  const dir = doctorGraphDirForDoctorOutput(doctorOutputDir);
  for (const ext of ['graph.json', 'card.md']) {
    try {
      unlinkSync(join(dir, `${fileStem}.${ext}`));
    } catch {
      // best-effort cleanup only
    }
  }
}

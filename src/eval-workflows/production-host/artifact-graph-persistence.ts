import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { coreRunArtifactDirectoryName, type StoredCoreRunArtifacts } from '../artifact-store/index.js';
import { projectCoreArtifactGraph } from '../downstream-projections/index.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';

export interface PersistedCoreArtifactSidecars {
  readonly graphPath: string;
  readonly evidenceCardPath: string;
}

/** Render a privacy-safe human index from authenticated Core metadata only. */
function renderCoreEvidenceCard(source: Readonly<StoredCoreRunArtifacts>): string {
  const { manifest, plan, report } = source;
  const decision = report.decision;
  const decisionStatus = decision?.decisionStatus ?? 'not-present';
  const verdict = decision?.decisionStatus === 'decided' ? decision.verdict : '—';
  const reasonCodes = decision !== undefined && decision.decisionStatus !== 'failed'
    ? decision.reasonCodes.join(', ')
    : '—';
  const targets = plan.execution.targets.map((target) => (
    `| \`${target.targetId}\` | \`${target.targetKind}\` | \`${target.executorId}\` |`
  ));
  return [
    '# 评测证据／Evaluation Evidence',
    '',
    '> 仅由已认证 Evaluation Core 元数据生成的隐私安全投影。Privacy-safe projection from authenticated Evaluation Core metadata.',
    '',
    '## 身份／Identity',
    '',
    `- runId: \`${manifest.runId}\``,
    `- reportId: \`${report.reportId}\``,
    `- createdAt: \`${manifest.createdAt}\``,
    `- runContractDigest: \`${manifest.runContractDigest}\``,
    `- reportDigest: \`${report.reportDigest}\``,
    '',
    '## 状态／Status',
    '',
    `- runStatus: \`${report.status.runStatus}\``,
    `- evidenceStatus: \`${report.status.evidenceStatus}\``,
    `- conclusionStatus: \`${report.status.conclusionStatus}\``,
    `- decisionStatus: \`${decisionStatus}\``,
    `- verdict: \`${verdict}\``,
    `- reasonCodes: \`${reasonCodes}\``,
    '',
    '## 目标／Targets',
    '',
    '| targetId | targetKind | executorId |',
    '| --- | --- | --- |',
    ...targets,
    '',
    '## 文档／Documents',
    '',
    '- [`manifest.json`](../manifest.json)',
    '- [`report.json`](../report.json)',
    '- [`graph.json`](./graph.json)',
    '',
  ].join('\n');
}

/** Persists privacy-safe graph and evidence-card projections from exact Core artifacts. */
export async function persistCoreArtifactSidecars(input: Readonly<{
  source: Readonly<StoredCoreRunArtifacts>;
  outputDirectory: string;
  cwd: string;
}>): Promise<PersistedCoreArtifactSidecars> {
  const directory = join(
    input.outputDirectory,
    coreRunArtifactDirectoryName(input.source.manifest.runId),
    'derived',
  );
  await mkdir(directory, { recursive: true });
  const graphPath = join(directory, 'graph.json');
  const evidenceCardPath = join(directory, 'card.md');
  const graph = projectCoreArtifactGraph({
    source: input.source,
    cwd: input.cwd,
    generatedAt: input.source.manifest.createdAt,
  });
  writeJsonFileAtomic(graphPath, graph);
  await writeFile(evidenceCardPath, renderCoreEvidenceCard(input.source), 'utf8');
  return Object.freeze({ graphPath, evidenceCardPath });
}

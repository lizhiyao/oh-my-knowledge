import { resolve } from 'node:path';
import { buildTasksFromArtifacts } from '../eval-core/task-planner.js';
import { loadSamples } from '../data-loaders/load-samples.js';
import { resolveArtifacts } from '../data-loaders/skill-loader.js';
import { buildVariantConfig } from '../eval-core/execution-strategy.js';
import { loadMcpConfig, resolveMcpUrls } from '../data-loaders/mcp-resolver.js';
import { resolveUrls } from '../data-loaders/url-fetcher.js';
import type { Artifact, McpServers, Sample, Task } from '../types.js';

export interface PreparedEvaluationRun {
  samples: Sample[];
  artifacts: Artifact[];
  tasks: Task[];
  variantNames: string[];
}

export async function prepareEvaluationRun({
  samplesPath,
  skillDir,
  variants,
  artifacts,
  dryRun,
  mcpConfig,
}: {
  samplesPath: string;
  skillDir: string;
  variants: string[];
  artifacts?: Artifact[];
  dryRun: boolean;
  mcpConfig?: string;
}): Promise<PreparedEvaluationRun> {
  const samples = loadSamples(samplesPath);
  const resolvedArtifacts = artifacts || resolveArtifacts(resolve(skillDir), variants);

  if (!dryRun) {
    const mcpServers: McpServers | null = loadMcpConfig(mcpConfig);
    const mcpResolved = mcpServers ? await resolveMcpUrls(samples, mcpServers) : new Set<string>();
    await resolveUrls(samples, mcpResolved);
  }

  if (resolvedArtifacts.length === 0) {
    throw new Error(
      `未发现任何 skill 变体。请检查：\n`
      + `  1. skill 目录是否存在：${resolve(skillDir)}\n`
      + `  2. 目录下是否有 .md 文件或含 SKILL.md 的子目录\n`
      + `  3. 或通过 --variants 显式指定变体`,
    );
  }

  const tasks = buildTasksFromArtifacts(samples, resolvedArtifacts);
  const variantNames = resolvedArtifacts.map((artifact) => artifact.name);

  return {
    samples,
    artifacts: resolvedArtifacts,
    tasks,
    variantNames,
  };
}

export function buildDryRunTaskReport({
  model,
  judgeModel,
  executorName,
  samplesPath,
  skillDir,
  tasks,
  variantNames,
}: {
  model: string;
  judgeModel: string;
  executorName: string;
  samplesPath: string;
  skillDir: string;
  tasks: Task[];
  variantNames: string[];
}) {
  return {
    dryRun: true as const,
    model,
    judgeModel,
    variants: variantNames,
    executor: executorName,
    samplesPath,
    skillDir,
    totalTasks: tasks.length,
    tasks: tasks.map((task) => {
      const config = buildVariantConfig(task.artifact);
      return {
        sample_id: task.sample_id,
        variant: task.variant,
        artifactKind: task.artifact.kind,
        artifactSource: task.artifact.source,
        executionStrategy: config.executionStrategy,
        experimentType: config.experimentType,
        cwd: task.cwd,
        promptPreview: task.prompt.slice(0, 100),
        hasRubric: Boolean(task.rubric),
        hasAssertions: Boolean(task.assertions?.length),
        hasDimensions: Boolean(task.dimensions && Object.keys(task.dimensions).length),
        hasSystem: Boolean(task.artifactContent),
      };
    }),
  };
}

export function buildDryRunEachArtifacts(skillEntries: Array<{ name: string; skillPath: string; samplesPath: string }>) {
  const artifacts = skillEntries.map((entry) => {
    const samples = loadSamples(entry.samplesPath);
    return {
      name: entry.name,
      samplesPath: entry.samplesPath,
      sampleCount: samples.length,
      taskCount: samples.length * 2,
    };
  });

  return {
    artifacts,
    totalTasks: artifacts.reduce((sum, artifact) => sum + artifact.taskCount, 0),
  };
}

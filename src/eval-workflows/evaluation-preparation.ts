import { resolve } from 'node:path';
import { buildTasksFromArtifacts } from '../eval-core/task-planner.js';
import { loadSamples } from '../inputs/load-samples.js';
import { resolveArtifacts } from '../inputs/skill-loader.js';
import { buildVariantConfig } from '../eval-core/execution-strategy.js';
import { loadMcpConfig, resolveMcpUrls } from '../inputs/mcp-resolver.js';
import { resolveUrls } from '../inputs/url-fetcher.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';
import type { Artifact, McpServers, Sample, Task, VariantSpec } from '../types/index.js';

export interface PreparedEvaluationRun {
  samples: Sample[];
  artifacts: Artifact[];
  tasks: Task[];
  variantNames: string[];
  requires?: DependencyRequirements;
}

export async function prepareEvaluationRun({
  samplesPath,
  skillDir,
  variantSpecs,
  artifacts,
  dryRun,
  mcpConfig,
}: {
  samplesPath: string;
  skillDir: string;
  variantSpecs: VariantSpec[];
  artifacts?: Artifact[];
  dryRun: boolean;
  mcpConfig?: string;
}): Promise<PreparedEvaluationRun> {
  const { samples, requires } = loadSamples(samplesPath);

  // Build expressions from specs (preserving order) and resolve to artifacts.
  const variantExpressions = variantSpecs.map((spec) => spec.expr);
  const resolvedArtifacts = artifacts || resolveArtifacts(resolve(skillDir), variantExpressions);

  // Attach experimentRole to each artifact by matching spec.name to artifact.name.
  const roleByName: Record<string, VariantSpec['role']> = {};
  for (const spec of variantSpecs) roleByName[spec.name] = spec.role;
  for (const artifact of resolvedArtifacts) {
    if (artifact.experimentRole) continue;  // preserve if already set (e.g. each-workflow)
    const role = roleByName[artifact.name];
    if (role) artifact.experimentRole = role;
  }

  if (!dryRun) {
    const mcpServers: McpServers | null = loadMcpConfig(mcpConfig);
    const mcpResolved = mcpServers ? await resolveMcpUrls(samples, mcpServers) : new Set<string>();
    await resolveUrls(samples, mcpResolved);
  }

  if (resolvedArtifacts.length === 0) {
    throw new Error(
      `未发现任何 variant。请检查：\n`
      + `  1. skill 目录是否存在：${resolve(skillDir)}\n`
      + `  2. 目录下是否有 .md 文件或含 SKILL.md 的子目录\n`
      + `  3. 通过 --control / --treatment 显式声明 variant 与角色，或用 --config eval.yaml`,
    );
  }

  const tasks = buildTasksFromArtifacts(samples, resolvedArtifacts);
  const variantNames = resolvedArtifacts.map((artifact) => artifact.name);

  return {
    samples,
    artifacts: resolvedArtifacts,
    tasks,
    variantNames,
    requires,
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
        experimentRole: config.experimentRole,
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
    const { samples } = loadSamples(entry.samplesPath);
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

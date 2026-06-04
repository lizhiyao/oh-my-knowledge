import { resolve } from 'node:path';
import { buildTasksFromArtifacts } from '../eval-core/task-planner.js';
import { loadSamples } from '../inputs/load-samples.js';
import { resolveArtifacts } from '../inputs/skill-loader.js';
import { buildVariantConfig } from '../eval-core/execution-strategy.js';
import { loadMcpConfig, resolveMcpUrls } from '../inputs/mcp-resolver.js';
import { resolveUrls } from '../inputs/url-fetcher.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';
import type { Artifact, JudgeConfig, McpServers, Sample, Task, VariantSpec } from '../types/index.js';

export interface PreparedEvaluationRun {
  samples: Sample[];
  artifacts: Artifact[];
  tasks: Task[];
  variantNames: string[];
  requires?: DependencyRequirements;
  /** Sample bundle 根目录(单文件模式 = 文件所在 dir,目录模式 = 目录本身)。
   *  传给 grade / mock / test set hash 当 base 锚点。 */
  samplesBaseDir: string;
  /** Sample bundle 内参与合并的所有源文件绝对路径(已排序)。test set hash 用它遍历。 */
  samplesSourceFiles: string[];
}

export async function prepareEvaluationRun({
  samplesPath,
  skillDir,
  variantSpecs,
  dryRun,
  mcpConfig,
  strictBaseline,
}: {
  samplesPath: string;
  skillDir: string;
  variantSpecs: VariantSpec[];
  dryRun: boolean;
  mcpConfig?: string;
  /**  — default true, baseline-kind 自动 allowedSkills=[]。 */
  strictBaseline?: boolean;
}): Promise<PreparedEvaluationRun> {
  const { samples, requires, baseDir: samplesBaseDir, sourceFiles: samplesSourceFiles } = loadSamples(samplesPath);

  // 结构化传入 {expr, cwd}(与 variantSpecs 顺序一一对应),cwd 不再编码进 expr 字符串。
  // resolveArtifacts 只保留 strictBaseline 默认(baseline → []);per-variant 隔离声明走
  // spec.allowedSkills,在下面按 spec 身份绑定。
  const variantInputs = variantSpecs.map((spec) => ({ expr: spec.expr, cwd: spec.cwd }));
  const resolvedArtifacts = resolveArtifacts(resolve(skillDir), variantInputs, { strictBaseline });

  // experimentRole / allowedSkills 按 spec 身份绑定。variantSpecs 与 resolvedArtifacts 顺序
  // 一一对应(resolveArtifacts 每个 input 产出一个 artifact),按 index 绑定,并把 spec.name
  // 同步成消歧后的最终唯一名。不能按 spec.name 匹配 artifact.name:同 basename 的 variant 被
  // ensureUniqueVariantNames 消歧后(v1/greeter / v2/greeter)就和 spec 的派生短名(greeter)
  // 对不上,会丢 role。
  variantSpecs.forEach((spec, i) => {
    const artifact = resolvedArtifacts[i];
    artifact.experimentRole = spec.role;
    // spec.allowedSkills 是隔离声明的单一来源(eval.yaml 经 configVariantsToSpecs、batch 经
    // buildBatchVariantSpecs 都挂到 spec 上),显式声明优先于 strictBaseline 默认。
    if (spec.allowedSkills !== undefined) artifact.allowedSkills = spec.allowedSkills;
    spec.name = artifact.name; // 同步唯一名,让 spec 与 report / variantNames 一致(放最后,前面还要用旧名查)
  });

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
    samplesBaseDir,
    samplesSourceFiles,
  };
}

export function buildDryRunTaskReport({
  model,
  judgeModels,
  executorName,
  samplesPath,
  skillDir,
  tasks,
  variantNames,
}: {
  model: string;
  judgeModels: JudgeConfig[];
  executorName: string;
  samplesPath: string;
  skillDir: string;
  tasks: Task[];
  variantNames: string[];
}) {
  return {
    dryRun: true as const,
    model,
    judgeModels,
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


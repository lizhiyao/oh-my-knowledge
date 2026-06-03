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
  artifacts,
  dryRun,
  mcpConfig,
  strictBaseline,
  variantAllowedSkills,
}: {
  samplesPath: string;
  skillDir: string;
  variantSpecs: VariantSpec[];
  artifacts?: Artifact[];
  dryRun: boolean;
  mcpConfig?: string;
  /**  — default true, baseline-kind 自动 allowedSkills=[]。 */
  strictBaseline?: boolean;
  /**  — eval.yaml 显式 allowedSkills per variant (overrides strictBaseline default). */
  variantAllowedSkills?: Record<string, string[]>;
}): Promise<PreparedEvaluationRun> {
  const { samples, requires, baseDir: samplesBaseDir, sourceFiles: samplesSourceFiles } = loadSamples(samplesPath);

  // Build expressions from specs (preserving order) and resolve to artifacts.
  const variantExpressions = variantSpecs.map((spec) => spec.expr);
  const resolvedArtifacts = artifacts || resolveArtifacts(
    resolve(skillDir),
    variantExpressions,
    { strictBaseline, variantAllowedSkills },
  );

  // Attach experimentRole to each artifact.
  //   - 当 artifacts 由本函数从 variantSpecs.map(spec => spec.expr) 解析时,两者顺序一一对应,
  //     按 index 绑定 role,并把 spec.name 同步成消歧后的最终唯一名。不能按 spec.name 匹配
  //     artifact.name:同 basename 的 variant 被 ensureUniqueVariantNames 消歧后(v1/greeter /
  //     v2/greeter)就和 spec 的派生短名(greeter)对不上,会丢 role。
  //   - 当 artifacts 由外部传入(如 batch workflow,role 已预置)时,index 无法对齐,
  //     退回按 name 匹配,且 if-already-set 守卫会保留预置 role。
  if (!artifacts && variantSpecs.length === resolvedArtifacts.length) {
    variantSpecs.forEach((spec, i) => {
      const artifact = resolvedArtifacts[i];
      if (!artifact.experimentRole) artifact.experimentRole = spec.role;
      // allowedSkills 也要按 spec 身份重绑:resolveArtifacts 里是按解析出的 artifact.name 查
      // variantAllowedSkills,而 eval.yaml 的 key 是用户自定义的 variant 名(可与 artifact
      // 短名不同,如 name:control-v1 / artifact:.../v1.md)。漏绑会把本该隔离的 variant 悄悄
      // 退回 SDK 默认 discovery,破坏 construct validity。用同步前的 spec.name 覆盖回来,
      // 显式声明优先于 strictBaseline 默认。
      const explicit = variantAllowedSkills?.[spec.name];
      if (explicit !== undefined) artifact.allowedSkills = explicit;
      spec.name = artifact.name; // 同步唯一名,让 spec 与 report / variantNames 一致(放最后,前面还要用旧名查)
    });
  } else {
    const roleByName: Record<string, VariantSpec['role']> = {};
    for (const spec of variantSpecs) roleByName[spec.name] = spec.role;
    for (const artifact of resolvedArtifacts) {
      if (artifact.experimentRole) continue;  // preserve if already set (e.g. batch workflow)
      const role = roleByName[artifact.name];
      if (role) artifact.experimentRole = role;
    }
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


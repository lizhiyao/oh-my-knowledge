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

  // 结构化传入 {expr, cwd}(顺序一一对应),cwd 不再编码进 expr 字符串。
  const variantInputs = variantSpecs.map((spec) => ({ expr: spec.expr, cwd: spec.cwd }));
  // 不把 variantAllowedSkills 透进 resolveArtifacts:那里按解析出的 artifact 名查,
  // 与 eval.yaml 的自定义 variant 名不一致时会漏绑。allowedSkills 统一在下面按 spec 绑定。
  // resolveArtifacts 只保留 strictBaseline 默认(baseline → [])。
  const resolvedArtifacts = artifacts || resolveArtifacts(
    resolve(skillDir),
    variantInputs,
    { strictBaseline },
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
      // allowedSkills 按 spec 身份绑定(eval 主路径的唯一隔离绑定点,显式声明优先于
      // strictBaseline 默认)。首选 spec.allowedSkills(eval.yaml 经 configVariantsToSpecs 带上);
      // 旧的按变量名 map 仅作 legacy fallback,兜住「CLI roles 覆盖 config 时 spec 不带
      // allowedSkills」等边角,行为与重构前一致。
      // TODO: 待所有路径都按 spec 携带 allowedSkills 后,移除 variantAllowedSkills 这条 fallback,
      //       与 resolveArtifacts 里的按名绑定一并收成单一来源。
      const explicit = spec.allowedSkills ?? variantAllowedSkills?.[spec.name];
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


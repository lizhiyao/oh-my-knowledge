import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Artifact, ExecutionStrategyKind, ExecutorInput, ExperimentType, Task, VariantConfig } from '../types/index.js';

/**
 * v0.22 — Isolated cwd for strict baseline. Empty dir under ~/.oh-my-knowledge/
 * so baseline's Glob/Read tools can't walk into the user's eval workdir (which
 * usually has skills/<name>/ symlinks for treatment variants — those symlinks
 * leak the skill content into baseline via plain file-system access, even when
 * Skill auto-discovery is blocked).
 *
 * Stable path (not per-task tmpdir) so cache keys remain consistent.
 */
function getIsolatedCwd(): string {
  const dir = join(homedir(), '.oh-my-knowledge', 'isolated-cwd');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export interface ExecutionPlan {
  strategy: ExecutionStrategyKind;
  cacheSystem: string;
  input: ExecutorInput;
}

function combineUserPrompt(prefix: string | null, prompt: string): string {
  if (!prefix) return prompt;
  return `${prefix}\n\n${prompt}`;
}

export function resolveArtifactExecutionStrategy(artifact: Artifact): ExecutionStrategyKind {
  switch (artifact.kind) {
    case 'baseline':
      return 'baseline';
    case 'prompt':
      return 'user-prompt';
    case 'agent':
      return 'agent-session';
    case 'workflow':
      return 'workflow-session';
    case 'skill':
    default:
      return 'system-prompt';
  }
}

export function resolveExperimentType(artifact: Artifact): ExperimentType {
  if (artifact.kind === 'baseline' && !artifact.cwd) return 'baseline';
  if (artifact.kind === 'baseline' && artifact.cwd) return 'runtime-context-only';
  return 'artifact-injection';
}

export function buildVariantConfig(artifact: Artifact): VariantConfig {
  // experimentRole 是 variant 的 run-time 属性,必须由上游显式注入:
  //   - CLI:`--control` / `--treatment` 在 evaluation-preparation.ts 按 spec.name 匹配填
  //   - each-workflow:显式标 baseline=control / skill=treatment
  //   - config:configVariantsToSpecs 从 EvalConfig.variants.role 带入
  // 静默从 artifactKind 反推会违反 terminology-spec 三-4"experimentRole 是唯一来源",
  // 因此缺失时直接 throw,强迫调用者修配置,不走默认值掩盖。
  if (!artifact.experimentRole) {
    throw new Error(
      `artifact "${artifact.name}" 缺少 experimentRole:应该由 CLI --control/--treatment、`
      + `--config eval.yaml 或 each-workflow 显式注入。参见 docs/terminology-spec.md 三-4。`,
    );
  }
  return {
    variant: artifact.name,
    artifactKind: artifact.kind,
    artifactSource: artifact.source,
    executionStrategy: resolveArtifactExecutionStrategy(artifact),
    experimentType: resolveExperimentType(artifact),
    experimentRole: artifact.experimentRole,
    hasArtifactContent: Boolean(artifact.content),
    cwd: artifact.cwd || null,
    locator: artifact.locator,
    ref: artifact.ref,
    // v0.22 — propagate skill-isolation declaration so report.meta.skillIsolation
    // 能在 evaluation-reporting 阶段从 variantConfigs 提取 (avoid re-resolving artifacts).
    ...(artifact.allowedSkills !== undefined && { allowedSkills: artifact.allowedSkills }),
  };
}

function extractSkillDir(artifact: Artifact): string | null {
  if (!artifact.locator) return null;
  return dirname(artifact.locator);
}

export function resolveExecutionStrategy(task: Task, model: string, timeoutMs?: number, verbose?: boolean): ExecutionPlan {
  const skillDir = extractSkillDir(task.artifact);
  // v0.22 — strict-baseline cwd 沙箱:baseline + allowedSkills===[] + 用户没显式
  // cwd 时,改用 isolated empty dir。否则 baseline 的 Glob/Read 会走进用户工作目录
  // (含 skills/<name>/ symlink) 直接读到 skill 内容,绕过 SDK isolation。
  // 用户显式给 baseline 设了 cwd 时不动(用户自己负责干净)。
  const isStrictBaseline =
    task.artifact.kind === 'baseline'
    && Array.isArray(task.artifact.allowedSkills)
    && task.artifact.allowedSkills.length === 0;
  const effectiveCwd = isStrictBaseline && !task.cwd ? getIsolatedCwd() : task.cwd;
  const baseInput = {
    model,
    cwd: effectiveCwd,
    skillDir,
    timeoutMs,
    verbose,
    // v0.22 — pass skill-isolation declaration to executors. undefined keeps
    // SDK default; [] = strict isolation (skills:[] + disallowedTools:['Skill']);
    // [...] = whitelist (skills:[...] only).
    ...(task.artifact.allowedSkills !== undefined && { allowedSkills: task.artifact.allowedSkills }),
  };

  switch (task.artifact.kind) {
    case 'baseline':
      return {
        strategy: resolveArtifactExecutionStrategy(task.artifact),
        cacheSystem: '',
        input: {
          ...baseInput,
          system: null,
          prompt: task.prompt,
        },
      };
    case 'prompt':
      return {
        strategy: resolveArtifactExecutionStrategy(task.artifact),
        cacheSystem: '',
        input: {
          ...baseInput,
          system: null,
          prompt: combineUserPrompt(task.artifact.content, task.prompt),
        },
      };
    case 'agent':
      return {
        strategy: resolveArtifactExecutionStrategy(task.artifact),
        cacheSystem: task.artifact.content ?? '',
        input: {
          ...baseInput,
          system: task.artifact.content,
          prompt: task.prompt,
        },
      };
    case 'workflow':
      return {
        strategy: resolveArtifactExecutionStrategy(task.artifact),
        cacheSystem: task.artifact.content ?? '',
        input: {
          ...baseInput,
          system: task.artifact.content,
          prompt: task.prompt,
        },
      };
    case 'skill':
    default:
      return {
        strategy: resolveArtifactExecutionStrategy(task.artifact),
        cacheSystem: task.artifact.content ?? '',
        input: {
          ...baseInput,
          system: task.artifact.content,
          prompt: task.prompt,
        },
      };
  }
}

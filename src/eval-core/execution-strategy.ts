import { dirname } from 'node:path';
import type { Artifact, ExecutionStrategyKind, ExecutorInput, ExperimentType, Task, VariantConfig } from '../types/index.js';

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
  };
}

function extractSkillDir(artifact: Artifact): string | null {
  if (!artifact.locator) return null;
  return dirname(artifact.locator);
}

export function resolveExecutionStrategy(task: Task, model: string, timeoutMs?: number, verbose?: boolean): ExecutionPlan {
  const skillDir = extractSkillDir(task.artifact);
  const baseInput = {
    model,
    cwd: task.cwd,
    skillDir,
    timeoutMs,
    verbose,
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

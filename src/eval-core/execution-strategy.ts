import { dirname } from 'node:path';
import type { Artifact, ExecutionStrategyKind, ExecutorInput, ExperimentType, Task, VariantConfig } from '../types.js';

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
  return {
    variant: artifact.name,
    artifactKind: artifact.kind,
    artifactSource: artifact.source,
    executionStrategy: resolveArtifactExecutionStrategy(artifact),
    experimentType: resolveExperimentType(artifact),
    hasArtifactContent: Boolean(artifact.content),
    cwd: artifact.cwd || null,
    locator: artifact.locator,
    ref: artifact.ref,
  };
}

function extractSkillDir(artifact: Artifact): string | null {
  if (!artifact.locator) return null;
  const dir = dirname(artifact.locator);
  // locator 可能是 skills/name/SKILL.md（取 skills/name）或 skills/name.md（取 skills）
  // 如果是 SKILL.md 路径，skill 目录就是它的父目录
  if (artifact.locator.endsWith('/SKILL.md') || artifact.locator.endsWith('\\SKILL.md')) {
    return dir;
  }
  return dir;
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

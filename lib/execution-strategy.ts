import type { Artifact, ExecutionStrategyKind, ExecutorInput, ExperimentRole, Task, VariantConfig } from './types.js';

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

export function resolveExperimentRole(artifact: Artifact): ExperimentRole {
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
    experimentRole: resolveExperimentRole(artifact),
    hasArtifactContent: Boolean(artifact.content),
    cwd: artifact.cwd || null,
    locator: artifact.locator,
    ref: artifact.ref,
  };
}

export function resolveExecutionStrategy(task: Task, model: string, timeoutMs?: number, verbose?: boolean): ExecutionPlan {
  const baseInput = {
    model,
    cwd: task.cwd,
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

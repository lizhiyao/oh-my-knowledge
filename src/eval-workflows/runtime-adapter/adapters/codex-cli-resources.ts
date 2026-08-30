import type {
  EvaluationDefinition,
} from '../../../evaluation-core/contracts/index.js';
import type {
  ExecutorTrialContext,
} from '../../../evaluation-core/execution/index.js';
import type { RuntimeBindingOf } from '../types.js';
import type { OmkBindingResourceLease } from '../resource-leases/types.js';
import {
  CODEX_CLI_RESOURCE_PROFILE,
  captureCodexRunState,
  captureCodexTarget,
  promptForCodexTrial,
  selectCodexSandbox,
  type CapturedCodexTarget,
  type CodexRunState,
  type CodexTargetConfig,
} from './codex-resources.js';

export type CodexCliTargetConfig = CodexTargetConfig;
export type CapturedCodexCliTarget = CapturedCodexTarget;
export type CodexCliRunState = CodexRunState;

export function captureCodexCliTarget(
  target: EvaluationDefinition['targets'][number],
  binding: RuntimeBindingOf<'executor'>,
): CapturedCodexCliTarget {
  return captureCodexTarget(target, binding, CODEX_CLI_RESOURCE_PROFILE);
}

export function selectCodexCliSandbox(
  config: CodexCliTargetConfig,
): 'read-only' | 'workspace-write' {
  return selectCodexSandbox(config, CODEX_CLI_RESOURCE_PROFILE);
}

export function captureCodexCliRunState(
  lease: OmkBindingResourceLease,
  target: CapturedCodexCliTarget,
): Promise<CodexCliRunState> {
  return captureCodexRunState(lease, target, CODEX_CLI_RESOURCE_PROFILE);
}

export function promptForCodexCliTrial(
  trial: Readonly<ExecutorTrialContext>,
  runState: CodexCliRunState,
  maxPromptBytes: number,
): string {
  return promptForCodexTrial(
    trial,
    runState,
    maxPromptBytes,
    CODEX_CLI_RESOURCE_PROFILE,
  );
}

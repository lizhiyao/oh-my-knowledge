import type {
  EvaluationDefinition,
} from '../../../eval-core/contracts/index.js';
import type {
  ExecutorTrialContext,
} from '../../../eval-core/execution/index.js';
import type { RuntimeBindingOf } from '../../types.js';
import type { OmkBindingResourceLease } from '../../resource-leases/types.js';
import {
  CODEX_CLI_RESOURCE_PROFILE,
  captureCodexRunState,
  captureCodexTarget,
  promptForCodexTrial,
  selectCodexSandbox,
  openCodexTrialWorkspace,
  type CapturedCodexTarget,
  type CodexRunState,
  type CodexTargetConfig,
} from './resources.js';

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
  workspaceMode: ExecutorTrialContext['executionControl']['workspace']['workspaceMode'],
): 'read-only' | 'workspace-write' {
  return selectCodexSandbox(config, workspaceMode, CODEX_CLI_RESOURCE_PROFILE);
}

export function openCodexCliTrialWorkspace(
  trial: Readonly<ExecutorTrialContext>,
  runState: CodexCliRunState,
  target: CapturedCodexCliTarget,
): ReturnType<typeof openCodexTrialWorkspace> {
  return openCodexTrialWorkspace(
    trial,
    runState,
    CODEX_CLI_RESOURCE_PROFILE,
    target,
  );
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

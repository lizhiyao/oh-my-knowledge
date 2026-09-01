export type ExecutorRuntimeKind = 'agent-cli' | 'agent-sdk' | 'api' | 'script' | 'unknown';

export type ExecutorSystemPromptMode = 'native' | 'prepended' | 'none' | 'unknown';

export type ExecutorCostMode = 'reported' | 'not-reported' | 'unknown';

export type ExecutorTraceMode = 'native' | 'best-effort' | 'none' | 'unknown';

export type ExecutorSkillIsolationMode = 'full' | 'full-no-partial' | 'cwd-only' | 'none' | 'unknown';

export interface ExecutorRuntimeCapabilities {
  systemPrompt: ExecutorSystemPromptMode;
  costUSD: ExecutorCostMode;
  trace: ExecutorTraceMode;
  skillIsolation: ExecutorSkillIsolationMode;
}

export interface ExecutorRuntimePackage {
  name: string;
  version?: string;
  error?: string;
}

export interface ExecutorRuntimeBinary {
  name: string;
  source: 'path' | 'bundled' | 'none' | 'unknown';
  version?: string;
  path?: string;
  /** Content identity for local script/custom executor inputs. */
  contentHash?: string;
  package?: ExecutorRuntimePackage;
  error?: string;
}

export interface ExecutorRuntimeFingerprint {
  executor: string;
  model: string;
  runtimeKind: ExecutorRuntimeKind;
  fingerprint: string;
  binary?: ExecutorRuntimeBinary;
  sdk?: ExecutorRuntimePackage;
  /** Whether the recorded fields cover the complete effective runtime composition. */
  auditability?: {
    status: 'complete' | 'partial';
    reasons?: string[];
  };
  capabilities: ExecutorRuntimeCapabilities;
}

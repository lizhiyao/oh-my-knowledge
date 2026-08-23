import type {
  ExecutorRuntimeCapabilities,
  ExecutorRuntimeKind,
} from '../../types/index.js';

export type ExecutorVendor = 'anthropic' | 'openai' | 'unknown';

export type ExecutorFamily =
  | 'claude'
  | 'codex'
  | 'dsh'
  | 'anthropic-api'
  | 'openai-api';

export type SampleMockSupport =
  | 'native-hooks'
  | 'delegated-script'
  | 'unsupported';

export interface ExecutorCapabilities {
  sampleMocks: SampleMockSupport;
}

export type ExecutorFingerprintSpec =
  | { readonly strategy: 'path-cli'; readonly command: 'claude' | 'codex' }
  | { readonly strategy: 'claude-sdk' }
  | { readonly strategy: 'codex-sdk' }
  | { readonly strategy: 'api' }
  | { readonly strategy: 'dsh-host' };

interface ExecutorDescriptorShape {
  readonly name: string;
  readonly execution: 'builtin' | 'host-only';
  readonly family: ExecutorFamily;
  readonly vendor: ExecutorVendor;
  readonly sampleMocks: SampleMockSupport;
  readonly runtimeKind: ExecutorRuntimeKind;
  readonly runtimeCapabilities: ExecutorRuntimeCapabilities;
  readonly fingerprint: ExecutorFingerprintSpec;
}

const EXECUTOR_DESCRIPTORS = [
  {
    name: 'claude',
    execution: 'builtin',
    family: 'claude',
    vendor: 'anthropic',
    sampleMocks: 'native-hooks',
    runtimeKind: 'agent-cli',
    runtimeCapabilities: {
      systemPrompt: 'native',
      costUSD: 'reported',
      trace: 'native',
      skillIsolation: 'full-no-partial',
    },
    fingerprint: { strategy: 'path-cli', command: 'claude' },
  },
  {
    name: 'claude-sdk',
    execution: 'builtin',
    family: 'claude',
    vendor: 'anthropic',
    sampleMocks: 'native-hooks',
    runtimeKind: 'agent-sdk',
    runtimeCapabilities: {
      systemPrompt: 'native',
      costUSD: 'reported',
      trace: 'native',
      skillIsolation: 'full',
    },
    fingerprint: { strategy: 'claude-sdk' },
  },
  {
    name: 'codex',
    execution: 'builtin',
    family: 'codex',
    vendor: 'openai',
    sampleMocks: 'unsupported',
    runtimeKind: 'agent-cli',
    runtimeCapabilities: {
      systemPrompt: 'prepended',
      costUSD: 'not-reported',
      trace: 'best-effort',
      skillIsolation: 'cwd-only',
    },
    fingerprint: { strategy: 'path-cli', command: 'codex' },
  },
  {
    name: 'codex-sdk',
    execution: 'builtin',
    family: 'codex',
    vendor: 'openai',
    sampleMocks: 'unsupported',
    runtimeKind: 'agent-sdk',
    runtimeCapabilities: {
      systemPrompt: 'prepended',
      costUSD: 'not-reported',
      trace: 'best-effort',
      skillIsolation: 'cwd-only',
    },
    fingerprint: { strategy: 'codex-sdk' },
  },
  {
    name: 'dsh-host',
    execution: 'host-only',
    family: 'dsh',
    vendor: 'unknown',
    sampleMocks: 'unsupported',
    runtimeKind: 'agent-sdk',
    runtimeCapabilities: {
      systemPrompt: 'native',
      costUSD: 'not-reported',
      trace: 'native',
      skillIsolation: 'full-no-partial',
    },
    fingerprint: { strategy: 'dsh-host' },
  },
  {
    name: 'anthropic-api',
    execution: 'builtin',
    family: 'anthropic-api',
    vendor: 'anthropic',
    sampleMocks: 'unsupported',
    runtimeKind: 'api',
    runtimeCapabilities: {
      systemPrompt: 'native',
      costUSD: 'not-reported',
      trace: 'none',
      skillIsolation: 'none',
    },
    fingerprint: { strategy: 'api' },
  },
  {
    name: 'openai-api',
    execution: 'builtin',
    family: 'openai-api',
    vendor: 'openai',
    sampleMocks: 'unsupported',
    runtimeKind: 'api',
    runtimeCapabilities: {
      systemPrompt: 'native',
      costUSD: 'not-reported',
      trace: 'none',
      skillIsolation: 'none',
    },
    fingerprint: { strategy: 'api' },
  },
] as const satisfies readonly ExecutorDescriptorShape[];

export type RegisteredExecutorDescriptor = (typeof EXECUTOR_DESCRIPTORS)[number];
export type RegisteredExecutorName = RegisteredExecutorDescriptor['name'];
export type ExecutableExecutorName = Extract<
  RegisteredExecutorDescriptor,
  { execution: 'builtin' }
>['name'];

export function executorDescriptors(): readonly RegisteredExecutorDescriptor[] {
  return EXECUTOR_DESCRIPTORS;
}

export function getExecutorDescriptor(name: string): RegisteredExecutorDescriptor | undefined {
  return EXECUTOR_DESCRIPTORS.find((descriptor) => descriptor.name === name);
}

export function isRegisteredExecutorName(name: string): name is RegisteredExecutorName {
  return getExecutorDescriptor(name) !== undefined;
}

export function executorVendor(executor: string): ExecutorVendor {
  return getExecutorDescriptor(executor)?.vendor ?? 'unknown';
}

export function executorFamily(executor: string): ExecutorFamily | 'custom' {
  return getExecutorDescriptor(executor)?.family ?? 'custom';
}

export function executorNamesForFamily(family: ExecutorFamily): ReadonlySet<string> {
  return new Set(
    EXECUTOR_DESCRIPTORS
      .filter((descriptor) => descriptor.family === family)
      .map((descriptor) => descriptor.name),
  );
}

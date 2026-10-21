import type { ExecutorRuntimeCapabilities, ExecutorRuntimeKind } from '../contracts/runtime.js';
import type { ExecutorOutputFormat } from '../contracts/ports.js';

export type ExecutorVendor = 'openai' | 'unknown';

export type ExecutorFamily =
  | 'codex'
  | 'dsh'
  | 'openai-api';

export type SampleMockSupport =
  | 'delegated-script'
  | 'unsupported';

export interface ExecutorCapabilities {
  sampleMocks: SampleMockSupport;
  outputFormats: readonly ExecutorOutputFormat['mode'][];
  maxOutputTokens: boolean;
}

export type ExecutorFingerprintSpec =
  | { readonly strategy: 'path-cli'; readonly command: 'codex' }
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

type UniqueExecutorDescriptors<Entries extends readonly { readonly name: string }[]> =
  Entries extends readonly [
    infer Head extends { readonly name: string },
    ...infer Tail extends readonly { readonly name: string }[],
  ]
    ? Head['name'] extends Tail[number]['name']
      ? never
      : readonly [Head, ...UniqueExecutorDescriptors<Tail>]
    : readonly [];

export type RegisteredExecutorDescriptor = UniqueExecutorDescriptors<
  typeof EXECUTOR_DESCRIPTORS
>[number];
export type ExecutableExecutorName = Extract<
  RegisteredExecutorDescriptor,
  { execution: 'builtin' }
>['name'];

export function getExecutorDescriptor(name: string): RegisteredExecutorDescriptor | undefined {
  return EXECUTOR_DESCRIPTORS.find((descriptor) => descriptor.name === name);
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

export function isRemovedBuiltinExecutor(name: string): boolean {
  return ['gemini', 'claude', 'claude-sdk', 'anthropic-api'].includes(name);
}

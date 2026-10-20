import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measurementRuntimeDigest } from './entity-measurement-runtime.js';

export interface CaptureInput {
  model: string; system: string; prompt: string; timeoutMs: number; maxOutputTokens: number; abortSignal?: AbortSignal;
  outputFormat: { mode: 'prompt-json' } | { mode: 'json-object' } | { mode: 'json-schema'; name: string; schema: Readonly<Record<string, unknown>> };
}
export interface NativeResult {
  ok: boolean; output: string | null; error?: string; failure?: { failureKind: string }; refusal?: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  tokenUsageReportedByExecutor?: boolean; costUSD: number; costReportedByExecutor?: boolean; attemptCount?: number; toolCalls?: unknown[];
}
export interface CaptureRuntime {
  CAPTURE_VALIDATOR_IDENTITY: Readonly<{ zod: string; ajv: string }>;
  OPENAI_CHAT_REQUEST_VERSION: string; OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION: string;
  WINDOW_EXTRACTION_WIRE_ID: string; WINDOW_EXTRACTION_WIRE_SCHEMA: Readonly<Record<string, unknown>>;
  WINDOW_EXTRACTION_WIRE_IDENTITY: { wireSchemaDigest: string };
  OPENAI_TOKEN_BUDGET_EVIDENCE: Readonly<{
    evidenceVersion: string; retrievedOn: string; model: string; contextTokens: number; maxOutputTokens: number;
    modelSource: string; modelFacts: string; capSource: string; capFacts: string; accountingSource: string; accountingFacts: string; reservationRule: string;
  }>;
  OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST: string;
  resolveTokenBudgetProfile(id: string, model: string, endpoint: string): {
    profileId: string; authority: 'official-contract' | 'loopback-test-only'; evidenceDigest: string; inputUpperBound: number; outputUpperBound: number;
  };
  buildOpenAiChatRequest(input: CaptureInput, env: NodeJS.ProcessEnv, constraints: 'single-completion/v1'): { endpoint: string; body: string };
  assertExecutorInputCapabilities(executor: string, input: CaptureInput): void;
  createExecutor(name: string, options: { env: NodeJS.ProcessEnv; apiDispatchPolicy: {
    requestConstraints: 'single-completion/v1'; redirect: 'error'; beforeDispatch(request: Readonly<{ endpoint: string; body: string }>): void;
  } }): (input: CaptureInput) => Promise<NativeResult>;
  checkWindowExtractionResponse(response: unknown, excerpts: readonly { evidenceRef: string; text: string }[]): {
    analysis: { entities: unknown[]; mentions: unknown[]; rejected: unknown[] }; accepted: unknown[]; rejected: unknown[];
  };
  decodeWindowExtractionWire(bytes: Uint8Array): { decodeStatus: string; domainInput?: unknown; wireStatus?: string; wireFailures?: unknown[] };
}
export const bytesDigest = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
export const identityDigest = (value: unknown) => bytesDigest(canonical(value));
export async function loadCaptureRuntime(repository: string): Promise<CaptureRuntime> {
  // Fixed built composition root; neither source/capture content nor arguments can select imported code.
  return await import(pathToFileURL(resolve(repository, 'dist/cli/runtime/entity-capture.js')).href) as CaptureRuntime;
}
export function captureHostIdentity(repository: string, validatorIdentity: CaptureRuntime['CAPTURE_VALIDATOR_IDENTITY']) {
  const here = dirname(fileURLToPath(import.meta.url));
  return { runtimeDigest: measurementRuntimeDigest(resolve(repository, 'dist')),
    collectorDigest: bytesDigest(['entity-capture-provider.js', 'entity-capture-profile.js', 'entity-capture.js', 'entity-extraction-capture.js', 'entity-measurement-runtime.js']
      .map(file => readFileSync(resolve(here, file), 'utf8')).join('\0')),
    checkerDigest: bytesDigest(['entity-extraction-review.js', 'entity-review-corpus.js', 'entity-review-checks.js', 'entity-measurement-runtime.js'].map(file => readFileSync(resolve(here, file), 'utf8')).join('\0')),
    dependencyDigest: bytesDigest(['package.json', 'yarn.lock'].map(file => readFileSync(resolve(repository, file), 'utf8')).join('\0')),
    guideDigest: bytesDigest(['docs/specs/entities/entity-extraction-evaluation.md', 'docs/zh/specs/entities/entity-extraction-evaluation.md']
      .map(file => readFileSync(resolve(repository, file), 'utf8')).join('\0')),
    validatorIdentity, nodeVersion: process.versions.node, nodeBinaryDigest: bytesDigest(readFileSync(process.execPath)) };
}

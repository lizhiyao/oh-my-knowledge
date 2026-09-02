import type { RuntimeBinding } from '../input-compilation/index.js';
import {
  OmkRuntimeAssemblyError,
  type OmkEvaluationRuntimeBindingEntry,
  type OmkEvaluationSeriesRuntimeBindingEntry,
  type OmkRuntimePreflightContext,
  type OmkRuntimePreflightDeclaration,
  type OmkRuntimePreflightKind,
} from './types.js';

const PREFLIGHT_KIND_ORDER = Object.freeze([
  'doctor',
  'credential',
  'connectivity',
  'filesystem',
  'mcp-readiness',
  'mock-readiness',
] satisfies readonly OmkRuntimePreflightKind[]);

const PREFLIGHT_KINDS = new Set<OmkRuntimePreflightKind>(PREFLIGHT_KIND_ORDER);
const PREFLIGHT_KIND_RANK = new Map(
  PREFLIGHT_KIND_ORDER.map((preflightKind, index) => [preflightKind, index]),
);

type RuntimeEntry = OmkEvaluationRuntimeBindingEntry | OmkEvaluationSeriesRuntimeBindingEntry;

export interface OmkEvaluationPreflightModes {
  readonly doctor: 'required' | 'skip';
  readonly connectivity: 'required' | 'skip';
}

export interface OmkEvaluationPreflightOptions {
  readonly signal?: AbortSignal;
}

export interface OmkEvaluationPreflightRecord {
  readonly runtimeKind: RuntimeBinding['runtimeKind'];
  readonly bindingId: string;
  readonly referenceId: string;
  readonly implementationId: string;
  readonly preflightKind: OmkRuntimePreflightKind;
  readonly checkId: string;
  readonly preflightStatus: 'passed' | 'skipped' | 'not-required';
  readonly reasonCode?: string;
}

export interface OmkEvaluationPreflightResult {
  readonly records: readonly OmkEvaluationPreflightRecord[];
}

export type OmkEvaluationPreflightErrorCode =
  | 'OMK_EVALUATION_PREFLIGHT_DECLARATION_MISSING'
  | 'OMK_EVALUATION_PREFLIGHT_CHECK_FAILED'
  | 'OMK_EVALUATION_PREFLIGHT_CHECK_RESULT_INVALID'
  | 'OMK_EVALUATION_PREFLIGHT_CANCELLED';

export class OmkEvaluationPreflightError extends Error {
  readonly code: OmkEvaluationPreflightErrorCode;
  readonly runtimeKind?: RuntimeBinding['runtimeKind'];
  readonly bindingId?: string;
  readonly referenceId?: string;
  readonly preflightKind?: OmkRuntimePreflightKind;
  readonly checkId?: string;

  constructor(input: {
    code: OmkEvaluationPreflightErrorCode;
    message: string;
    runtimeKind?: RuntimeBinding['runtimeKind'];
    bindingId?: string;
    referenceId?: string;
    preflightKind?: OmkRuntimePreflightKind;
    checkId?: string;
  }) {
    super(input.message);
    this.name = 'OmkEvaluationPreflightError';
    this.code = input.code;
    this.runtimeKind = input.runtimeKind;
    this.bindingId = input.bindingId;
    this.referenceId = input.referenceId;
    this.preflightKind = input.preflightKind;
    this.checkId = input.checkId;
  }
}

/** Trusted host checks may attach an already-sanitized actionable message. */
export class OmkUserFacingPreflightFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmkUserFacingPreflightFailure';
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 256
    && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function assemblyFailure(binding: RuntimeBinding): never {
  throw new OmkRuntimeAssemblyError({
    code: 'OMK_RUNTIME_BINDING_PREFLIGHT_INVALID',
    bindingId: binding.bindingId,
    message: 'Runtime binding factory 返回了不合法或重复的 preflight declaration。',
  });
}

/** Captures binding-owned checks with stable metadata and method identity. */
export function captureOmkRuntimePreflightDeclarations(
  binding: RuntimeBinding,
  value: unknown,
): readonly OmkRuntimePreflightDeclaration[] {
  if (!Array.isArray(value)) return assemblyFailure(binding);
  const declarations: OmkRuntimePreflightDeclaration[] = [];
  const identities = new Set<string>();
  for (const item of value) {
    const candidate = record(item);
    const preflightKind = candidate?.preflightKind;
    const checkId = candidate?.checkId;
    const disposition = candidate?.preflightDisposition;
    if (
      candidate === undefined
      || typeof preflightKind !== 'string'
      || !PREFLIGHT_KINDS.has(preflightKind as OmkRuntimePreflightKind)
      || !validIdentifier(checkId)
      || !['check', 'not-required'].includes(String(disposition))
    ) return assemblyFailure(binding);
    const identity = `${preflightKind}\0${checkId}`;
    if (identities.has(identity)) return assemblyFailure(binding);
    identities.add(identity);
    if (disposition === 'check') {
      if (typeof candidate.run !== 'function' || candidate.reasonCode !== undefined) {
        return assemblyFailure(binding);
      }
      const method = candidate.run as (
        context: Readonly<OmkRuntimePreflightContext>,
      ) => void | Promise<void>;
      declarations.push(Object.freeze({
        preflightKind: preflightKind as OmkRuntimePreflightKind,
        checkId,
        preflightDisposition: 'check' as const,
        run(context: Readonly<OmkRuntimePreflightContext>) {
          return Reflect.apply(method, undefined, [context]) as void | Promise<void>;
        },
      }));
      continue;
    }
    if (candidate.run !== undefined || !validIdentifier(candidate.reasonCode)) {
      return assemblyFailure(binding);
    }
    declarations.push(Object.freeze({
      preflightKind: preflightKind as OmkRuntimePreflightKind,
      checkId,
      preflightDisposition: 'not-required' as const,
      reasonCode: candidate.reasonCode,
    }));
  }
  declarations.sort((left, right) => (
    (PREFLIGHT_KIND_RANK.get(left.preflightKind) ?? Number.MAX_SAFE_INTEGER)
      - (PREFLIGHT_KIND_RANK.get(right.preflightKind) ?? Number.MAX_SAFE_INTEGER)
    || compareStrings(left.checkId, right.checkId)
  ));
  return Object.freeze(declarations);
}

function requireDeclaration(
  entry: RuntimeEntry,
  preflightKind: OmkRuntimePreflightKind,
  requireCheck: boolean,
): void {
  const satisfied = entry.preflightDeclarations.some((candidate) => (
    candidate.preflightKind === preflightKind
    && (!requireCheck || candidate.preflightDisposition === 'check')
  ));
  if (satisfied) {
    return;
  }
  throw new OmkEvaluationPreflightError({
    code: 'OMK_EVALUATION_PREFLIGHT_DECLARATION_MISSING',
    runtimeKind: entry.runtimeKind,
    bindingId: entry.binding.bindingId,
    referenceId: entry.referenceId,
    preflightKind,
    message: `Active binding "${entry.binding.bindingId}" 缺少必需的 ${preflightKind} preflight declaration。`,
  });
}

function assertCoverage(
  entries: readonly RuntimeEntry[],
): void {
  for (const entry of entries) {
    const binding = entry.binding;
    if (entry.runtimeKind === 'executor') {
      requireDeclaration(entry, 'doctor', true);
      requireDeclaration(entry, 'credential', false);
      requireDeclaration(entry, 'connectivity', false);
    } else if (binding.runtimeKind === 'evaluator' && binding.qualification !== undefined) {
      requireDeclaration(entry, 'credential', false);
      requireDeclaration(entry, 'connectivity', false);
    }
    if (entry.resourceLeaseRequirements.length > 0) {
      requireDeclaration(entry, 'filesystem', true);
    }
    if (entry.resourceLeaseRequirements.some((requirement) => (
      requirement.resourceRole === 'mcp-config'
    ))) requireDeclaration(entry, 'mcp-readiness', true);
    if (entry.resourceLeaseRequirements.some((requirement) => (
      requirement.resourceRole === 'mock-rule'
        || requirement.resourceRole === 'mock-payload'
    ))) requireDeclaration(entry, 'mock-readiness', true);
  }
}

function skipReason(
  preflightKind: OmkRuntimePreflightKind,
  modes: OmkEvaluationPreflightModes,
): string | undefined {
  if (preflightKind === 'doctor' && modes.doctor === 'skip') {
    return 'compiled-orchestration-doctor-skip';
  }
  if (preflightKind === 'connectivity' && modes.connectivity === 'skip') {
    return 'compiled-orchestration-connectivity-skip';
  }
  return undefined;
}

function contextFor(
  entry: RuntimeEntry,
  signal: AbortSignal | undefined,
): Readonly<OmkRuntimePreflightContext> {
  return Object.freeze({
    runtimeKind: entry.runtimeKind,
    bindingId: entry.binding.bindingId,
    referenceId: entry.referenceId,
    implementationId: entry.binding.implementationId,
    ...(signal === undefined ? {} : { signal }),
  });
}

function recordFor(
  entry: RuntimeEntry,
  candidate: OmkRuntimePreflightDeclaration,
  preflightStatus: OmkEvaluationPreflightRecord['preflightStatus'],
  reasonCode?: string,
): OmkEvaluationPreflightRecord {
  return Object.freeze({
    runtimeKind: entry.runtimeKind,
    bindingId: entry.binding.bindingId,
    referenceId: entry.referenceId,
    implementationId: entry.binding.implementationId,
    preflightKind: candidate.preflightKind,
    checkId: candidate.checkId,
    preflightStatus,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
}

function cancelled(
  entry: RuntimeEntry | undefined,
  candidate: OmkRuntimePreflightDeclaration | undefined,
): never {
  throw new OmkEvaluationPreflightError({
    code: 'OMK_EVALUATION_PREFLIGHT_CANCELLED',
    ...(entry === undefined ? {} : {
      runtimeKind: entry.runtimeKind,
      bindingId: entry.binding.bindingId,
      referenceId: entry.referenceId,
    }),
    ...(candidate === undefined ? {} : {
      preflightKind: candidate.preflightKind,
      checkId: candidate.checkId,
    }),
    message: 'Evaluation Runtime preflight 已取消。',
  });
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Runs only declarations captured from active binding entries; Core Plan is never an input. */
export async function runOmkEvaluationPreflight(input: Readonly<{
  entries: readonly RuntimeEntry[];
  modes: OmkEvaluationPreflightModes;
  options?: OmkEvaluationPreflightOptions;
}>): Promise<OmkEvaluationPreflightResult> {
  const orderedEntries = [...input.entries].sort((left, right) => (
    compareStrings(left.binding.bindingId, right.binding.bindingId)
  ));
  assertCoverage(orderedEntries);
  if (signalAborted(input.options?.signal)) cancelled(undefined, undefined);
  const records: OmkEvaluationPreflightRecord[] = [];
  for (const entry of orderedEntries) {
    const context = contextFor(entry, input.options?.signal);
    for (const candidate of entry.preflightDeclarations) {
      if (candidate.preflightDisposition === 'not-required') {
        records.push(recordFor(entry, candidate, 'not-required', candidate.reasonCode));
        continue;
      }
      const reason = skipReason(candidate.preflightKind, input.modes);
      if (reason !== undefined) {
        records.push(recordFor(entry, candidate, 'skipped', reason));
        continue;
      }
      if (signalAborted(input.options?.signal)) cancelled(entry, candidate);
      let result: void;
      try {
        result = await candidate.run(context);
      } catch (cause) {
        if (signalAborted(input.options?.signal)) cancelled(entry, candidate);
        throw new OmkEvaluationPreflightError({
          code: 'OMK_EVALUATION_PREFLIGHT_CHECK_FAILED',
          runtimeKind: entry.runtimeKind,
          bindingId: entry.binding.bindingId,
          referenceId: entry.referenceId,
          preflightKind: candidate.preflightKind,
          checkId: candidate.checkId,
          message: `Active binding "${entry.binding.bindingId}" 的 ${candidate.preflightKind} preflight 失败。${cause instanceof OmkUserFacingPreflightFailure ? `\n${cause.message}` : ''}`,
        });
      }
      if (signalAborted(input.options?.signal)) cancelled(entry, candidate);
      if (result !== undefined) {
        throw new OmkEvaluationPreflightError({
          code: 'OMK_EVALUATION_PREFLIGHT_CHECK_RESULT_INVALID',
          runtimeKind: entry.runtimeKind,
          bindingId: entry.binding.bindingId,
          referenceId: entry.referenceId,
          preflightKind: candidate.preflightKind,
          checkId: candidate.checkId,
          message: 'Runtime preflight check 必须返回 void。',
        });
      }
      records.push(recordFor(entry, candidate, 'passed'));
    }
  }
  return Object.freeze({ records: Object.freeze(records) });
}

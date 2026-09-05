import {
  ExecutionResourceDescriptorSchema,
  IdentifierSchema,
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  type ExecutionResourceDescriptor,
  type JsonValue,
  type TargetExecutionControls,
} from '../eval-core/contracts/index.js';

export type WorkspaceDescriptor = Readonly<ExecutionResourceDescriptor>;

export interface WorkspaceOpenRequest {
  readonly descriptor: WorkspaceDescriptor;
  readonly runId: string;
  readonly trialId: string;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
}

export interface WorkspaceLease {
  /** Absolute, non-root, trial-private directory. OMK never adds this locator to artifacts. */
  readonly root: string;
  /** Release the lease and every temporary resource it owns. Runtime closes each accepted lease once. */
  close(): void | Promise<void>;
}

export interface WorkspaceProvider {
  readonly providerId: string;
  readonly version: string;
  /** Measurement-relevant provider behavior only; locators and credentials stay in the closure. */
  readonly fingerprintFacets?: JsonValue;
  /** Verify the descriptor and materialize a fresh overlay using bounded local resource work. */
  open(request: Readonly<WorkspaceOpenRequest>): Promise<WorkspaceLease>;
}

export interface WorkspaceAccess {
  readonly descriptor: WorkspaceDescriptor;
  readonly root: string;
}

export interface WorkspacePlan {
  readonly default?: WorkspaceDescriptor;
  /** `null` explicitly disables the default workspace for one sample. */
  readonly bySampleId?: Readonly<Record<string, WorkspaceDescriptor | null>>;
}

export type WorkspaceInput = WorkspaceDescriptor | WorkspacePlan;

export interface CapturedWorkspaceProvider {
  readonly providerId: string;
  readonly version: string;
  readonly fingerprintFacets?: JsonValue;
  open(request: Readonly<WorkspaceOpenRequest>): Promise<WorkspaceLease>;
}

export interface CapturedWorkspacePlan {
  readonly default?: WorkspaceDescriptor;
  readonly bySampleId: Readonly<Record<string, WorkspaceDescriptor | null>>;
}

function captureDescriptor(value: unknown): WorkspaceDescriptor {
  return deepFreezeCanonicalJson(ExecutionResourceDescriptorSchema.parse(structuredClone(value)));
}

export function captureWorkspaceProvider(value: unknown): CapturedWorkspaceProvider | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Workspace provider must be an object.');
  }
  const provider = value as Readonly<WorkspaceProvider>;
  const providerId = IdentifierSchema.safeParse(provider.providerId);
  if (!providerId.success || typeof provider.version !== 'string' || provider.version.length === 0
      || typeof provider.open !== 'function') {
    throw new TypeError('Workspace provider declaration is invalid.');
  }
  const fingerprintFacets = provider.fingerprintFacets === undefined
    ? undefined
    : deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(provider.fingerprintFacets)));
  const open = provider.open;
  const capturedProvider: CapturedWorkspaceProvider = {
    providerId: providerId.data,
    version: provider.version,
    ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
    open: (request: Readonly<WorkspaceOpenRequest>) => (
      Reflect.apply(open, capturedProvider, [request]) as Promise<WorkspaceLease>
    ),
  };
  return Object.freeze(capturedProvider);
}

function sameDescriptor(
  left: WorkspaceDescriptor | undefined,
  right: WorkspaceDescriptor,
): boolean {
  return left !== undefined && canonicalizeJson(left) === canonicalizeJson(right);
}

export function captureWorkspacePlan(
  value: unknown,
  sampleIds: ReadonlySet<string>,
): CapturedWorkspacePlan | undefined {
  if (value === undefined) return undefined;
  const direct = ExecutionResourceDescriptorSchema.safeParse(value);
  if (direct.success) {
    return Object.freeze({
      default: captureDescriptor(direct.data),
      bySampleId: Object.freeze({}),
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Workspace plan must be a descriptor or object.');
  }
  const plan = value as Readonly<WorkspacePlan>;
  if (Object.keys(plan).some((key) => key !== 'default' && key !== 'bySampleId')) {
    throw new TypeError('Workspace plan contains unsupported fields.');
  }
  const defaultWorkspace = plan.default === undefined
    ? undefined
    : captureDescriptor(plan.default);
  if (plan.bySampleId !== undefined
      && (plan.bySampleId === null || typeof plan.bySampleId !== 'object'
        || Array.isArray(plan.bySampleId))) {
    throw new TypeError('Workspace sample overrides must be an object.');
  }
  const sampleOverrides: Array<readonly [string, WorkspaceDescriptor | null]> = [];
  for (const [sampleId, workspace] of Object.entries(plan.bySampleId ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (!sampleIds.has(sampleId)) {
      throw new TypeError('Workspace plan references an unknown sample.');
    }
    if (workspace === null) {
      if (defaultWorkspace !== undefined) sampleOverrides.push([sampleId, null]);
      continue;
    }
    const descriptor = captureDescriptor(workspace);
    if (!sameDescriptor(defaultWorkspace, descriptor)) {
      sampleOverrides.push([sampleId, descriptor]);
    }
  }
  const bySampleId = Object.fromEntries(sampleOverrides) as Record<
    string,
    WorkspaceDescriptor | null
  >;
  const hasEffectiveWorkspace = [...sampleIds].some((sampleId) => (
    Object.prototype.hasOwnProperty.call(bySampleId, sampleId)
      ? bySampleId[sampleId] !== null
      : defaultWorkspace !== undefined
  ));
  if (!hasEffectiveWorkspace) {
    throw new TypeError('Workspace plan must select a workspace for at least one sample.');
  }
  return Object.freeze({
    ...(defaultWorkspace === undefined ? {} : { default: defaultWorkspace }),
    bySampleId: deepFreezeCanonicalJson(bySampleId),
  });
}

function workspaceControl(descriptor: WorkspaceDescriptor | null | undefined) {
  return descriptor === null || descriptor === undefined
    ? { workspaceMode: 'not-required' as const }
    : { workspaceMode: 'copy-on-write-overlay' as const, descriptor };
}

export function workspaceExecutionControls(
  plan: CapturedWorkspacePlan | undefined,
): Readonly<Pick<TargetExecutionControls, 'defaults' | 'sampleOverrides'>> {
  return deepFreezeCanonicalJson({
    defaults: {
      workspace: workspaceControl(plan?.default),
      tools: { toolPolicyKind: 'runtime-default' },
    },
    sampleOverrides: Object.entries(plan?.bySampleId ?? {}).map(([sampleId, descriptor]) => ({
      sampleId,
      workspace: workspaceControl(descriptor),
    })),
  });
}

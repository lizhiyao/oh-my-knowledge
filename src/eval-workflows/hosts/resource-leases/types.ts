import type {
  ResolvedHostResources,
  ResolvedResourceDescriptor,
  RuntimeResourceLeaseRequirement,
} from '../../input-compilation/index.js';

export { OMK_TREE_DIGEST_ALGORITHM } from '../../../knowledge-artifacts/sources/content-hash.js';

export type OmkBindingResourceLeaseRequest =
  | {
      readonly consumerKind: 'executor';
      readonly bindingId: string;
      readonly requirements: readonly RuntimeResourceLeaseRequirement[];
    }
  | {
      readonly consumerKind: 'evaluator';
      readonly bindingId: string;
      readonly requirements: readonly RuntimeResourceLeaseRequirement[];
    };

export interface OmkAnalysisOnlyResourceLeaseRequest {
  readonly consumerKind: 'analysis-host';
  readonly resourceRole: 'gold-dataset';
  readonly resourceId: string;
}

export interface OmkPinnedGitVerificationRequest {
  readonly signal?: AbortSignal;
  readonly resourceId: string;
  readonly locator: string;
  readonly expectedCommitId: string;
}

export interface OmkPinnedGitVerifier {
  verifyPinnedCommit(
    request: Readonly<OmkPinnedGitVerificationRequest>,
  ): Promise<{
    readonly actualCommitId: string;
    readonly contentMatchesCommit: true;
  }>;
}

export interface OmkResourceLeaseLimits {
  readonly maxResourceBytes: number;
  readonly maxTreeEntries: number;
  readonly maxRunMaterializedBytes: number;
  readonly maxRunMaterializedEntries: number;
}

interface OmkLeasedHostResourceBase {
  readonly resourceId: string;
  readonly resourceKind:
    | 'artifact'
    | 'workspace'
    | 'mcp-config'
    | 'mock-plan'
    | 'mock-rule'
    | 'mock-payload'
    | 'gold-dataset'
    | 'runtime-implementation'
    | 'content';
  readonly descriptor: ResolvedResourceDescriptor;
  readonly snapshotKind: 'file' | 'directory';
}

export type OmkLeasedHostResource =
  | (OmkLeasedHostResourceBase & {
      readonly leaseMode: 'immutable-snapshot';
      readonly snapshotPath: string;
    })
  | (OmkLeasedHostResourceBase & {
      readonly resourceKind: 'workspace';
      readonly snapshotKind: 'directory';
      readonly leaseMode: 'copy-on-write-overlay';
      readonly baseSnapshotPath: string;
    });

export interface OmkBindingResourceLease {
  readonly bindingId: string;
  readonly consumerKind: 'executor' | 'evaluator';
  readonly resourcesByResourceId: ReadonlyMap<string, OmkLeasedHostResource>;
}

/** Binding-scoped view captured by one Runtime factory. */
export interface OmkBindingResourceLeaseAccess {
  forRun(runId: string): OmkBindingResourceLease;
}

export interface OmkRunResourceLeases {
  readonly runId: string;
  readonly bindingsByBindingId: ReadonlyMap<string, OmkBindingResourceLease>;
  /** Kept outside every Executor／Evaluator projection by construction. */
  readonly analysisOnlyResourcesByResourceId: ReadonlyMap<string, OmkLeasedHostResource>;
  /** Idempotent API with exactly one underlying cleanup attempt. */
  dispose(): Promise<void>;
}

/** Host-only lifecycle controller; Runtime factories receive only the scoped access view. */
export interface OmkRunResourceLeaseRegistry {
  register(leases: OmkRunResourceLeases): void;
  unregister(runId: string): void;
}

export type OmkResourceLeaseAccessErrorCode =
  | 'OMK_RESOURCE_LEASE_RUN_ACTIVE'
  | 'OMK_RESOURCE_LEASE_RUN_INACTIVE'
  | 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH'
  | 'OMK_RESOURCE_LEASE_ISOLATION_MISMATCH';

export class OmkResourceLeaseAccessError extends Error {
  readonly code: OmkResourceLeaseAccessErrorCode;
  readonly runId?: string;
  readonly bindingId?: string;

  constructor(input: {
    code: OmkResourceLeaseAccessErrorCode;
    message: string;
    runId?: string;
    bindingId?: string;
  }) {
    super(input.message);
    this.name = 'OmkResourceLeaseAccessError';
    this.code = input.code;
    this.runId = input.runId;
    this.bindingId = input.bindingId;
  }
}

export interface MaterializeNodeRunResourceLeasesInput {
  readonly signal?: AbortSignal;
  readonly runId: string;
  readonly hostResources: ResolvedHostResources;
  readonly bindings: readonly OmkBindingResourceLeaseRequest[];
  readonly analysisOnly?: readonly OmkAnalysisOnlyResourceLeaseRequest[];
  /** Parent directory under which a unique run-scoped directory is created. */
  readonly leaseRoot: string;
  readonly limits?: Partial<OmkResourceLeaseLimits>;
  readonly pinnedGitVerifier?: OmkPinnedGitVerifier;
}

export type OmkResourceLeaseErrorCode =
  | 'OMK_RESOURCE_LEASE_INPUT_INVALID'
  | 'OMK_RESOURCE_LEASE_DUPLICATE'
  | 'OMK_RESOURCE_LEASE_RESOURCE_MISSING'
  | 'OMK_RESOURCE_LEASE_ROLE_MISMATCH'
  | 'OMK_RESOURCE_LEASE_CLASSIFICATION_DENIED'
  | 'OMK_RESOURCE_LEASE_VERIFICATION_INVALID'
  | 'OMK_RESOURCE_LEASE_SOURCE_INVALID'
  | 'OMK_RESOURCE_LEASE_DIGEST_MISMATCH'
  | 'OMK_RESOURCE_LEASE_SIZE_MISMATCH'
  | 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED'
  | 'OMK_RESOURCE_LEASE_GIT_IDENTITY_MISMATCH'
  | 'OMK_RESOURCE_LEASE_MATERIALIZATION_FAILED'
  | 'OMK_RESOURCE_LEASE_DISPOSE_FAILED';

export class OmkResourceLeaseError extends Error {
  readonly code: OmkResourceLeaseErrorCode;
  readonly resourceId?: string;
  readonly bindingId?: string;

  constructor(input: {
    code: OmkResourceLeaseErrorCode;
    message: string;
    resourceId?: string;
    bindingId?: string;
  }) {
    super(input.message);
    this.name = 'OmkResourceLeaseError';
    this.code = input.code;
    this.resourceId = input.resourceId;
    this.bindingId = input.bindingId;
  }
}

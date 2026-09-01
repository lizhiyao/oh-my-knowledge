import { execFile as execFileCallback } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
  type ResolvedHostResource,
  type RuntimeResourceLeaseRequirement,
} from '../../input-compilation/index.js';
import {
  OMK_TREE_DIGEST_ALGORITHM,
  OmkResourceLeaseError,
  type MaterializeNodeRunResourceLeasesInput,
  type OmkAnalysisOnlyResourceLeaseRequest,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseRequest,
  type OmkLeasedHostResource,
  type OmkPinnedGitVerifier,
  type OmkResourceLeaseLimits,
  type OmkRunResourceLeases,
} from './types.js';
import type { OmkEvaluationRuntimeBindingEntry } from '../types.js';

const execFile = promisify(execFileCallback);
const DEFAULT_LIMITS: OmkResourceLeaseLimits = Object.freeze({
  maxResourceBytes: 2 * 1024 * 1024 * 1024,
  maxTreeEntries: 100_000,
  maxRunMaterializedBytes: 8 * 1024 * 1024 * 1024,
  maxRunMaterializedEntries: 400_000,
});
const BUFFER_SIZE = 64 * 1024;

interface MaterializedBase {
  readonly resource: ResolvedHostResource;
  readonly snapshotKind: 'file' | 'directory';
  readonly path: string;
  readonly entryCount: number;
}

function fail(input: ConstructorParameters<typeof OmkResourceLeaseError>[0]): never {
  throw new OmkResourceLeaseError(input);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readonlyMapSnapshot<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const snapshot = new Map(source);
  const view: ReadonlyMap<Key, Value> = Object.freeze({
    get size() { return snapshot.size; },
    get(key: Key) { return snapshot.get(key); },
    has(key: Key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
    forEach(
      callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
      thisArg?: unknown,
    ) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });
  return view;
}

function sha256Digest(hash: Hash): `sha256:${string}` {
  return `sha256:${hash.digest('hex')}`;
}

function updateField(hash: Hash, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  hash.update(String(bytes.length));
  hash.update(Buffer.from([0]));
  hash.update(bytes);
  hash.update(Buffer.from([0]));
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await handle.write(buffer, written, length - written, position + written);
    if (result.bytesWritten <= 0) throw new Error('snapshot write made no progress');
    written += result.bytesWritten;
  }
}

async function copyRegularFile(
  resourceId: string,
  source: string,
  destination: string,
  state: { bytes: number; entries: number },
  limits: OmkResourceLeaseLimits,
): Promise<void> {
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new Error('source is not a regular file');
    if (state.entries + 1 > limits.maxTreeEntries
        || state.bytes + sourceStat.size > limits.maxResourceBytes) fail({
      code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
      resourceId,
      message: '资源超过 lease 物化上限。',
    });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    destinationHandle = await open(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (state.bytes + bytesRead > limits.maxResourceBytes) fail({
        code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
        resourceId,
        message: '资源超过 lease 物化上限。',
      });
      await writeAll(destinationHandle, buffer, bytesRead, position);
      position += bytesRead;
      state.bytes += bytesRead;
    }
    state.entries += 1;
    await destinationHandle.sync();
    await destinationHandle.chmod((sourceStat.mode & 0o111) === 0 ? 0o400 : 0o500);
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

async function copyDirectorySnapshot(
  resourceId: string,
  sourceRoot: string,
  destinationRoot: string,
  limits: OmkResourceLeaseLimits,
  excludeGitMetadata: boolean,
): Promise<{ bytes: number; entries: number }> {
  const state = { bytes: 0, entries: 0 };
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  const walk = async (source: string, destination: string, segments: string[]): Promise<void> => {
    const directory = await opendir(source);
    for await (const entry of directory) {
      const childSegments = [...segments, entry.name];
      if (excludeGitMetadata && childSegments.length === 1 && entry.name === '.git') continue;
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const stat = await lstat(sourcePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail({
        code: 'OMK_RESOURCE_LEASE_SOURCE_INVALID',
        resourceId,
        message: '资源树包含 symlink 或特殊文件。',
      });
      if (stat.isDirectory()) {
        state.entries += 1;
        if (state.entries > limits.maxTreeEntries) fail({
          code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
          resourceId,
          message: '资源树条目数超过 lease 物化上限。',
        });
        await mkdir(destinationPath, { mode: 0o700 });
        await walk(sourcePath, destinationPath, childSegments);
        await chmod(destinationPath, 0o500);
      } else {
        await copyRegularFile(resourceId, sourcePath, destinationPath, state, limits);
      }
    }
  };
  await walk(sourceRoot, destinationRoot, []);
  await chmod(destinationRoot, 0o500);
  return state;
}

async function hashFile(path: string, hash: Hash): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('snapshot file is not regular');
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return position;
  } finally {
    await handle.close();
  }
}

async function digestFile(path: string): Promise<{ digest: `sha256:${string}`; size: number }> {
  const hash = createHash('sha256');
  const size = await hashFile(path, hash);
  return { digest: sha256Digest(hash), size };
}

async function digestTree(
  path: string,
  excludeGitMetadata = false,
): Promise<{ digest: `sha256:${string}`; size: number }> {
  const hash = createHash('sha256');
  updateField(hash, OMK_TREE_DIGEST_ALGORITHM);
  let size = 0;
  const walk = async (directory: string, segments: string[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const childSegments = [...segments, entry.name];
      if (excludeGitMetadata && childSegments.length === 1 && entry.name === '.git') continue;
      const relativePath = childSegments.join('/');
      const childPath = join(directory, entry.name);
      const stat = await lstat(childPath);
      if (stat.isDirectory()) {
        updateField(hash, 'directory');
        updateField(hash, relativePath);
        await walk(childPath, childSegments);
      } else if (stat.isFile()) {
        updateField(hash, 'file');
        updateField(hash, relativePath);
        updateField(hash, (stat.mode & 0o111) === 0 ? 'non-executable' : 'executable');
        updateField(hash, String(stat.size));
        size += await hashFile(childPath, hash);
        updateField(hash, 'end-file');
      } else {
        throw new Error('snapshot tree contains an unsupported entry');
      }
    }
  };
  await walk(path, []);
  return { digest: sha256Digest(hash), size };
}

/** Resolve-stage helper. Lease acquisition always re-hashes its private snapshot. */
export async function digestNodeFileResource(
  path: string,
): Promise<{ readonly digest: `sha256:${string}`; readonly size: number }> {
  return digestFile(path);
}

/** Resolve-stage helper using the exact tree framing later revalidated on the snapshot. */
export async function digestNodeTreeResource(
  path: string,
): Promise<{ readonly digest: `sha256:${string}`; readonly size: number }> {
  return digestTree(path);
}

/** Resolve-stage digest for a pinned Git worktree; repository metadata is not Runtime input. */
export async function digestNodePinnedGitTreeResource(
  path: string,
): Promise<{ readonly digest: `sha256:${string}`; readonly size: number }> {
  return digestTree(path, true);
}

async function makeTreeWritable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeTreeWritable(join(path, entry));
  } else if (stat.isFile()) {
    await chmod(path, (stat.mode & 0o111) === 0 ? 0o600 : 0o700);
  }
}

async function cleanupRoot(path: string): Promise<void> {
  try {
    await makeTreeWritable(path);
  } catch {
    // A partially materialized root may already be absent or incomplete.
  }
  await rm(path, { recursive: true, force: true });
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

class NodePinnedGitVerifier implements OmkPinnedGitVerifier {
  async verifyPinnedCommit(input: {
    readonly resourceId: string;
    readonly locator: string;
    readonly expectedCommitId: string;
  }): Promise<{ readonly actualCommitId: string; readonly contentMatchesCommit: true }> {
    const options = { encoding: 'utf8' as const, maxBuffer: 4 * 1024 * 1024 };
    const [commit, status, index] = await Promise.all([
      execFile('git', ['-C', input.locator, 'rev-parse', '--verify', 'HEAD^{commit}'], options),
      execFile('git', [
        '-C', input.locator,
        'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching',
      ], options),
      execFile('git', ['-C', input.locator, 'ls-files', '--stage'], options),
    ]);
    if (status.stdout.trim() !== '' || /(?:^|\n)160000 /.test(index.stdout)) {
      throw new Error('pinned Git worktree is not an exact regular-file checkout');
    }
    return {
      actualCommitId: commit.stdout.trim().toLowerCase(),
      contentMatchesCommit: true,
    };
  }
}

function roleResourceKind(role: RuntimeResourceLeaseRequirement['resourceRole']) {
  return role === 'artifact'
    ? 'artifact' as const
    : role === 'workspace'
      ? 'workspace' as const
      : role === 'mcp-config'
        ? 'mcp-config' as const
        : role === 'mock-payload'
          ? 'mock-payload' as const
          : role === 'runtime-implementation'
            ? 'runtime-implementation' as const
            : 'content' as const;
}

function validateLimits(input: Partial<OmkResourceLeaseLimits> | undefined): OmkResourceLeaseLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.maxResourceBytes) || limits.maxResourceBytes < 1
      || !Number.isSafeInteger(limits.maxTreeEntries) || limits.maxTreeEntries < 1
      || !Number.isSafeInteger(limits.maxRunMaterializedBytes)
      || limits.maxRunMaterializedBytes < 1
      || !Number.isSafeInteger(limits.maxRunMaterializedEntries)
      || limits.maxRunMaterializedEntries < 1) fail({
    code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
    message: 'Resource lease limit 必须是正安全整数。',
  });
  return Object.freeze(limits);
}

function snapshotBindingRequests(
  bindings: readonly OmkBindingResourceLeaseRequest[],
): readonly OmkBindingResourceLeaseRequest[] {
  if (!Array.isArray(bindings)) fail({
    code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
    message: 'Resource lease binding request 必须是数组。',
  });
  const bindingIds = new Set<string>();
  const snapshots = bindings.map((binding) => {
    if (!['executor', 'evaluator'].includes(binding.consumerKind)
        || typeof binding.bindingId !== 'string' || binding.bindingId === ''
        || bindingIds.has(binding.bindingId) || !Array.isArray(binding.requirements)) fail({
      code: 'OMK_RESOURCE_LEASE_DUPLICATE',
      bindingId: binding.bindingId,
      message: 'Resource lease request 包含重复或空 bindingId。',
    });
    bindingIds.add(binding.bindingId);
    const keys = new Set<string>();
    const requirements = binding.requirements.map((requirement: RuntimeResourceLeaseRequirement) => {
      const validRole = [
        'artifact',
        'workspace',
        'mcp-config',
        'mock-payload',
        'runtime-implementation',
        'content',
      ]
        .includes(requirement.resourceRole);
      const roleAllowed = binding.consumerKind === 'executor'
        ? requirement.resourceRole !== 'content' && validRole
        : requirement.resourceRole === 'content';
      const expectedMode = requirement.resourceRole === 'workspace'
        ? 'copy-on-write-overlay'
        : 'immutable-snapshot';
      const key = `${requirement.resourceRole}\u0000${requirement.resourceId}`;
      if (!roleAllowed || requirement.leaseMode !== expectedMode
          || requirement.resourceId === '' || keys.has(key)) fail({
        code: 'OMK_RESOURCE_LEASE_ROLE_MISMATCH',
        resourceId: requirement.resourceId,
        bindingId: binding.bindingId,
        message: 'Consumer、resource role 与 lease mode 不匹配。',
      });
      keys.add(key);
      return Object.freeze({
        resourceId: requirement.resourceId,
        resourceRole: requirement.resourceRole,
        leaseMode: requirement.leaseMode,
      });
    });
    return Object.freeze({
      consumerKind: binding.consumerKind,
      bindingId: binding.bindingId,
      requirements: Object.freeze(requirements),
    });
  });
  return Object.freeze(snapshots);
}

function validateInventory(input: MaterializeNodeRunResourceLeasesInput): Map<string, ResolvedHostResource> {
  if (typeof input.runId !== 'string' || input.runId === ''
      || typeof input.leaseRoot !== 'string' || !isAbsolute(input.leaseRoot)
      || input.hostResources === undefined
      || input.hostResources.schemaVersion !== RESOLVED_HOST_RESOURCES_SCHEMA_VERSION
      || !Array.isArray(input.hostResources.resources)) fail({
    code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
    message: 'Run identity、lease root 或 HostResource schema version 不合法。',
  });
  const resources = new Map<string, ResolvedHostResource>();
  for (const resource of input.hostResources.resources) {
    const { descriptor, verification } = resource;
    if (resources.has(descriptor.resourceId)) fail({
      code: 'OMK_RESOURCE_LEASE_DUPLICATE',
      resourceId: descriptor.resourceId,
      message: 'HostResource inventory 包含重复 resourceId。',
    });
    if (!['artifact', 'workspace', 'mcp-config', 'mock-payload', 'gold-dataset', 'runtime-implementation', 'content']
      .includes(resource.resourceKind)
        || !['public', 'sensitive', 'secret', 'gold'].includes(descriptor.classification)
        || !['content-digest', 'tree-digest', 'pinned-git']
          .includes(verification.verificationKind)
        || descriptor.resourceId === '' || descriptor.resourceId.length > 256
        || !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)
        || descriptor.mediaType === '' || !Number.isSafeInteger(descriptor.size)
        || descriptor.size < 0 || !isAbsolute(resource.locator)) fail({
      code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
      resourceId: descriptor.resourceId,
      message: 'HostResource descriptor 或 locator 不合法。',
    });
    if (verification.verifiedDigest !== descriptor.digest
        || (verification.verificationKind === 'pinned-git'
          && !/^[0-9a-f]{40,64}$/.test(verification.commitId))) fail({
      code: 'OMK_RESOURCE_LEASE_VERIFICATION_INVALID',
      resourceId: descriptor.resourceId,
      message: 'HostResource verification 与 descriptor 不一致。',
    });
    if ((resource.resourceKind === 'gold-dataset') !== (descriptor.classification === 'gold')) fail({
      code: 'OMK_RESOURCE_LEASE_CLASSIFICATION_DENIED',
      resourceId: descriptor.resourceId,
      message: 'Gold classification 只能用于 gold-dataset，且 gold-dataset 必须标记为 gold。',
    });
    const fileOnly = ['mcp-config', 'mock-payload', 'runtime-implementation', 'content']
      .includes(resource.resourceKind);
    const gitAllowed = resource.resourceKind === 'artifact' || resource.resourceKind === 'workspace';
    if ((fileOnly && verification.verificationKind !== 'content-digest')
        || (resource.resourceKind === 'workspace'
          && verification.verificationKind === 'content-digest')
        || (verification.verificationKind === 'pinned-git' && !gitAllowed)) fail({
      code: 'OMK_RESOURCE_LEASE_VERIFICATION_INVALID',
      resourceId: descriptor.resourceId,
      message: 'HostResource kind 与 verification kind 不匹配。',
    });
    const descriptorSnapshot = Object.freeze({
      resourceId: descriptor.resourceId,
      digest: descriptor.digest,
      size: descriptor.size,
      mediaType: descriptor.mediaType,
      classification: descriptor.classification,
    });
    const verificationSnapshot = verification.verificationKind === 'pinned-git'
      ? Object.freeze({
          verificationKind: verification.verificationKind,
          verifiedDigest: verification.verifiedDigest,
          commitId: verification.commitId,
        })
      : Object.freeze({
          verificationKind: verification.verificationKind,
          verifiedDigest: verification.verifiedDigest,
        });
    resources.set(descriptor.resourceId, Object.freeze({
      resourceKind: resource.resourceKind,
      descriptor: descriptorSnapshot,
      locator: resource.locator,
      verification: verificationSnapshot,
    }));
  }
  return resources;
}

/** Projects only active Executor／Evaluator requirements from immutable binding entries. */
export function resourceLeaseRequestsFromBindingEntries(
  entries: readonly OmkEvaluationRuntimeBindingEntry[],
): readonly OmkBindingResourceLeaseRequest[] {
  return Object.freeze(entries.flatMap((entry) => {
    if (entry.runtimeKind !== 'executor' && entry.runtimeKind !== 'evaluator') return [];
    return [Object.freeze({
      consumerKind: entry.runtimeKind,
      bindingId: entry.binding.bindingId,
      requirements: entry.resourceLeaseRequirements,
    })];
  }));
}

interface ResourceLeaseRequestsSnapshot {
  readonly bindings: readonly OmkBindingResourceLeaseRequest[];
  readonly analysisOnly: readonly OmkAnalysisOnlyResourceLeaseRequest[];
}

function requiredResourceIds(input: ResourceLeaseRequestsSnapshot): Set<string> {
  return new Set([
    ...input.bindings.flatMap((binding) => (
      binding.requirements.map((requirement) => requirement.resourceId)
    )),
    ...input.analysisOnly.map((requirement) => requirement.resourceId),
  ]);
}

function validatePlannedRunBytes(
  requests: ResourceLeaseRequestsSnapshot,
  requested: readonly ResolvedHostResource[],
  resources: ReadonlyMap<string, ResolvedHostResource>,
  limits: OmkResourceLeaseLimits,
): void {
  let bytes = 0;
  const account = (resource: ResolvedHostResource, bindingId?: string): void => {
    if (bytes > limits.maxRunMaterializedBytes - resource.descriptor.size) fail({
      code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
      resourceId: resource.descriptor.resourceId,
      ...(bindingId === undefined ? {} : { bindingId }),
      message: 'Run-scoped resource lease 物化字节超过上限。',
    });
    bytes += resource.descriptor.size;
  };
  for (const resource of requested) account(resource);
  for (const binding of requests.bindings) {
    for (const requirement of binding.requirements) {
      if (requirement.leaseMode !== 'copy-on-write-overlay') continue;
      account(resources.get(requirement.resourceId) as ResolvedHostResource, binding.bindingId);
    }
  }
}

function snapshotAnalysisOnlyRequests(
  requests: MaterializeNodeRunResourceLeasesInput['analysisOnly'],
): readonly OmkAnalysisOnlyResourceLeaseRequest[] {
  if (requests !== undefined && !Array.isArray(requests)) fail({
    code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
    message: 'Analysis-only resource request 必须是数组。',
  });
  return Object.freeze((requests ?? []).map((request) => Object.freeze({
    consumerKind: request.consumerKind,
    resourceRole: request.resourceRole,
    resourceId: request.resourceId,
  })));
}

function validateReferences(
  input: ResourceLeaseRequestsSnapshot,
  resources: ReadonlyMap<string, ResolvedHostResource>,
): void {
  for (const binding of input.bindings) {
    for (const requirement of binding.requirements) {
      const resource = resources.get(requirement.resourceId);
      if (resource === undefined) fail({
        code: 'OMK_RESOURCE_LEASE_RESOURCE_MISSING',
        bindingId: binding.bindingId,
        resourceId: requirement.resourceId,
        message: 'Binding 请求了 inventory 中不存在的资源。',
      });
      if (resource.resourceKind !== roleResourceKind(requirement.resourceRole)) fail({
        code: 'OMK_RESOURCE_LEASE_ROLE_MISMATCH',
        bindingId: binding.bindingId,
        resourceId: requirement.resourceId,
        message: 'Binding resource role 与 HostResource kind 不匹配。',
      });
      if (resource.descriptor.classification === 'gold') fail({
        code: 'OMK_RESOURCE_LEASE_CLASSIFICATION_DENIED',
        bindingId: binding.bindingId,
        resourceId: requirement.resourceId,
        message: 'Executor／Evaluator binding 不得取得 Gold resource。',
      });
    }
  }
  const analysisKeys = new Set<string>();
  for (const requirement of input.analysisOnly) {
    if (requirement.consumerKind !== 'analysis-host'
        || requirement.resourceRole !== 'gold-dataset'
        || requirement.resourceId === '' || analysisKeys.has(requirement.resourceId)) fail({
      code: 'OMK_RESOURCE_LEASE_ROLE_MISMATCH',
      resourceId: requirement.resourceId,
      message: 'Analysis-only resource request 不合法或重复。',
    });
    analysisKeys.add(requirement.resourceId);
    const resource = resources.get(requirement.resourceId);
    if (resource === undefined) fail({
      code: 'OMK_RESOURCE_LEASE_RESOURCE_MISSING',
      resourceId: requirement.resourceId,
      message: 'Analysis-only request 引用了不存在的资源。',
    });
    if (resource.resourceKind !== 'gold-dataset'
        || resource.descriptor.classification !== 'gold') fail({
      code: 'OMK_RESOURCE_LEASE_CLASSIFICATION_DENIED',
      resourceId: requirement.resourceId,
      message: 'Analysis-only Gold request 与 inventory classification 不一致。',
    });
  }
}

async function materializeBase(
  resource: ResolvedHostResource,
  destination: string,
  limits: OmkResourceLeaseLimits,
  pinnedGitVerifier: OmkPinnedGitVerifier,
): Promise<MaterializedBase> {
  const sourceStat = await lstat(resource.locator).catch(() => undefined);
  if (sourceStat === undefined || sourceStat.isSymbolicLink()) fail({
    code: 'OMK_RESOURCE_LEASE_SOURCE_INVALID',
    resourceId: resource.descriptor.resourceId,
    message: 'HostResource locator 不存在或指向 symlink。',
  });
  const verificationKind = resource.verification.verificationKind;
  const expectsDirectory = verificationKind !== 'content-digest';
  if ((expectsDirectory && !sourceStat.isDirectory())
      || (!expectsDirectory && !sourceStat.isFile())
      || (resource.resourceKind === 'workspace' && !expectsDirectory)) fail({
    code: 'OMK_RESOURCE_LEASE_SOURCE_INVALID',
    resourceId: resource.descriptor.resourceId,
    message: 'HostResource locator 类型与 verification kind 不一致。',
  });
  if (verificationKind === 'pinned-git') {
    let actualCommitId: string;
    let contentMatchesCommit: boolean;
    try {
      ({ actualCommitId, contentMatchesCommit } = await pinnedGitVerifier.verifyPinnedCommit({
        resourceId: resource.descriptor.resourceId,
        locator: resource.locator,
        expectedCommitId: resource.verification.commitId,
      }));
    } catch {
      fail({
        code: 'OMK_RESOURCE_LEASE_GIT_IDENTITY_MISMATCH',
        resourceId: resource.descriptor.resourceId,
        message: '无法验证 pinned Git commit identity。',
      });
    }
    if (contentMatchesCommit !== true
        || typeof actualCommitId !== 'string' || !/^[0-9a-f]{40,64}$/i.test(actualCommitId)
        || actualCommitId.toLowerCase() !== resource.verification.commitId.toLowerCase()) fail({
      code: 'OMK_RESOURCE_LEASE_GIT_IDENTITY_MISMATCH',
      resourceId: resource.descriptor.resourceId,
      message: '实际 Git commit 与 pinned identity 不一致。',
    });
  }
  let actual: { digest: `sha256:${string}`; size: number };
  let snapshotKind: MaterializedBase['snapshotKind'];
  let entryCount: number;
  if (expectsDirectory) {
    const copied = await copyDirectorySnapshot(
      resource.descriptor.resourceId,
      resource.locator,
      destination,
      limits,
      verificationKind === 'pinned-git',
    );
    actual = await digestTree(destination);
    snapshotKind = 'directory';
    entryCount = copied.entries + 1;
  } else {
    const state = { bytes: 0, entries: 0 };
    await copyRegularFile(
      resource.descriptor.resourceId,
      resource.locator,
      destination,
      state,
      limits,
    );
    actual = await digestFile(destination);
    snapshotKind = 'file';
    entryCount = state.entries;
  }
  if (actual.size !== resource.descriptor.size) fail({
    code: 'OMK_RESOURCE_LEASE_SIZE_MISMATCH',
    resourceId: resource.descriptor.resourceId,
    message: '实际 snapshot size 与 descriptor 不一致。',
  });
  if (actual.digest !== resource.descriptor.digest) fail({
    code: 'OMK_RESOURCE_LEASE_DIGEST_MISMATCH',
    resourceId: resource.descriptor.resourceId,
    message: '实际 snapshot digest 与 descriptor 不一致。',
  });
  return Object.freeze({ resource, snapshotKind, path: destination, entryCount });
}

function immutableLease(base: MaterializedBase): OmkLeasedHostResource {
  return Object.freeze({
    resourceId: base.resource.descriptor.resourceId,
    resourceKind: base.resource.resourceKind,
    descriptor: base.resource.descriptor,
    snapshotKind: base.snapshotKind,
    leaseMode: 'immutable-snapshot',
    snapshotPath: base.path,
  });
}

async function workspaceLease(
  base: MaterializedBase,
  overlayPath: string,
): Promise<OmkLeasedHostResource> {
  if (base.resource.resourceKind !== 'workspace' || base.snapshotKind !== 'directory') fail({
    code: 'OMK_RESOURCE_LEASE_ROLE_MISMATCH',
    resourceId: base.resource.descriptor.resourceId,
    message: '只有 directory workspace 可以创建 COW overlay。',
  });
  await cp(base.path, overlayPath, { recursive: true, errorOnExist: true, force: false });
  await makeTreeWritable(overlayPath);
  return Object.freeze({
    resourceId: base.resource.descriptor.resourceId,
    resourceKind: 'workspace',
    descriptor: base.resource.descriptor,
    snapshotKind: 'directory',
    leaseMode: 'copy-on-write-overlay',
    baseSnapshotPath: base.path,
    overlayPath,
  });
}

async function validateRootSeparation(
  leaseRoot: string,
  resources: readonly ResolvedHostResource[],
): Promise<string> {
  await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(leaseRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail({
    code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
    message: 'leaseRoot 必须是非 symlink directory。',
  });
  const rootPath = await realpath(leaseRoot);
  for (const resource of resources) {
    const sourcePath = await realpath(resource.locator).catch(() => undefined);
    if (sourcePath !== undefined
        && (pathContains(rootPath, sourcePath) || pathContains(sourcePath, rootPath))) fail({
      code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
      resourceId: resource.descriptor.resourceId,
      message: 'leaseRoot 与 resource source 不得互相包含。',
    });
  }
  return rootPath;
}

/**
 * Materializes all active binding resources before any Runtime port opens a Run.
 * Only verified snapshots／overlays are returned; original locators stay private.
 */
export async function materializeNodeRunResourceLeases(
  input: Readonly<MaterializeNodeRunResourceLeasesInput>,
): Promise<OmkRunResourceLeases> {
  const limits = validateLimits(input.limits);
  const resources = validateInventory(input);
  const bindingsSnapshot = snapshotBindingRequests(input.bindings);
  const analysisOnlySnapshot = snapshotAnalysisOnlyRequests(input.analysisOnly);
  const requests = Object.freeze({
    bindings: bindingsSnapshot,
    analysisOnly: analysisOnlySnapshot,
  });
  validateReferences(requests, resources);
  const verifierCandidate = input.pinnedGitVerifier ?? new NodePinnedGitVerifier();
  if (typeof verifierCandidate.verifyPinnedCommit !== 'function') fail({
    code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
    message: 'Pinned Git verifier 不合法。',
  });
  const verifier: OmkPinnedGitVerifier = Object.freeze({
    verifyPinnedCommit: verifierCandidate.verifyPinnedCommit.bind(verifierCandidate),
  });
  const runId = input.runId;
  const leaseRoot = input.leaseRoot;
  const requested = [...requiredResourceIds(requests)].sort(compareStrings).map((resourceId) => (
    resources.get(resourceId) as ResolvedHostResource
  ));
  validatePlannedRunBytes(requests, requested, resources, limits);
  const rootPath = await validateRootSeparation(leaseRoot, requested);
  const runRoot = await mkdtemp(join(rootPath, 'omk-resource-lease-'));
  try {
    const bases = new Map<string, MaterializedBase>();
    let materializedEntries = 0;
    const accountEntries = (
      base: MaterializedBase,
      bindingId?: string,
    ): void => {
      if (materializedEntries > limits.maxRunMaterializedEntries - base.entryCount) fail({
        code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
        resourceId: base.resource.descriptor.resourceId,
        ...(bindingId === undefined ? {} : { bindingId }),
        message: 'Run-scoped resource lease 物化条目数超过上限。',
      });
      materializedEntries += base.entryCount;
    };
    await mkdir(join(runRoot, 'resources'), { mode: 0o700 });
    for (const [index, resource] of requested.entries()) {
      const destination = join(runRoot, 'resources', String(index));
      try {
        const base = await materializeBase(
          resource,
          destination,
          limits,
          verifier,
        );
        accountEntries(base);
        bases.set(resource.descriptor.resourceId, base);
      } catch (cause) {
        if (cause instanceof OmkResourceLeaseError) throw cause;
        fail({
          code: 'OMK_RESOURCE_LEASE_MATERIALIZATION_FAILED',
          resourceId: resource.descriptor.resourceId,
          message: 'HostResource lease 物化失败。',
        });
      }
    }
    const bindings = new Map<string, OmkBindingResourceLease>();
    await mkdir(join(runRoot, 'overlays'), { mode: 0o700 });
    for (const [bindingIndex, request] of bindingsSnapshot.entries()) {
      const leased = new Map<string, OmkLeasedHostResource>();
      for (const [resourceIndex, requirement] of request.requirements.entries()) {
        const base = bases.get(requirement.resourceId) as MaterializedBase;
        let value: OmkLeasedHostResource;
        try {
          if (requirement.leaseMode === 'copy-on-write-overlay') {
            accountEntries(base, request.bindingId);
            value = await workspaceLease(base, join(
              runRoot,
              'overlays',
              `${bindingIndex}-${resourceIndex}`,
            ));
          } else {
            value = immutableLease(base);
          }
        } catch (cause) {
          if (cause instanceof OmkResourceLeaseError) throw cause;
          fail({
            code: 'OMK_RESOURCE_LEASE_MATERIALIZATION_FAILED',
            resourceId: requirement.resourceId,
            bindingId: request.bindingId,
            message: 'Binding resource overlay 物化失败。',
          });
        }
        leased.set(requirement.resourceId, value);
      }
      bindings.set(request.bindingId, Object.freeze({
        bindingId: request.bindingId,
        consumerKind: request.consumerKind,
        resourcesByResourceId: readonlyMapSnapshot(leased),
      }));
    }
    const analysisOnly = new Map<string, OmkLeasedHostResource>();
    for (const requirement of analysisOnlySnapshot) {
      const base = bases.get(requirement.resourceId) as MaterializedBase;
      analysisOnly.set(requirement.resourceId, immutableLease(base));
    }
    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposePromise ??= cleanupRoot(runRoot).catch(() => fail({
        code: 'OMK_RESOURCE_LEASE_DISPOSE_FAILED',
        message: 'Run-scoped resource lease 清理失败。',
      }));
      return disposePromise;
    };
    return Object.freeze({
      runId,
      bindingsByBindingId: readonlyMapSnapshot(bindings),
      analysisOnlyResourcesByResourceId: readonlyMapSnapshot(analysisOnly),
      dispose,
    });
  } catch (cause) {
    try {
      await cleanupRoot(runRoot);
    } catch {
      fail({
        code: 'OMK_RESOURCE_LEASE_DISPOSE_FAILED',
        message: 'Resource lease acquisition 失败后无法清理 run-scoped 资源。',
      });
    }
    if (cause instanceof OmkResourceLeaseError) throw cause;
    fail({
      code: 'OMK_RESOURCE_LEASE_MATERIALIZATION_FAILED',
      message: 'HostResource lease 物化失败。',
    });
  }
}

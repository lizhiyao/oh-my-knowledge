import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
  type ResolvedHostResource,
  type ResolvedHostResources,
  type ResourceClassification,
  type RuntimeResourceLeaseRequirement,
} from '../../../src/eval-workflows/input-compilation/index.js';
import {
  OMK_TREE_DIGEST_ALGORITHM,
} from '../../../src/eval-hosts/resource-leases/index.js';
import {
  digestNodeFileResource,
  digestNodePinnedGitTreeResource,
  digestNodeTreeResource,
  materializeNodeRunResourceLeases,
} from '../../../src/eval-hosts/resource-leases/node.js';
import {
  type OmkPinnedGitVerifier,
} from '../../../src/eval-hosts/resource-leases/types.js';

let sourceRoot: string;
let leaseRoot: string;

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), 'omk-resource-source-'));
  leaseRoot = mkdtempSync(join(tmpdir(), 'omk-resource-leases-'));
});

afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(leaseRoot, { recursive: true, force: true });
});

async function fileResource(input: {
  resourceId: string;
  resourceKind: ResolvedHostResource['resourceKind'];
  path: string;
  classification?: ResourceClassification;
  mediaType?: string;
}): Promise<ResolvedHostResource> {
  const actual = await digestNodeFileResource(input.path);
  return {
    resourceKind: input.resourceKind,
    descriptor: {
      resourceId: input.resourceId,
      digest: actual.digest,
      size: actual.size,
      mediaType: input.mediaType ?? 'application/octet-stream',
      classification: input.classification ?? 'public',
    },
    locator: input.path,
    verification: { verificationKind: 'content-digest', verifiedDigest: actual.digest },
  };
}

async function treeResource(input: {
  resourceId: string;
  resourceKind: 'artifact' | 'workspace';
  path: string;
}): Promise<ResolvedHostResource> {
  const actual = await digestNodeTreeResource(input.path);
  return {
    resourceKind: input.resourceKind,
    descriptor: {
      resourceId: input.resourceId,
      digest: actual.digest,
      size: actual.size,
      mediaType: 'application/vnd.omk.tree',
      classification: 'public',
    },
    locator: input.path,
    verification: { verificationKind: 'tree-digest', verifiedDigest: actual.digest },
  };
}

function inventory(resources: readonly ResolvedHostResource[]): ResolvedHostResources {
  return { schemaVersion: RESOLVED_HOST_RESOURCES_SCHEMA_VERSION, resources };
}

function requirement(
  resourceRole: RuntimeResourceLeaseRequirement['resourceRole'],
  resourceId: string,
): RuntimeResourceLeaseRequirement {
  return {
    resourceId,
    resourceRole,
    leaseMode: resourceRole === 'workspace'
      ? 'copy-on-write-overlay'
      : 'immutable-snapshot',
  };
}

async function completeFixture() {
  const artifactPath = join(sourceRoot, 'artifact.md');
  const workspacePath = join(sourceRoot, 'workspace');
  const mcpPath = join(sourceRoot, 'mcp.json');
  const mockPlanPath = join(sourceRoot, 'mock-plan.json');
  const mockRulePath = join(sourceRoot, 'mock-rule.json');
  const mockPath = join(sourceRoot, 'mock.json');
  const contentPath = join(sourceRoot, 'rubric.json');
  const goldPath = join(sourceRoot, 'gold.json');
  writeFileSync(artifactPath, '# Skill\nverified\n');
  mkdirSync(join(workspacePath, 'src'), { recursive: true });
  writeFileSync(join(workspacePath, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(workspacePath, 'run.sh'), '#!/bin/sh\necho ok\n');
  chmodSync(join(workspacePath, 'run.sh'), 0o755);
  writeFileSync(mcpPath, '{"servers":["test"]}');
  writeFileSync(mockPlanPath, '{"schemaVersion":"omk.mock-interception-plan/v1"}');
  writeFileSync(mockRulePath, '{"tool":"search"}');
  writeFileSync(mockPath, '{"answer":"A"}');
  writeFileSync(contentPath, '{"rubric":"correctness"}');
  writeFileSync(goldPath, '{"answer":"gold"}');
  const resources = await Promise.all([
    fileResource({ resourceId: 'artifact', resourceKind: 'artifact', path: artifactPath }),
    treeResource({ resourceId: 'workspace', resourceKind: 'workspace', path: workspacePath }),
    fileResource({
      resourceId: 'mcp', resourceKind: 'mcp-config', path: mcpPath,
      classification: 'secret', mediaType: 'application/json',
    }),
    fileResource({
      resourceId: 'mock-plan', resourceKind: 'mock-plan', path: mockPlanPath,
      classification: 'secret',
      mediaType: 'application/vnd.omk.mock-interception-plan+json',
    }),
    fileResource({
      resourceId: 'mock-rule', resourceKind: 'mock-rule', path: mockRulePath,
      classification: 'secret', mediaType: 'application/json',
    }),
    fileResource({
      resourceId: 'mock', resourceKind: 'mock-payload', path: mockPath,
      classification: 'secret', mediaType: 'application/json',
    }),
    fileResource({
      resourceId: 'content', resourceKind: 'content', path: contentPath,
      mediaType: 'application/json',
    }),
    fileResource({
      resourceId: 'gold', resourceKind: 'gold-dataset', path: goldPath,
      classification: 'gold', mediaType: 'application/json',
    }),
  ]);
  return { artifactPath, workspacePath, resources };
}

describe('Verified HostResource leases', () => {
  it('materializes immutable workspace bases shared by bindings and analysis-only Gold', async () => {
    const fixture = await completeFixture();
    const leases = await materializeNodeRunResourceLeases({
      runId: 'run-resource-isolation',
      leaseRoot,
      hostResources: inventory(fixture.resources),
      bindings: [
        {
          consumerKind: 'executor',
          bindingId: 'executor-a',
          requirements: [
            requirement('artifact', 'artifact'),
            requirement('workspace', 'workspace'),
            requirement('mcp-config', 'mcp'),
            requirement('mock-plan', 'mock-plan'),
            requirement('mock-rule', 'mock-rule'),
            requirement('mock-payload', 'mock'),
          ],
        },
        {
          consumerKind: 'executor',
          bindingId: 'executor-b',
          requirements: [
            requirement('artifact', 'artifact'),
            requirement('workspace', 'workspace'),
          ],
        },
        {
          consumerKind: 'evaluator',
          bindingId: 'evaluator-a',
          requirements: [requirement('content', 'content')],
        },
      ],
      analysisOnly: [{
        consumerKind: 'analysis-host', resourceRole: 'gold-dataset', resourceId: 'gold',
      }],
    });
    const executorA = leases.bindingsByBindingId.get('executor-a');
    const executorB = leases.bindingsByBindingId.get('executor-b');
    const artifact = executorA?.resourcesByResourceId.get('artifact');
    const workspaceA = executorA?.resourcesByResourceId.get('workspace');
    const workspaceB = executorB?.resourcesByResourceId.get('workspace');
    if (artifact?.leaseMode !== 'immutable-snapshot'
        || workspaceA?.leaseMode !== 'copy-on-write-overlay'
        || workspaceB?.leaseMode !== 'copy-on-write-overlay') {
      throw new Error('fixture lease shape mismatch');
    }

    expect(artifact.snapshotPath).not.toBe(fixture.artifactPath);
    expect(readFileSync(artifact.snapshotPath, 'utf8')).toBe('# Skill\nverified\n');
    expect(statSync(artifact.snapshotPath).mode & 0o222).toBe(0);
    expect(workspaceA.baseSnapshotPath).toBe(workspaceB.baseSnapshotPath);
    expect(workspaceA).not.toHaveProperty('overlayPath');
    expect(statSync(workspaceA.baseSnapshotPath).mode & 0o222).toBe(0);
    expect(readFileSync(join(workspaceA.baseSnapshotPath, 'src', 'index.ts'), 'utf8'))
      .toBe('export const value = 1;\n');
    expect(readFileSync(join(fixture.workspacePath, 'src', 'index.ts'), 'utf8'))
      .toBe('export const value = 1;\n');
    expect([...leases.bindingsByBindingId.values()].some((binding) => (
      binding.resourcesByResourceId.has('gold')
    ))).toBe(false);
    expect(leases.analysisOnlyResourcesByResourceId.has('gold')).toBe(true);
    expect((leases.bindingsByBindingId as unknown as { set?: unknown }).set).toBeUndefined();

    writeFileSync(fixture.artifactPath, '# Skill\nmutated\n');
    expect(readFileSync(artifact.snapshotPath, 'utf8')).toBe('# Skill\nverified\n');
    const runRoot = dirname(dirname(artifact.snapshotPath));
    const firstDispose = leases.dispose();
    const secondDispose = leases.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;
    expect(existsSync(runRoot)).toBe(false);
  });

  it('snapshots mutable descriptors and binding requests before asynchronous I/O', async () => {
    const path = join(sourceRoot, 'artifact.txt');
    writeFileSync(path, 'stable');
    const original = await fileResource({
      resourceId: 'artifact', resourceKind: 'artifact', path,
    });
    const mutableResource = {
      ...original,
      descriptor: { ...original.descriptor },
    };
    const mutableRequirement = { ...requirement('artifact', 'artifact') };
    const acquisition = materializeNodeRunResourceLeases({
      runId: 'run-input-snapshot',
      leaseRoot,
      hostResources: inventory([mutableResource]),
      bindings: [{
        consumerKind: 'executor',
        bindingId: 'executor',
        requirements: [mutableRequirement],
      }],
    });
    mutableResource.descriptor.digest = `sha256:${'0'.repeat(64)}`;
    mutableRequirement.resourceId = 'mutated-after-call';

    const leases = await acquisition;
    const leased = leases.bindingsByBindingId.get('executor')
      ?.resourcesByResourceId.get('artifact');
    expect(leased?.descriptor.digest).toBe(original.descriptor.digest);
    expect(Object.isFrozen(leased?.descriptor)).toBe(true);
    await leases.dispose();
  });

  it('isolates snapshot ownership across concurrent runs and independent teardown', async () => {
    const workspacePath = join(sourceRoot, 'workspace');
    mkdirSync(workspacePath);
    writeFileSync(join(workspacePath, 'state.txt'), 'base');
    const workspace = await treeResource({
      resourceId: 'workspace', resourceKind: 'workspace', path: workspacePath,
    });
    const request = (runId: string) => materializeNodeRunResourceLeases({
      runId,
      leaseRoot,
      hostResources: inventory([workspace]),
      bindings: [{
        consumerKind: 'executor' as const,
        bindingId: 'executor',
        requirements: [requirement('workspace', 'workspace')],
      }],
    });
    const [first, second] = await Promise.all([request('run-a'), request('run-b')]);
    const firstLease = first.bindingsByBindingId.get('executor')
      ?.resourcesByResourceId.get('workspace');
    const secondLease = second.bindingsByBindingId.get('executor')
      ?.resourcesByResourceId.get('workspace');
    if (firstLease?.leaseMode !== 'copy-on-write-overlay'
        || secondLease?.leaseMode !== 'copy-on-write-overlay') {
      throw new Error('missing workspace lease');
    }
    expect(firstLease.baseSnapshotPath).not.toBe(secondLease.baseSnapshotPath);
    expect(readFileSync(join(secondLease.baseSnapshotPath, 'state.txt'), 'utf8')).toBe('base');
    const secondRunRoot = dirname(dirname(secondLease.baseSnapshotPath));
    await first.dispose();
    expect(existsSync(secondRunRoot)).toBe(true);
    await second.dispose();
    expect(existsSync(secondRunRoot)).toBe(false);
  });

  it('does not probe structurally valid resources that no active binding requests', async () => {
    const contentPath = join(sourceRoot, 'content.json');
    writeFileSync(contentPath, '{}');
    const content = await fileResource({
      resourceId: 'content', resourceKind: 'content', path: contentPath,
    });
    const digest = `sha256:${'0'.repeat(64)}` as const;
    const unused: ResolvedHostResource = {
      resourceKind: 'artifact',
      descriptor: {
        resourceId: 'unused-git', digest, size: 0,
        mediaType: 'application/vnd.omk.tree', classification: 'public',
      },
      locator: join(sourceRoot, 'does-not-exist'),
      verification: {
        verificationKind: 'pinned-git', verifiedDigest: digest, commitId: 'a'.repeat(40),
      },
    };
    let verifierCalls = 0;
    const leases = await materializeNodeRunResourceLeases({
      runId: 'run-active-only',
      leaseRoot,
      hostResources: inventory([content, unused]),
      pinnedGitVerifier: {
        async verifyPinnedCommit() {
          verifierCalls += 1;
          return { actualCommitId: 'a'.repeat(40), contentMatchesCommit: true };
        },
      },
      bindings: [{
        consumerKind: 'evaluator', bindingId: 'evaluator',
        requirements: [requirement('content', 'content')],
      }],
    });
    expect(verifierCalls).toBe(0);
    expect(leases.bindingsByBindingId.get('evaluator')
      ?.resourcesByResourceId.has('content')).toBe(true);
    await leases.dispose();
  });

  it('fails closed and cleans partial snapshots when source bytes change', async () => {
    const path = join(sourceRoot, 'artifact.txt');
    writeFileSync(path, 'good');
    const resource = await fileResource({ resourceId: 'artifact', resourceKind: 'artifact', path });
    writeFileSync(path, 'evil');

    const failure = await materializeNodeRunResourceLeases({
      runId: 'run-tampered', leaseRoot, hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'artifact')],
      }],
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'OMK_RESOURCE_LEASE_DIGEST_MISMATCH', resourceId: 'artifact',
    });
    expect((failure as Error).message).not.toContain(path);
    expect((failure as Error).message).not.toContain('evil');
    expect(readdirSync(leaseRoot)).toEqual([]);
  });

  it('rejects containment between resource sources and the cleanup root', async () => {
    const path = join(sourceRoot, 'artifact.txt');
    writeFileSync(path, 'protected-source');
    const resource = await fileResource({
      resourceId: 'artifact', resourceKind: 'artifact', path,
    });
    const nestedLeaseRoot = sourceRoot;

    await expect(materializeNodeRunResourceLeases({
      runId: 'run-root-containment',
      leaseRoot: nestedLeaseRoot,
      hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'artifact')],
      }],
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_INPUT_INVALID', resourceId: 'artifact',
    });
    expect(readFileSync(path, 'utf8')).toBe('protected-source');
  });

  it('distinguishes descriptor size mismatch from digest mismatch', async () => {
    const path = join(sourceRoot, 'content.txt');
    writeFileSync(path, 'content');
    const original = await fileResource({
      resourceId: 'content', resourceKind: 'content', path,
    });
    const resource: ResolvedHostResource = {
      ...original,
      descriptor: { ...original.descriptor, size: original.descriptor.size + 1 },
    };

    await expect(materializeNodeRunResourceLeases({
      runId: 'run-size', leaseRoot, hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'evaluator', bindingId: 'evaluator',
        requirements: [requirement('content', 'content')],
      }],
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_SIZE_MISMATCH' });
  });

  it('rejects role substitution and Gold projection before reading sources', async () => {
    const fixture = await completeFixture();
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-role', leaseRoot, hostResources: inventory(fixture.resources),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'content')],
      }],
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_ROLE_MISMATCH' });

    const gold = fixture.resources.find((resource) => resource.resourceKind === 'gold-dataset');
    if (gold === undefined) throw new Error('missing Gold fixture');
    const poisoned: ResolvedHostResource = { ...structuredClone(gold), resourceKind: 'artifact' };
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-gold', leaseRoot, hostResources: inventory([poisoned]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'gold')],
      }],
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_CLASSIFICATION_DENIED' });
    expect(readdirSync(leaseRoot)).toEqual([]);
  });

  it('defends secret mock-control invariants again at lease acquisition', async () => {
    const fixture = await completeFixture();
    for (const [resourceKind, resourceRole] of [
      ['mcp-config', 'mcp-config'],
      ['mock-plan', 'mock-plan'],
      ['mock-rule', 'mock-rule'],
      ['mock-payload', 'mock-payload'],
    ] as const) {
      const original = fixture.resources.find((resource) => (
        resource.resourceKind === resourceKind
      ));
      if (original === undefined) throw new Error('missing control resource fixture');
      const poisoned: ResolvedHostResource = {
        ...original,
        descriptor: { ...original.descriptor, classification: 'sensitive' },
      };
      await expect(materializeNodeRunResourceLeases({
        runId: `run-${resourceKind}-classification`,
        leaseRoot,
        hostResources: inventory([poisoned]),
        bindings: [{
          consumerKind: 'executor',
          bindingId: 'executor',
          requirements: [requirement(resourceRole, original.descriptor.resourceId)],
        }],
      })).rejects.toMatchObject({
        code: 'OMK_RESOURCE_LEASE_CLASSIFICATION_DENIED',
        resourceId: original.descriptor.resourceId,
      });
    }

    const mockRule = fixture.resources.find((resource) => (
      resource.resourceKind === 'mock-rule'
    ));
    if (mockRule === undefined) throw new Error('missing mock rule fixture');
    const wrongMediaType: ResolvedHostResource = {
      ...mockRule,
      descriptor: { ...mockRule.descriptor, mediaType: 'text/plain' },
    };
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-mock-rule-media-type',
      leaseRoot,
      hostResources: inventory([wrongMediaType]),
      bindings: [{
        consumerKind: 'executor',
        bindingId: 'executor',
        requirements: [requirement('mock-rule', mockRule.descriptor.resourceId)],
      }],
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
      resourceId: mockRule.descriptor.resourceId,
    });

    const mockPlan = fixture.resources.find((resource) => (
      resource.resourceKind === 'mock-plan'
    ));
    if (mockPlan === undefined) throw new Error('missing mock plan fixture');
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-mock-plan-media-type',
      leaseRoot,
      hostResources: inventory([{
        ...mockPlan,
        descriptor: { ...mockPlan.descriptor, mediaType: 'application/json' },
      }]),
      bindings: [{
        consumerKind: 'executor',
        bindingId: 'executor',
        requirements: [requirement('mock-plan', mockPlan.descriptor.resourceId)],
      }],
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_INPUT_INVALID',
      resourceId: mockPlan.descriptor.resourceId,
    });
    expect(readdirSync(leaseRoot)).toEqual([]);
  });

  it('rejects symlinks in a tree without copying their targets', async () => {
    const workspacePath = join(sourceRoot, 'workspace');
    const outsidePath = join(sourceRoot, 'outside-secret');
    mkdirSync(workspacePath);
    writeFileSync(outsidePath, 'do-not-copy');
    symlinkSync(outsidePath, join(workspacePath, 'escape'));
    const digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const;
    const resource: ResolvedHostResource = {
      resourceKind: 'workspace',
      descriptor: {
        resourceId: 'workspace', digest, size: 0,
        mediaType: 'application/vnd.omk.tree', classification: 'public',
      },
      locator: workspacePath,
      verification: { verificationKind: 'tree-digest', verifiedDigest: digest },
    };

    await expect(materializeNodeRunResourceLeases({
      runId: 'run-symlink', leaseRoot, hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('workspace', 'workspace')],
      }],
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_SOURCE_INVALID' });
    expect(readdirSync(leaseRoot)).toEqual([]);
  });

  it('rejects a symlink locator and incompatible resource verification kinds', async () => {
    const target = join(sourceRoot, 'target.txt');
    const locator = join(sourceRoot, 'artifact-link');
    writeFileSync(target, 'target');
    symlinkSync(target, locator);
    const resource = await fileResource({
      resourceId: 'artifact', resourceKind: 'artifact', path: target,
    });
    const linked: ResolvedHostResource = { ...resource, locator };
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-link', leaseRoot, hostResources: inventory([linked]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'artifact')],
      }],
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_SOURCE_INVALID', resourceId: 'artifact',
    });

    const invalidContent: ResolvedHostResource = {
      ...resource,
      resourceKind: 'content',
      verification: {
        verificationKind: 'tree-digest', verifiedDigest: resource.descriptor.digest,
      },
    };
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-verification-kind',
      leaseRoot,
      hostResources: inventory([invalidContent]),
      bindings: [{
        consumerKind: 'evaluator', bindingId: 'evaluator',
        requirements: [requirement('content', 'artifact')],
      }],
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_VERIFICATION_INVALID', resourceId: 'artifact',
    });
  });

  it('verifies pinned Git identity and excludes repository metadata from snapshots', async () => {
    const repository = join(sourceRoot, 'repository');
    mkdirSync(join(repository, '.git'), { recursive: true });
    writeFileSync(join(repository, '.git', 'config'), 'secret metadata');
    writeFileSync(join(repository, 'README.md'), '# pinned\n');
    const actual = await digestNodePinnedGitTreeResource(repository);
    const commitId = 'a'.repeat(40);
    const resource: ResolvedHostResource = {
      resourceKind: 'artifact',
      descriptor: {
        resourceId: 'git-artifact', digest: actual.digest, size: actual.size,
        mediaType: 'application/vnd.omk.tree', classification: 'public',
      },
      locator: repository,
      verification: {
        verificationKind: 'pinned-git', verifiedDigest: actual.digest, commitId,
      },
    };
    const calls: string[] = [];
    const verifier: OmkPinnedGitVerifier = {
      async verifyPinnedCommit(request) {
        calls.push(request.resourceId);
        return { actualCommitId: commitId, contentMatchesCommit: true };
      },
    };
    const leases = await materializeNodeRunResourceLeases({
      runId: 'run-git', leaseRoot, hostResources: inventory([resource]),
      pinnedGitVerifier: verifier,
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'git-artifact')],
      }],
    });
    const leased = leases.bindingsByBindingId.get('executor')
      ?.resourcesByResourceId.get('git-artifact');
    if (leased?.leaseMode !== 'immutable-snapshot' || leased.snapshotKind !== 'directory') {
      throw new Error('missing pinned Git lease');
    }
    expect(calls).toEqual(['git-artifact']);
    expect(existsSync(join(leased.snapshotPath, '.git'))).toBe(false);
    await leases.dispose();

    const mismatchedVerifier: OmkPinnedGitVerifier = {
      async verifyPinnedCommit() {
        return { actualCommitId: 'b'.repeat(40), contentMatchesCommit: true };
      },
    };
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-git-mismatch', leaseRoot, hostResources: inventory([resource]),
      pinnedGitVerifier: mismatchedVerifier,
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'git-artifact')],
      }],
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_GIT_IDENTITY_MISMATCH' });
  });

  it('verifies pinned Git against the repository HEAD with the default verifier', async () => {
    const repository = join(sourceRoot, 'real-repository');
    mkdirSync(repository);
    execFileSync('git', ['-C', repository, 'init', '-q']);
    writeFileSync(join(repository, 'README.md'), '# real pinned repository\n');
    execFileSync('git', ['-C', repository, 'add', 'README.md']);
    execFileSync('git', [
      '-C', repository,
      '-c', 'user.name=OMK Test',
      '-c', 'user.email=omk@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null',
      'commit', '-qm', 'fixture',
    ]);
    const commitId = execFileSync(
      'git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
    ).trim();
    const actual = await digestNodePinnedGitTreeResource(repository);
    const resource: ResolvedHostResource = {
      resourceKind: 'artifact',
      descriptor: {
        resourceId: 'real-git', digest: actual.digest, size: actual.size,
        mediaType: 'application/vnd.omk.tree', classification: 'public',
      },
      locator: repository,
      verification: {
        verificationKind: 'pinned-git', verifiedDigest: actual.digest, commitId,
      },
    };

    const leases = await materializeNodeRunResourceLeases({
      runId: 'run-real-git', leaseRoot, hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'real-git')],
      }],
    });
    expect(leases.bindingsByBindingId.get('executor')
      ?.resourcesByResourceId.has('real-git')).toBe(true);
    await leases.dispose();

    writeFileSync(join(repository, 'untracked.txt'), 'not part of the pinned commit');
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-dirty-git', leaseRoot, hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('artifact', 'real-git')],
      }],
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_GIT_IDENTITY_MISMATCH', resourceId: 'real-git',
    });
  });

  it('binds executable mode into the deterministic tree digest', async () => {
    const tree = join(sourceRoot, 'tree');
    mkdirSync(tree);
    const script = join(tree, 'run.sh');
    writeFileSync(script, '#!/bin/sh\n');
    chmodSync(script, 0o644);
    const nonExecutable = await digestNodeTreeResource(tree);
    chmodSync(script, 0o755);
    const executable = await digestNodeTreeResource(tree);
    expect(executable.size).toBe(nonExecutable.size);
    expect(executable.digest).not.toBe(nonExecutable.digest);
  });

  it('produces the same tree digest regardless of filesystem creation order', async () => {
    const first = join(sourceRoot, 'first');
    const second = join(sourceRoot, 'second');
    mkdirSync(join(first, 'empty'), { recursive: true });
    writeFileSync(join(first, 'b.txt'), 'b');
    writeFileSync(join(first, 'a.txt'), 'a');
    mkdirSync(join(second, 'empty'), { recursive: true });
    writeFileSync(join(second, 'a.txt'), 'a');
    writeFileSync(join(second, 'b.txt'), 'b');
    expect(await digestNodeTreeResource(first)).toEqual(await digestNodeTreeResource(second));
  });

  it('freezes the tree digest algorithm with a canonical golden vector', async () => {
    const tree = join(sourceRoot, 'golden-tree');
    mkdirSync(join(tree, 'empty'), { recursive: true });
    writeFileSync(join(tree, 'a.txt'), 'a');
    writeFileSync(join(tree, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(tree, 'run.sh'), 0o755);

    expect(OMK_TREE_DIGEST_ALGORITHM).toBe('omk.tree-sha256/v1');
    expect(await digestNodeTreeResource(tree)).toEqual({
      digest: 'sha256:ff9a12e929ba345a9e2691b8561dce7706dfce55f5e1e0bbea77f6076deeacf2',
      size: 11,
    });
  });

  it('enforces byte limits and rejects old HostResource schemas', async () => {
    const path = join(sourceRoot, 'large.txt');
    writeFileSync(path, '12345');
    const resource = await fileResource({ resourceId: 'artifact', resourceKind: 'artifact', path });
    const request = {
      runId: 'run-limit', leaseRoot, hostResources: inventory([resource]),
      bindings: [{
        consumerKind: 'executor' as const, bindingId: 'executor',
        requirements: [requirement('artifact', 'artifact')],
      }],
    };
    await expect(materializeNodeRunResourceLeases({
      ...request, limits: { maxResourceBytes: 4 },
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED' });

    const workspacePath = join(sourceRoot, 'limited-workspace');
    mkdirSync(workspacePath);
    writeFileSync(join(workspacePath, 'data.txt'), '12345');
    const workspace = await treeResource({
      resourceId: 'workspace', resourceKind: 'workspace', path: workspacePath,
    });
    await expect(materializeNodeRunResourceLeases({
      runId: 'run-aggregate-limit',
      leaseRoot,
      hostResources: inventory([workspace]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('workspace', 'workspace')],
      }],
      limits: { maxRunMaterializedBytes: 4 },
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
      resourceId: 'workspace',
    });
    expect(readdirSync(leaseRoot)).toEqual([]);

    await expect(materializeNodeRunResourceLeases({
      runId: 'run-aggregate-entry-limit',
      leaseRoot,
      hostResources: inventory([workspace]),
      bindings: [{
        consumerKind: 'executor', bindingId: 'executor',
        requirements: [requirement('workspace', 'workspace')],
      }],
      limits: { maxRunMaterializedEntries: 1 },
    })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_LIMIT_EXCEEDED',
      resourceId: 'workspace',
    });
    expect(readdirSync(leaseRoot)).toEqual([]);

    await expect(materializeNodeRunResourceLeases({
      ...request,
      hostResources: {
        ...request.hostResources,
        schemaVersion: 'omk.resolved-host-resources/v2',
      } as unknown as ResolvedHostResources,
    })).rejects.toMatchObject({ code: 'OMK_RESOURCE_LEASE_INPUT_INVALID' });
  });
});


it('forwards cancellation to Git verification and removes partially acquired resources', async () => {
  const path = join(sourceRoot, 'pinned');
  mkdirSync(path);
  writeFileSync(join(path, 'README.md'), '# input');
  const actual = await digestNodePinnedGitTreeResource(path);
  const commitId = 'a'.repeat(40);
  const controller = new AbortController();
  const reason = new Error('cancel acquisition');
  const resource: ResolvedHostResource = {
    resourceKind: 'artifact',
    descriptor: { resourceId: 'artifact', ...actual, mediaType: 'application/vnd.omk.tree', classification: 'public' },
    locator: path,
    verification: { verificationKind: 'pinned-git', verifiedDigest: actual.digest, commitId },
  };
  await expect(materializeNodeRunResourceLeases({
    runId: 'cancel-pinned', leaseRoot, signal: controller.signal,
    hostResources: inventory([resource]),
    bindings: [{ consumerKind: 'executor', bindingId: 'executor', requirements: [requirement('artifact', 'artifact')] }],
    pinnedGitVerifier: {
      async verifyPinnedCommit(request) {
        expect(request.signal).toBe(controller.signal);
        expect(readdirSync(leaseRoot)).toHaveLength(1);
        controller.abort(reason);
        request.signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    },
  })).rejects.toBe(reason);
  expect(readdirSync(leaseRoot)).toEqual([]);
  expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# input');
});

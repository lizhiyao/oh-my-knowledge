import type { RuntimeBinding } from '../../input-compilation/index.js';
import {
  OmkResourceLeaseAccessError,
  type OmkBindingResourceLeaseAccess,
  type OmkRunResourceLeaseRegistry,
  type OmkRunResourceLeases,
} from './types.js';

type ResourceConsumerBinding = Extract<RuntimeBinding, {
  runtimeKind: 'executor' | 'evaluator';
}>;

function fail(
  input: ConstructorParameters<typeof OmkResourceLeaseAccessError>[0],
): never {
  throw new OmkResourceLeaseAccessError(input);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resourceKindForRole(
  role: ResourceConsumerBinding['resourceLeaseRequirements'][number]['resourceRole'],
) {
  return role === 'mcp-config'
    ? 'mcp-config'
    : role === 'mock-plan'
      ? 'mock-plan'
      : role === 'mock-rule'
        ? 'mock-rule'
        : role === 'mock-payload'
          ? 'mock-payload'
          : role;
}

export interface OmkResourceLeaseAccessRegistry {
  readonly lifecycle: OmkRunResourceLeaseRegistry;
  accessFor(binding: Readonly<ResourceConsumerBinding>): OmkBindingResourceLeaseAccess;
}

/**
 * Keeps run leases out of static Runtime ports while giving each factory a least-authority view.
 */
export function createOmkResourceLeaseAccessRegistry(
  bindings: readonly ResourceConsumerBinding[],
): OmkResourceLeaseAccessRegistry {
  const expected = new Map(bindings.map((binding) => [
    binding.bindingId,
    binding,
  ]));
  const active = new Map<string, OmkRunResourceLeases>();

  const activePaths = (): { readOnly: Set<string>; writable: Set<string> } => {
    const readOnly = new Set<string>();
    const writable = new Set<string>();
    for (const leases of active.values()) {
      for (const binding of leases.bindingsByBindingId.values()) {
        for (const resource of binding.resourcesByResourceId.values()) {
          if (resource.leaseMode === 'immutable-snapshot') readOnly.add(resource.snapshotPath);
          else {
            readOnly.add(resource.baseSnapshotPath);
            writable.add(resource.overlayPath);
          }
        }
      }
    }
    return { readOnly, writable };
  };

  const lifecycle: OmkRunResourceLeaseRegistry = Object.freeze({
    register(leases: OmkRunResourceLeases): void {
      if (active.has(leases.runId)) fail({
        code: 'OMK_RESOURCE_LEASE_RUN_ACTIVE',
        runId: leases.runId,
        message: `runId "${leases.runId}" 已注册 resource lease。`,
      });
      const actualIds = [...leases.bindingsByBindingId.keys()].sort(compareStrings);
      const expectedIds = [...expected.keys()].sort(compareStrings);
      if (actualIds.length !== expectedIds.length
          || actualIds.some((bindingId, index) => bindingId !== expectedIds[index])) fail({
        code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
        runId: leases.runId,
        message: 'Run resource lease 未精确覆盖 active Executor／Evaluator bindings。',
      });
      const occupied = activePaths();
      const currentReadonly = new Set<string>();
      const currentWritable = new Set<string>();
      for (const [bindingId, binding] of expected) {
        const lease = leases.bindingsByBindingId.get(bindingId);
        if (lease === undefined || lease.bindingId !== bindingId
            || lease.consumerKind !== binding.runtimeKind) fail({
          code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
          runId: leases.runId,
          bindingId,
          message: 'Run resource lease 的 binding identity 或 consumer kind 不一致。',
        });
        const expectedResourceIds = binding.resourceLeaseRequirements
          .map((requirement) => requirement.resourceId).sort(compareStrings);
        const actualResourceIds = [...lease.resourcesByResourceId.keys()].sort(compareStrings);
        if (actualResourceIds.length !== expectedResourceIds.length
            || actualResourceIds.some((resourceId, index) => (
              resourceId !== expectedResourceIds[index]
            ))) fail({
          code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
          runId: leases.runId,
          bindingId,
          message: 'Binding resource lease 未精确覆盖声明的 resource requirements。',
        });
        for (const requirement of binding.resourceLeaseRequirements) {
          const resource = lease.resourcesByResourceId.get(requirement.resourceId);
          if (resource === undefined || resource.resourceId !== requirement.resourceId
              || resource.leaseMode !== requirement.leaseMode
              || resource.resourceKind !== resourceKindForRole(requirement.resourceRole)
              || resource.descriptor?.resourceId !== requirement.resourceId
              || (resource.leaseMode === 'immutable-snapshot'
                && (typeof resource.snapshotPath !== 'string' || resource.snapshotPath === ''))
              || (resource.leaseMode === 'copy-on-write-overlay'
                && (typeof resource.baseSnapshotPath !== 'string'
                  || resource.baseSnapshotPath === ''
                  || typeof resource.overlayPath !== 'string'
                  || resource.overlayPath === ''
                  || resource.baseSnapshotPath === resource.overlayPath))
              || (binding.runtimeKind === 'executor'
                && resource.descriptor?.classification === 'gold')) fail({
            code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
            runId: leases.runId,
            bindingId,
            message: 'Binding resource lease 的 resource identity、mode 或 classification 不合法。',
          });
          if (resource.leaseMode === 'immutable-snapshot') {
            currentReadonly.add(resource.snapshotPath);
          } else {
            if (currentWritable.has(resource.overlayPath)
                || occupied.writable.has(resource.overlayPath)
                || occupied.readOnly.has(resource.overlayPath)) fail({
              code: 'OMK_RESOURCE_LEASE_ISOLATION_MISMATCH',
              runId: leases.runId,
              bindingId,
              message: 'Writable resource overlay 与其它 binding／run 路径冲突。',
            });
            currentReadonly.add(resource.baseSnapshotPath);
            currentWritable.add(resource.overlayPath);
          }
        }
      }
      if ([...currentWritable].some((path) => currentReadonly.has(path))) fail({
        code: 'OMK_RESOURCE_LEASE_ISOLATION_MISMATCH',
        runId: leases.runId,
        message: 'Writable resource overlay 与当前 run 的只读 snapshot 路径冲突。',
      });
      active.set(leases.runId, leases);
    },
    unregister(runId: string): void {
      if (!active.delete(runId)) fail({
        code: 'OMK_RESOURCE_LEASE_RUN_INACTIVE',
        runId,
        message: `runId "${runId}" 没有 active resource lease。`,
      });
    },
  });

  return Object.freeze({
    lifecycle,
    accessFor(binding: Readonly<ResourceConsumerBinding>): OmkBindingResourceLeaseAccess {
      if (expected.get(binding.bindingId)?.runtimeKind !== binding.runtimeKind) fail({
        code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
        bindingId: binding.bindingId,
        message: '无法为 assembly 未声明的 binding 创建 resource lease access。',
      });
      return Object.freeze({
        forRun(runId: string) {
          const leases = active.get(runId);
          if (leases === undefined) return fail({
            code: 'OMK_RESOURCE_LEASE_RUN_INACTIVE',
            runId,
            bindingId: binding.bindingId,
            message: `runId "${runId}" 尚未取得 active resource lease。`,
          });
          const lease = leases.bindingsByBindingId.get(binding.bindingId);
          if (lease === undefined || lease.consumerKind !== binding.runtimeKind) return fail({
            code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
            runId,
            bindingId: binding.bindingId,
            message: 'Active resource lease 不包含当前 binding。',
          });
          return lease;
        },
      });
    },
  });
}

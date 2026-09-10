import type { ArtifactKind } from '../contracts.js';
import type { ResolvedSource } from '../sources/install-source.js';
import { hashArtifactSource } from '../sources/content-hash.js';
import type { ManagedArtifactRecord, ManagedDistributionTarget } from './contracts.js';
import { buildManagedArtifactRecord, recordManagedArtifact } from './store.js';

export interface ArtifactInstallTarget {
  label: string;
  path: string;
}

export type ArtifactDeployment = 'planned' | 'copied' | 'adopted';

export class InstallRegistrationError extends Error {
  constructor(readonly paths: string[], readonly store: string, cause: unknown) {
    super(`Deployment completed but managed registration failed: ${paths.join(', ')}. Repair ${store}, then retry with --force.`, { cause });
  }
}

/**
 * Register successful destinations even when a later deployment fails. This is a
 * recoverable multi-target operation, not a filesystem-wide atomic transaction.
 * The host supplies deployment and presentation; governance owns record identity
 * and partial-success persistence. Source resource lifetime belongs to the caller.
 */
export function installManagedArtifact(input: {
  source: ResolvedSource;
  artifactKind: ArtifactKind;
  targets: readonly ArtifactInstallTarget[];
  store: string;
  installedAt: string;
  deploy: (target: ArtifactInstallTarget) => ArtifactDeployment;
  onDeployment?: (target: ArtifactInstallTarget, result: ArtifactDeployment) => void;
  onRegistered?: (record: ManagedArtifactRecord) => void;
}): void {
  const { localRoot, name, isDirectorySkill, sourceKind, locator, ref, url } = input.source;
  const contentHash = hashArtifactSource(localRoot, isDirectorySkill);
  const distribution: ManagedDistributionTarget[] = [];
  const failures: unknown[] = [];
  try {
    for (const target of input.targets) {
      const result = input.deploy(target);
      if (result !== 'planned') {
        distribution.push({ ...target, contentHash, copiedAt: input.installedAt });
      }
      input.onDeployment?.(target, result);
    }
  } catch (error) {
    failures.push(error);
  }
  if (distribution.length > 0) {
    const record = buildManagedArtifactRecord({
      name,
      kind: input.artifactKind,
      source: { sourceKind, locator, ...(ref ? { ref } : {}), ...(url ? { url } : {}), isDirectorySkill },
      contentHash,
      installedAt: input.installedAt,
      distribution,
    });
    try {
      recordManagedArtifact(record, { dir: input.store });
    } catch (cause) {
      failures.push(new InstallRegistrationError(distribution.map((target) => target.path), input.store, cause));
    }
    if (!failures.some((error) => error instanceof InstallRegistrationError)) {
      try {
        input.onRegistered?.(record);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join('; '));
}

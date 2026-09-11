import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installManagedArtifact, InstallRegistrationError } from '../../../src/knowledge-artifacts/governance/install.js';
import { loadAllManagedRecords } from '../../../src/knowledge-artifacts/governance/store.js';
import { resolveInstallSource, usingInstallSource } from '../../../src/knowledge-artifacts/sources/install-source.js';
import { replaceDeployedArtifact } from '../../../src/knowledge-artifacts/sources/deploy-artifact.js';

it.each([false, true])('recovers partial deployment and registration failure (blocked store: %s)', (blockedStore) => {
  const root = mkdtempSync(join(tmpdir(), 'omk-install-usecase-'));
  try {
    const path = join(root, 'review.md');
    writeFileSync(path, '# Review');
    const source = resolveInstallSource(path);
    const store = join(root, 'managed');
    if (blockedStore) writeFileSync(store, 'obstruction');
    const targets = ['first', 'second'].map((label) => ({ label, path: join(root, `${label}.md`) }));
    const deploymentFailure = new Error('second destination unavailable');
    const request = { source, artifactKind: 'skill' as const, store, targets, installedAt: '2026-09-11T00:00:00.000Z' };
    let failure: unknown;
    try { usingInstallSource(source, () => installManagedArtifact({
      ...request,
      deploy(target) {
        if (target.label === 'second') throw deploymentFailure;
        replaceDeployedArtifact(source.localRoot, target.path, false);
        return 'copied';
      },
    })); } catch (error) { failure = error; }
    if (blockedStore) expect(failure).toBeInstanceOf(AggregateError);
    else expect(failure).toBe(deploymentFailure);
    expect(readFileSync(targets[0].path, 'utf8')).toBe('# Review');
    if (blockedStore) {
      const errors = (failure as AggregateError).errors;
      expect(errors[0]).toBe(deploymentFailure);
      expect(errors[1]).toBeInstanceOf(InstallRegistrationError);
      expect(errors[1].paths).toEqual([targets[0].path]);
      expect(errors[1].store).toBe(store);
      rmSync(store);
    } else {
      expect(loadAllManagedRecords(store)[0].distribution.map((entry) => entry.path)).toEqual([targets[0].path]);
    }
    installManagedArtifact({ ...request, deploy(target) {
      replaceDeployedArtifact(source.localRoot, target.path, false, true);
      return 'copied';
    } });
    const records = loadAllManagedRecords(store);
    expect(records).toHaveLength(1);
    expect(records[0].distribution.map((entry) => entry.path).sort()).toEqual(targets.map((target) => target.path).sort());
    expect(readFileSync(targets[1].path, 'utf8')).toBe('# Review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

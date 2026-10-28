import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertOptionalExecutorDependency,
  getOptionalExecutorDependency,
} from '../../src/executors/core/optional-dependencies.js';

describe('optional executor dependencies', () => {
  it('does not inspect dependencies for core CLI and API executors', () => {
    let inspected = false;
    assert.doesNotThrow(() => assertOptionalExecutorDependency('codex', () => {
      inspected = true;
      return false;
    }));
    assert.equal(inspected, false);
  });

  it('accepts an SDK installed in the same package scope', () => {
    assert.doesNotThrow(() => assertOptionalExecutorDependency('codex-sdk', (packageName) => {
      assert.equal(packageName, '@openai/codex-sdk');
      return true;
    }));
  });

  it('uses the compatible Codex SDK patch range in the install command', () => {
    assert.throws(
      () => assertOptionalExecutorDependency('codex-sdk', () => false),
      /npm install @openai\/codex-sdk@\^0\.149\.0/,
    );
  });

  it('keeps SDKs optional for consumers and pins the real development contract', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    for (const executorName of ['codex-sdk'] as const) {
      const dependency = getOptionalExecutorDependency(executorName)!;
      const peerRange = packageJson.peerDependencies?.[dependency.packageName];
      assert.equal(dependency.installSpec, `${dependency.packageName}@${peerRange}`);
      assert.equal(packageJson.peerDependenciesMeta?.[dependency.packageName]?.optional, true);
      assert.equal(packageJson.dependencies?.[dependency.packageName], undefined);
      const developmentVersion = packageJson.devDependencies?.[dependency.packageName] ?? '';
      assert.match(developmentVersion, /^\d+\.\d+\.\d+$/);
      // 仅覆盖当前 0.x 同 minor 的 patch 支持策略；政策改变须显式更新，不是通用 semver 判定。
      const patchRange = /^\^0\.([1-9]\d*)\.(\d+)$/.exec(peerRange ?? '');
      assert.ok(patchRange, 'The public Codex SDK contract must use the current 0.x patch policy.');
      const [developmentMajor, developmentMinor, developmentPatch] = developmentVersion.split('.').map(Number);
      assert.equal(developmentMajor, 0);
      assert.equal(developmentMinor, Number(patchRange[1]));
      assert.ok(developmentPatch >= Number(patchRange[2]), 'The tested SDK must be within the public patch range.');
    }
  });
});

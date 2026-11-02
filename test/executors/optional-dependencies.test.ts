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

  it('suggests the latest stable Codex SDK in the install command', () => {
    assert.throws(
      () => assertOptionalExecutorDependency('codex-sdk', () => false),
      /npm install @openai\/codex-sdk@latest/,
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
      assert.equal(dependency.installSpec, `${dependency.packageName}@latest`);
      assert.equal(peerRange, '>=0.165.0');
      assert.equal(packageJson.peerDependenciesMeta?.[dependency.packageName]?.optional, true);
      assert.equal(packageJson.dependencies?.[dependency.packageName], undefined);
      const developmentVersion = packageJson.devDependencies?.[dependency.packageName] ?? '';
      assert.match(developmentVersion, /^\d+\.\d+\.\d+$/);
      // 仅检查稳定版本下限；不再限制 minor，也不是通用 semver 解析器。
      const minimum = peerRange.slice(2).split('.').map(Number);
      const development = developmentVersion.split('.').map(Number);
      const difference = development.findIndex((part, index) => part !== minimum[index]);
      assert.ok(difference === -1 || development[difference] > minimum[difference],
        'The tested SDK must meet the public minimum version.');
    }
  });
});

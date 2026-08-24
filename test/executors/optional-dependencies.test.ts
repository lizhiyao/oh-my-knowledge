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
    assert.doesNotThrow(() => assertOptionalExecutorDependency('claude-sdk', (packageName) => {
      assert.equal(packageName, '@anthropic-ai/claude-agent-sdk');
      return true;
    }));
  });

  it('gives local and global install commands for a missing Claude SDK', () => {
    assert.throws(
      () => assertOptionalExecutorDependency('claude-sdk', () => false),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /当前 OMK 安装作用域中未找到/);
        assert.match(message, /npm install @anthropic-ai\/claude-agent-sdk@\^0\.3\.143/);
        assert.match(message, /npm install -g @anthropic-ai\/claude-agent-sdk@\^0\.3\.143/);
        return true;
      },
    );
  });

  it('uses the compatible Codex SDK patch range in the install command', () => {
    assert.throws(
      () => assertOptionalExecutorDependency('codex-sdk', () => false),
      /npm install @openai\/codex-sdk@\^0\.149\.0/,
    );
  });

  it('keeps SDKs out of production and development dependency closures', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    for (const executorName of ['claude-sdk', 'codex-sdk'] as const) {
      const dependency = getOptionalExecutorDependency(executorName)!;
      const peerRange = packageJson.peerDependencies?.[dependency.packageName];
      assert.equal(dependency.installSpec, `${dependency.packageName}@${peerRange}`);
      assert.equal(packageJson.peerDependenciesMeta?.[dependency.packageName]?.optional, true);
      assert.equal(packageJson.dependencies?.[dependency.packageName], undefined);
      assert.equal(packageJson.devDependencies?.[dependency.packageName], undefined);
    }
  });
});

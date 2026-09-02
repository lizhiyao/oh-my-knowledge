import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-core/fixtures/embedded-host.mjs',
);
const TYPESCRIPT_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-core/fixtures/embedded-host.ts.fixture',
);

describe('published embedded Evaluation Core API', () => {
  let projectRoot: string;
  let npmCache: string;

  beforeAll(() => {
    if (!existsSync(join(REPO_ROOT, 'dist/index.js'))) {
      throw new Error('缺少 dist/index.js；请先运行 yarn build。');
    }
    projectRoot = mkdtempSync(join(tmpdir(), 'omk-embedded-host-'));
    npmCache = join(projectRoot, 'npm-cache');
    mkdirSync(npmCache);
    const packageDirectory = join(projectRoot, 'node_modules/oh-my-knowledge');
    mkdirSync(packageDirectory, { recursive: true });
    const packOutput = execFileSync('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      projectRoot,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: npmCache },
    });
    const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }];
    execFileSync('tar', [
      '-xzf',
      join(projectRoot, basename(filename)),
      '--strip-components=1',
      '-C',
      packageDirectory,
    ]);
    const zodDirectory = dirname(realpathSync(join(REPO_ROOT, 'node_modules/zod/package.json')));
    symlinkSync(zodDirectory, join(projectRoot, 'node_modules/zod'), 'dir');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v1/execution-bundle.schema.json',
    ), 'utf8')).title).toBe('OMK Execution Bundle v1');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-workflows/inputs/contracts/schemas/v1/eval-sample-set.schema.json',
    ), 'utf8')).title).toBe('OMK Eval Sample Set v1');
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'independent-omk-host',
      private: true,
      type: 'module',
    }));
    copyFileSync(HOST_FIXTURE, join(projectRoot, 'host.mjs'));
    copyFileSync(TYPESCRIPT_HOST_FIXTURE, join(projectRoot, 'host.ts'));
    writeFileSync(join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['host.ts'],
    }));
    writeFileSync(join(projectRoot, 'host.cjs'), `
const assert = require('node:assert/strict');
(async () => {
  const api = await import('oh-my-knowledge');
  const advanced = await import('oh-my-knowledge/eval-core');
  const evalSamples = await import('oh-my-knowledge/eval-samples');
  const projections = await import('oh-my-knowledge/projections');
  const studio = await import('oh-my-knowledge/studio');
  assert.equal(typeof api.createEvaluationEngine, 'function');
  assert.equal(typeof api.digestCanonicalJson, 'function');
  assert.equal(api.createCoreStudioCatalog, undefined);
  assert.equal(api.projectCoreArtifactGraph, undefined);
  assert.equal(api.assessComparability, undefined);
  assert.equal(typeof advanced.assessComparability, 'function');
  assert.equal(evalSamples.EVAL_SAMPLE_SET_SCHEMA_VERSION, 'omk.eval-sample-set/v1');
  assert.equal(typeof evalSamples.resolveEvalSampleJsonSchema, 'function');
  assert.equal(typeof projections.projectCoreArtifactGraph, 'function');
  assert.equal(typeof studio.createCoreStudioCatalog, 'function');
  const schema = await import(
    'oh-my-knowledge/eval-core/schemas/v1/execution-bundle.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(schema.default.title, 'OMK Execution Bundle v1');
  const sampleSchema = await import(
    'oh-my-knowledge/eval-samples/schemas/v1/eval-sample-set.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(sampleSchema.default.title, 'OMK Eval Sample Set v1');
  try {
    require('oh-my-knowledge');
    throw new Error('require() unexpectedly loaded the ESM-only package root');
  } catch (error) {
    assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  }
  try {
    await import('oh-my-knowledge/dist/eval-core/contracts/index.js');
    throw new Error('deep dist import unexpectedly succeeded');
  } catch (error) {
    assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  }
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
`);
  }, 30_000);

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('NodeNext／ESM 宿主完成一键运行、分阶段复用、可比性与篡改拒绝', () => {
    const result = spawnSync(process.execPath, [join(projectRoot, 'host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
  });

  it('CommonJS 动态导入显式子路径，require 与 dist 深层导入均被拒绝', () => {
    const result = spawnSync(process.execPath, [join(projectRoot, 'host.cjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
  });

  it('不再提供旧 evaluation-core 子路径兼容层', () => {
    const retiredSubpath = ['oh-my-knowledge', 'evaluation-core'].join('/');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      try {
        await import(${JSON.stringify(retiredSubpath)});
        throw new Error('retired evaluation-core subpath unexpectedly loaded');
      } catch (error) {
        if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      }
    `], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
  });

  it('NodeNext TypeScript 宿主获得根入口与 advanced 子路径的边界声明', () => {
    const result = spawnSync(join(REPO_ROOT, 'node_modules/.bin/tsc'), [
      '--project', join(projectRoot, 'tsconfig.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
  });

  it('tarball 的包根声明只暴露稳定白名单', () => {
    const packageJson = JSON.parse(readFileSync(
      join(projectRoot, 'node_modules/oh-my-knowledge/package.json'),
      'utf8',
    )) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './dsh-plugin',
      './eval-core',
      './eval-core/schemas/v1/*',
      './eval-samples',
      './eval-samples/schemas/v1/*',
      './mcp',
      './package.json',
      './projections',
      './studio',
    ]);
  });
});

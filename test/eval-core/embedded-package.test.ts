import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const RUNTIME_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/embedded-host.mjs',
);
const RUBRIC_JUDGE_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/rubric-judge-host.mjs',
);
const CLEAN_ROOM_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/clean-room-host.mjs',
);
const STAGE_REUSE_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/stage-reuse-host.mjs',
);
const SERIES_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/series-host.mjs',
);
const RUNTIME_CONFORMANCE_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/runtime-conformance-host.mjs',
);
const ADVANCED_RUNTIME_HOST_FIXTURE = join(
  REPO_ROOT,
  'test/eval-runtime/fixtures/advanced-host.mjs',
);
const PUBLIC_RUNTIME_EXAMPLE = join(REPO_ROOT, 'examples/eval-runtime/run.mjs');

describe('published embedded Evaluation API', () => {
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
    const repositoryPackage = JSON.parse(readFileSync(
      join(REPO_ROOT, 'package.json'),
      'utf8',
    )) as { dependencies: Record<string, string> };
    for (const packageName of Object.keys(repositoryPackage.dependencies)) {
      const dependencyDirectory = dirname(realpathSync(join(
        REPO_ROOT,
        'node_modules',
        packageName,
        'package.json',
      )));
      const installedDirectory = join(projectRoot, 'node_modules', packageName);
      mkdirSync(dirname(installedDirectory), { recursive: true });
      symlinkSync(dependencyDirectory, installedDirectory, 'dir');
    }
    const nodeTypesDirectory = dirname(realpathSync(join(
      REPO_ROOT,
      'node_modules/@types/node/package.json',
    )));
    mkdirSync(join(projectRoot, 'node_modules/@types'), { recursive: true });
    symlinkSync(nodeTypesDirectory, join(projectRoot, 'node_modules/@types/node'), 'dir');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v1/execution-bundle.schema.json',
    ), 'utf8')).title).toBe('OMK Execution Bundle v1');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v2/analysis-bundle.schema.json',
    ), 'utf8')).title).toBe('OMK Analysis Bundle v2');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v2/comparability-assessment.schema.json',
    ), 'utf8')).$id).toContain('/schemas/eval-core/v2/comparability-assessment.schema.json');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v2/series-analysis-bundle.schema.json',
    ), 'utf8')).title).toBe('OMK Series Analysis Bundle v2');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v3/evaluation-definition.schema.json',
    ), 'utf8')).title).toBe('OMK Evaluation Definition v3');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v5/evaluation-definition.schema.json',
    ), 'utf8')).title).toBe('OMK Evaluation Definition v5');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v4/execution-plan.schema.json',
    ), 'utf8')).title).toBe('OMK Execution Plan v4');
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v5/run-plan.schema.json',
    ), 'utf8')).title).toBe('OMK Run Plan v5');
    expect(existsSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v1/comparability-assessment.schema.json',
    ))).toBe(true);
    expect(existsSync(join(
      packageDirectory,
      'dist/eval-core/contracts/schemas/v1/series-analysis-bundle.schema.json',
    ))).toBe(true);
    expect(JSON.parse(readFileSync(join(
      packageDirectory,
      'dist/eval-workflows/inputs/contracts/schemas/v2/eval-sample-set.schema.json',
    ), 'utf8')).title).toBe('OMK Eval Sample Set v2');
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'independent-omk-host',
      private: true,
      type: 'module',
    }));
    copyFileSync(HOST_FIXTURE, join(projectRoot, 'host.mjs'));
    copyFileSync(RUNTIME_HOST_FIXTURE, join(projectRoot, 'runtime-host.mjs'));
    copyFileSync(RUBRIC_JUDGE_HOST_FIXTURE, join(projectRoot, 'rubric-judge-host.mjs'));
    copyFileSync(CLEAN_ROOM_HOST_FIXTURE, join(projectRoot, 'clean-room-host.mjs'));
    copyFileSync(STAGE_REUSE_HOST_FIXTURE, join(projectRoot, 'stage-reuse-host.mjs'));
    copyFileSync(SERIES_HOST_FIXTURE, join(projectRoot, 'series-host.mjs'));
    copyFileSync(
      RUNTIME_CONFORMANCE_HOST_FIXTURE,
      join(projectRoot, 'runtime-conformance-host.mjs'),
    );
    copyFileSync(ADVANCED_RUNTIME_HOST_FIXTURE, join(projectRoot, 'advanced-runtime-host.mjs'));
    copyFileSync(PUBLIC_RUNTIME_EXAMPLE, join(projectRoot, 'public-runtime-example.mjs'));
    copyFileSync(join(REPO_ROOT, 'examples/eval-runtime/retrieval-abstention.mjs'), join(projectRoot, 'retrieval-abstention.mjs'));
    copyFileSync(join(REPO_ROOT, 'test/eval-runtime/fixtures/retrieval-abstention-host.mjs'), join(projectRoot, 'retrieval-abstention-host.mjs'));
    copyFileSync(TYPESCRIPT_HOST_FIXTURE, join(projectRoot, 'host.ts'));
    writeFileSync(join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
      },
      include: ['host.ts'],
    }));
    writeFileSync(join(projectRoot, 'host.cjs'), `
const assert = require('node:assert/strict');
(async () => {
  const api = await import('oh-my-knowledge');
  const advanced = await import('oh-my-knowledge/eval-core');
  const evalRuntime = await import('oh-my-knowledge/eval-runtime');
  const evalRuntimeAdvanced = await import('oh-my-knowledge/eval-runtime/advanced');
  const evalRuntimeContracts = await import('oh-my-knowledge/eval-runtime/contracts');
  const evalSamples = await import('oh-my-knowledge/eval-samples');
  const projections = await import('oh-my-knowledge/projections');
  const studio = await import('oh-my-knowledge/studio');
  const mcp = await import('oh-my-knowledge/mcp');
  const dshPlugin = await import('oh-my-knowledge/dsh-plugin');
  assert.deepEqual(Object.keys(api).sort(), Object.keys(evalRuntime).sort());
  assert.equal(typeof api.evaluate, 'function');
  assert.equal(typeof api.evaluateSeries, 'function');
  assert.equal(typeof api.prepareEvaluationSeries, 'function');
  assert.equal(typeof api.rescore, 'function');
  assert.equal(typeof api.reanalyze, 'function');
  assert.equal(typeof api.redecide, 'function');
  assert.equal(typeof api.checkContentStore, 'function');
  assert.equal(typeof api.checkExecutor, 'function');
  assert.equal(typeof api.checkRuntime, 'function');
  assert.equal(api.RUNTIME_CHECK_RESULT_SCHEMA_VERSION, 'omk.runtime-check-result/v1');
  assert.equal(api.createEvaluationEngine, undefined);
  assert.equal(api.digestCanonicalJson, undefined);
  assert.equal(api.createCoreStudioCatalog, undefined);
  assert.equal(api.projectCoreArtifactGraph, undefined);
  assert.equal(typeof api.assessComparability, 'function');
  assert.equal(typeof advanced.assessComparability, 'function');
  assert.equal(typeof evalRuntime.evaluate, 'function');
  assert.equal(typeof evalRuntime.evaluateSeries, 'function');
  assert.equal(typeof evalRuntime.prepareEvaluationSeries, 'function');
  assert.equal(typeof evalRuntime.rescore, 'function');
  assert.equal(typeof evalRuntime.reanalyze, 'function');
  assert.equal(typeof evalRuntime.redecide, 'function');
  assert.equal(typeof evalRuntime.checkContentStore, 'function');
  assert.equal(typeof evalRuntime.checkExecutor, 'function');
  assert.equal(typeof evalRuntime.checkRuntime, 'function');
  assert.equal(evalRuntime.RUNTIME_CHECK_RESULT_SCHEMA_VERSION, 'omk.runtime-check-result/v1');
  assert.equal(evalRuntime.createExecutorFnAdapter, undefined);
  assert.equal(evalRuntime.createJsonExecutorAdapter, undefined);
  assert.equal(evalRuntime.createRubricJudgeKit, undefined);
  assert.equal(evalRuntime.runEvaluation, undefined);
  assert.equal(typeof evalRuntimeAdvanced.createEvaluationRuntime, 'function');
  assert.equal(typeof evalRuntimeAdvanced.createJsonExecutorAdapter, 'function');
  assert.equal(typeof evalRuntimeAdvanced.createRubricJudgeKit, 'function');
  assert.equal(typeof evalRuntimeAdvanced.runEvaluation, 'function');
  assert.equal(typeof evalRuntimeAdvanced.createExecutorFnAdapter, 'function');
  assert.equal(typeof evalRuntimeAdvanced.createSameProcessExecutorAdapter, 'function');
  assert.equal(typeof evalRuntimeContracts.SourceNeutralTraceSchema.safeParse, 'function');
  assert.equal(evalSamples.EVAL_SAMPLE_SET_SCHEMA_VERSION, 'omk.eval-sample-set/v2');
  assert.equal(typeof evalSamples.resolveEvalSampleJsonSchema, 'function');
  assert.equal(typeof projections.projectCoreArtifactGraph, 'function');
  assert.equal(typeof studio.createCoreStudioCatalog, 'function');
  assert.equal(typeof mcp.createObservationMcpServer, 'function');
  assert.equal(mcp.LOCAL_OBSERVATION_PRINCIPAL.principalId, 'local-user');
  assert.equal(dshPlugin.name, 'omk-dsh-plugin');
  assert.equal(typeof dshPlugin.apply, 'function');
  const schema = await import(
    'oh-my-knowledge/eval-core/schemas/v1/execution-bundle.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(schema.default.title, 'OMK Execution Bundle v1');
  const analysisSchema = await import(
    'oh-my-knowledge/eval-core/schemas/v2/analysis-bundle.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(analysisSchema.default.title, 'OMK Analysis Bundle v2');
  const definitionSchema = await import(
    'oh-my-knowledge/eval-core/schemas/v3/evaluation-definition.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(definitionSchema.default.title, 'OMK Evaluation Definition v3');
  const activeDefinitionSchema = await import(
    'oh-my-knowledge/eval-core/schemas/v5/evaluation-definition.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(activeDefinitionSchema.default.title, 'OMK Evaluation Definition v5');
  const executionPlanSchema = await import(
    'oh-my-knowledge/eval-core/schemas/v4/execution-plan.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(executionPlanSchema.default.title, 'OMK Execution Plan v4');
  const sampleSchema = await import(
    'oh-my-knowledge/eval-samples/schemas/v2/eval-sample-set.schema.json',
    { with: { type: 'json' } }
  );
  assert.equal(sampleSchema.default.title, 'OMK Eval Sample Set v2');
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
  try {
    await import('oh-my-knowledge/eval-runtime/adapters/json-executor');
    throw new Error('eval-runtime deep import unexpectedly succeeded');
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

  it('NodeNext／ESM Core 宿主完成一键运行、分阶段复用、可比性与篡改拒绝', () => {
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

  it('独立 Node.js ESM 宿主通过包根 Runtime façade 完成双 Target 对比', () => {
    const isolatedHome = join(projectRoot, 'runtime-home');
    const isolatedConfig = join(projectRoot, 'runtime-config');
    const isolatedCache = join(projectRoot, 'runtime-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'runtime-host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('公开最小示例可从 tarball 独立运行且不写用户状态', () => {
    const isolatedHome = join(projectRoot, 'public-example-home');
    const isolatedConfig = join(projectRoot, 'public-example-config');
    const isolatedCache = join(projectRoot, 'public-example-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'public-runtime-example.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      runStatus: 'completed',
      estimate: 1 / 3,
      decisionStatus: 'decided',
      verdict: 'NOISE',
      datasetId: 'embedded-service-example',
    });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('tarball 公开入口支持内置弃答评分与宿主排除审计', () => {
    // A separate process proves published package imports work outside the source tree.
    const result = spawnSync(process.execPath, [join(projectRoot, 'retrieval-abstention-host.mjs')], {
      cwd: projectRoot, encoding: 'utf8', timeout: 30_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const output = JSON.parse(result.stdout);
    expect(output.audit).toMatchObject({
      positiveCount: 1, abstentionCount: 1, pendingCount: 1, excluded: [{ sampleId: 'pending', reason: 'pending-human-annotation' }],
    });
    expect(output.metrics['correct-abstention']).toMatchObject({
      value: 1, coverage: { planned: 1, included: 1, missing: 0, sourceUnavailable: 0 },
    });
    expect(output.metrics['false-abstention']).toMatchObject({ value: 0, coverage: { planned: 1, included: 1, missing: 0, sourceUnavailable: 0 } });
    expect(output.metrics['forbidden-hit']).toMatchObject({ value: 0, coverage: { included: 2 } });
    expect(output.metrics['precision-at-3']).toMatchObject({
      value: 1 / 3, coverage: { included: 1 },
    });
  });

  it('tarball clean-room 覆盖事件、失败、取消、telemetry 与生命周期契约', () => {
    const isolatedHome = join(projectRoot, 'clean-room-home');
    const isolatedConfig = join(projectRoot, 'clean-room-config');
    const isolatedCache = join(projectRoot, 'clean-room-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'clean-room-host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('tarball clean-room 通过包根复用已认证阶段且不重跑 Target', () => {
    const isolatedHome = join(projectRoot, 'stage-reuse-home');
    const isolatedConfig = join(projectRoot, 'stage-reuse-config');
    const isolatedCache = join(projectRoot, 'stage-reuse-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'stage-reuse-host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('tarball clean-room 通过包根与 Runtime 子路径运行固定设计 Series', () => {
    const isolatedHome = join(projectRoot, 'series-home');
    const isolatedConfig = join(projectRoot, 'series-config');
    const isolatedCache = join(projectRoot, 'series-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'series-host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('tarball clean-room 通过包根与 Runtime 子路径检查全部公开 Runtime 组件', () => {
    const isolatedHome = join(projectRoot, 'runtime-conformance-home');
    const isolatedConfig = join(projectRoot, 'runtime-conformance-config');
    const isolatedCache = join(projectRoot, 'runtime-conformance-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [
      join(projectRoot, 'runtime-conformance-host.mjs'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('独立 FaaS 宿主只注入一次模型调用 Port 即可运行公共 Rubric Judge', () => {
    const isolatedHome = join(projectRoot, 'rubric-home');
    const isolatedConfig = join(projectRoot, 'rubric-config');
    const isolatedCache = join(projectRoot, 'rubric-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'rubric-judge-host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
  });

  it('独立高级宿主复用 eval-runtime 装配并显式完成五阶段运行', () => {
    const isolatedHome = join(projectRoot, 'advanced-runtime-home');
    const isolatedConfig = join(projectRoot, 'advanced-runtime-config');
    const isolatedCache = join(projectRoot, 'advanced-runtime-cache');
    for (const directory of [isolatedHome, isolatedConfig, isolatedCache]) mkdirSync(directory);
    const result = spawnSync(process.execPath, [join(projectRoot, 'advanced-runtime-host.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
      },
    });
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
    expect([
      ...readdirSync(isolatedHome),
      ...readdirSync(isolatedConfig),
      ...readdirSync(isolatedCache),
    ]).toEqual([]);
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

  it('NodeNext TypeScript 宿主获得全部公开代码入口的边界声明', () => {
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
      './eval-core/schemas/v2/*',
      './eval-core/schemas/v3/*',
      './eval-core/schemas/v4/*',
      './eval-core/schemas/v5/*',
      './eval-runtime',
      './eval-runtime/advanced',
      './eval-runtime/contracts',
      './eval-samples',
      './eval-samples/schemas/v2/*',
      './mcp',
      './package.json',
      './projections',
      './studio',
    ]);
  });
});

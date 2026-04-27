import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDependencies,
  checkDependencies,
  preflightDependencies,
  formatDependencyErrors,
} from '../src/eval-core/dependency-checker.js';
import type { Sample } from '../src/types/index.js';

const tmp = () => join(tmpdir(), `omk-dep-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

describe('extractDependencies', () => {
  it('从 skill 内容提取 CLI 工具', () => {
    const skill = `第三步：初始化 session：export FOO_SESSION=$(foo-cli session init) FOO_LOG=1`;
    const deps = extractDependencies([skill], []);
    assert.ok(deps.tools?.includes('foo-cli'));
  });

  it('从 skill 内容提取文件引用', () => {
    const skill = `第二步：Read 对应的 scripts/page/physicalPage/commands.md 文档`;
    const deps = extractDependencies([skill], []);
    assert.ok(deps.files?.includes('scripts/page/physicalPage/commands.md'));
  });

  it('从 skill 内容提取环境变量引用', () => {
    const skill = `需要设置 $FOO_TOKEN 和 \${FOO_SECRET} 才能使用`;
    const deps = extractDependencies([skill], []);
    assert.ok(deps.env?.includes('FOO_TOKEN'));
    assert.ok(deps.env?.includes('FOO_SECRET'));
  });

  it('赋值语句中的变量名不提取为依赖', () => {
    // "export FOO=bar" 中 FOO 是赋值目标，不是 $FOO 引用
    const skill = `export FOO_SESSION=$(foo-cli session init) FOO_LOG=1`;
    const deps = extractDependencies([skill], []);
    // 应该提取 foo-cli 工具，但不提取 FOO_SESSION/FOO_LOG 作为环境变量
    assert.ok(deps.tools?.includes('foo-cli'));
    assert.ok(!deps.env?.includes('FOO_SESSION'));
    assert.ok(!deps.env?.includes('FOO_LOG'));
  });

  it('排除常见系统环境变量', () => {
    const skill = `cd $HOME && use $PATH and $NODE_ENV`;
    const deps = extractDependencies([skill], []);
    assert.equal(deps.env, undefined);
  });

  it('从 sample assertions 提取 CLI 工具', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: '测试',
      assertions: [
        { type: 'contains', value: 'FOO_SESSION=$(foo-cli session init)' },
      ],
    }];
    const deps = extractDependencies([], samples);
    assert.ok(deps.tools?.includes('foo-cli'));
  });

  it('不从 assertions 提取文件路径（避免误报）', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: '测试',
      assertions: [
        { type: 'contains', value: 'physicalPage/commands.md' },
      ],
    }];
    const deps = extractDependencies([], samples);
    // assertions 中的文件路径不提取（太短或太模糊容易误报）
    assert.equal(deps.files, undefined);
  });

  it('多个 skill 内容合并去重', () => {
    const skill1 = `使用 foo-cli 初始化`;
    const skill2 = `使用 foo-cli 查询`;
    const deps = extractDependencies([skill1, skill2], []);
    assert.equal(deps.tools?.filter((t) => t === 'foo-cli').length, 1);
  });

  it('无依赖时返回 undefined 字段', () => {
    const deps = extractDependencies(['这是一个纯文本 skill，没有外部依赖'], []);
    assert.equal(deps.tools, undefined);
    assert.equal(deps.files, undefined);
    assert.equal(deps.env, undefined);
  });
});

describe('checkDependencies', () => {
  it('node 工具应该存在', async () => {
    const result = await checkDependencies({ tools: ['node'] }, process.cwd());
    assert.ok(result.ok);
    assert.equal(result.missing.length, 0);
  });

  it('不存在的工具应该报错', async () => {
    const result = await checkDependencies({ tools: ['definitely-nonexistent-cli-tool-xyz'] }, process.cwd());
    assert.ok(!result.ok);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].category, 'tool');
    assert.equal(result.missing[0].name, 'definitely-nonexistent-cli-tool-xyz');
  });

  it('存在的文件应该通过', async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, 'content');
    try {
      const result = await checkDependencies({ files: ['test.md'] }, dir);
      assert.ok(result.ok);
    } finally {
      unlinkSync(filePath);
    }
  });

  it('不存在的文件应该报错', async () => {
    const result = await checkDependencies({ files: ['nonexistent/path/file.md'] }, process.cwd());
    assert.ok(!result.ok);
    assert.equal(result.missing[0].category, 'file');
  });

  it('已设置的环境变量应该通过', async () => {
    // PATH is always set
    const result = await checkDependencies({ env: ['PATH'] }, process.cwd());
    assert.ok(result.ok);
  });

  it('未设置的环境变量应该报错', async () => {
    const result = await checkDependencies({ env: ['DEFINITELY_NONEXISTENT_ENV_VAR_XYZ'] }, process.cwd());
    assert.ok(!result.ok);
    assert.equal(result.missing[0].category, 'env');
  });

  it('混合检查：多类失败', async () => {
    const result = await checkDependencies({
      tools: ['nonexistent-cli-xyz'],
      files: ['no-such-file.md'],
      env: ['NO_SUCH_ENV_XYZ'],
    }, process.cwd());
    assert.ok(!result.ok);
    assert.equal(result.missing.length, 3);
    const categories = result.missing.map((m) => m.category);
    assert.ok(categories.includes('tool'));
    assert.ok(categories.includes('file'));
    assert.ok(categories.includes('env'));
  });

  it('空依赖应该通过', async () => {
    const result = await checkDependencies({}, process.cwd());
    assert.ok(result.ok);
  });
});

describe('preflightDependencies', () => {
  it('自动提取 + 显式声明合并', async () => {
    const skill = `使用 foo-cli 进行操作`;
    const explicit = { tools: ['another-cli'] };
    const result = await preflightDependencies([skill], [], process.cwd(), explicit);
    // Both tools should be missing (neither installed)
    assert.ok(!result.ok);
    const names = result.missing.map((m) => m.name);
    assert.ok(names.includes('foo-cli'));
    assert.ok(names.includes('another-cli'));
  });

  it('无依赖时通过', async () => {
    const result = await preflightDependencies(['纯文本 skill'], [], process.cwd());
    assert.ok(result.ok);
  });
});

describe('formatDependencyErrors', () => {
  it('格式化输出包含分类标题和提示', () => {
    const output = formatDependencyErrors([
      { category: 'tool', name: 'foo-cli', hint: '未找到，请确认已安装并在 PATH 中' },
      { category: 'file', name: 'scripts/commands.md', hint: '文件不存在' },
      { category: 'env', name: 'FOO_TOKEN', hint: '未设置' },
    ]);
    assert.ok(output.includes('工具缺失'));
    assert.ok(output.includes('foo-cli'));
    assert.ok(output.includes('文件缺失'));
    assert.ok(output.includes('scripts/commands.md'));
    assert.ok(output.includes('环境变量缺失'));
    assert.ok(output.includes('FOO_TOKEN'));
    assert.ok(output.includes('--skip-preflight'));
  });
});

describe('loadSamples 对象包装格式', async () => {
  const { loadSamples } = await import('../src/inputs/load-samples.js');
  const cleanups: string[] = [];

  it('支持 { requires, samples } 格式', () => {
    const p = join(tmpdir(), `omk-dep-wrapper-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, JSON.stringify({
      requires: { tools: ['foo-cli'], env: ['FOO_TOKEN'] },
      samples: [{ sample_id: 's1', prompt: '测试' }],
    }));
    const result = loadSamples(p);
    assert.equal(result.samples.length, 1);
    assert.deepEqual(result.requires?.tools, ['foo-cli']);
    assert.deepEqual(result.requires?.env, ['FOO_TOKEN']);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('数组格式向后兼容（无 requires）', () => {
    const p = join(tmpdir(), `omk-dep-array-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([{ sample_id: 's1', prompt: '测试' }]));
    const result = loadSamples(p);
    assert.equal(result.samples.length, 1);
    assert.equal(result.requires, undefined);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });
});

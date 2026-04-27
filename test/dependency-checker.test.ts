import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDependencies,
  extractFilesByBase,
  checkDependencies,
  preflightDependencies,
  formatDependencyErrors,
} from '../src/eval-core/dependency-checker.js';
import type { Artifact, Sample } from '../src/types/index.js';

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

  it('directory-skill 的相对路径锚到 skillRoot,不会撞到全局 cwd', async () => {
    // 模拟两个 directory-skill 各自在自己根目录下有 assets/foo.md
    // bug-fix 之前:用单一 cwd 找 assets/foo.md,只能找到一个或全找不到
    // bug-fix 之后:每个 skill 的引用按各自 skillRoot 解析
    const root = tmp();
    mkdirSync(join(root, 'skill-a'), { recursive: true });
    mkdirSync(join(root, 'skill-b'), { recursive: true });
    writeFileSync(join(root, 'skill-a', 'assets-a-only.md'), 'a');
    writeFileSync(join(root, 'skill-b', 'assets-b-only.md'), 'b');

    try {
      const artifacts: Artifact[] = [
        {
          name: 'skill-a', kind: 'skill', source: 'variant-name',
          content: '查看 assets-a-only.md',
          locator: join(root, 'skill-a', 'SKILL.md'),
          skillRoot: join(root, 'skill-a'),
        },
        {
          name: 'skill-b', kind: 'skill', source: 'variant-name',
          content: '查看 assets-b-only.md',
          locator: join(root, 'skill-b', 'SKILL.md'),
          skillRoot: join(root, 'skill-b'),
        },
      ];
      const skillContents = artifacts.map((a) => a.content!);
      // 全局 cwd 设为 root,两个 skill 在 root 下都找不到 assets-a-only.md / assets-b-only.md
      // 但分别按 skillRoot 解析就都能找到
      const result = await preflightDependencies(skillContents, [], root, undefined, artifacts);
      assert.ok(result.ok, `应通过,但 missing=${JSON.stringify(result.missing)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('directory-skill 引用的文件不存在时仍报错(并标出正确的 baseDir)', async () => {
    const root = tmp();
    mkdirSync(join(root, 'skill-a'), { recursive: true });
    try {
      const artifacts: Artifact[] = [
        {
          name: 'skill-a', kind: 'skill', source: 'variant-name',
          content: '需要读 assets/missing.md',
          locator: join(root, 'skill-a', 'SKILL.md'),
          skillRoot: join(root, 'skill-a'),
        },
      ];
      const result = await preflightDependencies(['需要读 assets/missing.md'], [], root, undefined, artifacts);
      assert.ok(!result.ok);
      const fileIssue = result.missing.find((m) => m.category === 'file' && m.name.includes('missing.md'));
      assert.ok(fileIssue, '应报告 missing.md 文件缺失');
      assert.ok(fileIssue!.hint.includes(join(root, 'skill-a')), `hint 应含 skillRoot 路径,实际:${fileIssue!.hint}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractFilesByBase', () => {
  it('每个 artifact 按各自 skillRoot 分桶', () => {
    const artifacts: Artifact[] = [
      { name: 'a', kind: 'skill', source: 'variant-name', content: '看 docs/a.md', skillRoot: '/root/a' },
      { name: 'b', kind: 'skill', source: 'variant-name', content: '看 docs/b.md', skillRoot: '/root/b' },
    ];
    const map = extractFilesByBase(artifacts, '/default/cwd');
    assert.equal(map.size, 2);
    assert.ok(map.get('/root/a')?.has('docs/a.md'));
    assert.ok(map.get('/root/b')?.has('docs/b.md'));
  });

  it('无 skillRoot 的 artifact 落到 defaultCwd', () => {
    const artifacts: Artifact[] = [
      { name: 'a', kind: 'skill', source: 'variant-name', content: '看 docs/a.md' },
    ];
    const map = extractFilesByBase(artifacts, '/default/cwd');
    assert.ok(map.get('/default/cwd')?.has('docs/a.md'));
  });

  it('artifact.cwd 优先于 defaultCwd(但低于 skillRoot)', () => {
    const artifacts: Artifact[] = [
      { name: 'a', kind: 'skill', source: 'variant-name', content: '看 docs/a.md', cwd: '/explicit' },
    ];
    const map = extractFilesByBase(artifacts, '/default/cwd');
    assert.ok(map.get('/explicit')?.has('docs/a.md'));
    assert.equal(map.get('/default/cwd'), undefined);
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

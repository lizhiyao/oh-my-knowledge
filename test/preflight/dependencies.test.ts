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
} from '../../src/preflight/dependencies.js';
import type { Artifact } from '../../src/knowledge-artifacts/contracts.js';
import {
  type EvalSampleSetDocument,
  type Sample,
} from '../../src/inputs/contracts/sample.js';
import { createEvalSampleSetDocument } from '../../src/inputs/schemas/sample-set.js';

const tmp = () => join(tmpdir(), `omk-dep-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
const sampleSetJson = (
  samples: Sample[],
  requires?: EvalSampleSetDocument['requires'],
): string => JSON.stringify(createEvalSampleSetDocument(samples, requires));

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

  it('排除 Agent Skills 运行时提供的 SKILL_ROOT 占位符', () => {
    const skill = `读取 \${SKILL_ROOT}/references/tracing.md，上传时使用 $SENTRY_AUTH_TOKEN`;
    const deps = extractDependencies([skill], []);
    assert.ok(!deps.env?.includes('SKILL_ROOT'));
    assert.ok(deps.env?.includes('SENTRY_AUTH_TOKEN'));
  });

  it('不把允许失败的项目探测命令中的候选路径视为硬依赖', () => {
    const skill = [
      'ls app.json src/app.js src/app.ts 2>/dev/null',
      'cat src/optional/config.ts || true',
      '请读取 references/tracing.md 后再配置。',
    ].join('\n');
    const deps = extractDependencies([skill], []);
    assert.ok(!deps.files?.includes('src/app.js'));
    assert.ok(!deps.files?.includes('src/app.ts'));
    assert.ok(!deps.files?.includes('src/optional/config.ts'));
    assert.ok(deps.files?.includes('references/tracing.md'));
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
      assert.equal(fileIssue!.reasonCode, 'file_not_found');
      assert.equal(fileIssue!.reasonDetail, join(root, 'skill-a'),
        `reasonDetail 应是 skillRoot 路径,实际:${fileIssue!.reasonDetail}`);
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

describe('loadSamples 版本化对象格式', async () => {
  const { loadSamples } = await import('../../src/inputs/load-samples.js');
  const cleanups: string[] = [];

  it('支持 { schemaVersion, requires, samples } 格式', () => {
    const p = join(tmpdir(), `omk-dep-wrapper-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson(
      [{ sample_id: 's1', prompt: '测试' }],
      { tools: ['foo-cli'], env: ['FOO_TOKEN'] },
    ));
    const result = loadSamples(p);
    assert.equal(result.samples.length, 1);
    assert.deepEqual(result.requires?.tools, ['foo-cli']);
    assert.deepEqual(result.requires?.env, ['FOO_TOKEN']);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('无 requires 时保持未声明状态', () => {
    const p = join(tmpdir(), `omk-dep-array-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{ sample_id: 's1', prompt: '测试' }]));
    const result = loadSamples(p);
    assert.equal(result.samples.length, 1);
    assert.equal(result.requires, undefined);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('拒绝 tools_not_called values 为空数组', () => {
    const p = join(tmpdir(), `omk-noise-assertion-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'tools_not_called', values: [], weight: 0 }],
    }]));
    assert.throws(() => loadSamples(p), /tools_not_called.*非空/);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('拒绝 tools_called values 缺失', () => {
    const p = join(tmpdir(), `omk-noise-assertion-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'tools_called', weight: 1 }],
    }]));
    assert.throws(() => loadSamples(p), /tools_called.*非空/);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('拒绝 tool_input_not_contains 缺 Tool: 前缀', () => {
    const p = join(tmpdir(), `omk-bad-value-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'tool_input_not_contains', value: '--force', weight: 1 }],
    }]));
    assert.throws(() => loadSamples(p), /Tool:needle/);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('拒绝 tool_input_contains 冒号位置在末尾', () => {
    const p = join(tmpdir(), `omk-bad-value-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'tool_input_contains', value: 'Bash:', weight: 1 }],
    }]));
    assert.throws(() => loadSamples(p), /Tool:needle/);
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  // Strict-mode helper: vitest config sets OMK_LENIENT_ASSERTIONS=1 globally
  // (so historical fixtures keep loading), but these rule A loader tests need
  // to verify the strict-throw path. Save/restore env around the assertion.
  const withStrict = (fn: () => void): void => {
    const orig = process.env.OMK_LENIENT_ASSERTIONS;
    delete process.env.OMK_LENIENT_ASSERTIONS;
    try { fn(); }
    finally {
      if (orig === undefined) delete process.env.OMK_LENIENT_ASSERTIONS;
      else process.env.OMK_LENIENT_ASSERTIONS = orig;
    }
  };

  it('rule A loader (strict): 拒绝 contains 含 CJK 字符', () => {
    const p = join(tmpdir(), `omk-cjk-value-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'contains', value: '留档', weight: 1 }],
    }]));
    withStrict(() => assert.throws(() => loadSamples(p), /CJK|全角/));
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('rule A loader (strict): 拒绝 contains_any 数组中含全角标点元素', () => {
    const p = join(tmpdir(), `omk-fw-value-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'contains_any', values: ['ECONNREFUSED', '【失败】'], weight: 1 }],
    }]));
    withStrict(() => assert.throws(() => loadSamples(p), /CJK|全角|contains_any/));
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('rule A loader (strict): 拒绝 contains 含内部空格的短语', () => {
    const p = join(tmpdir(), `omk-phrase-value-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'contains', value: 'task completed', weight: 1 }],
    }]));
    withStrict(() => assert.throws(() => loadSamples(p), /空白|whitespace|short(er|ened)|内部/i));
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('rule A loader: 接受 ASCII token-style contains (in any mode)', () => {
    const p = join(tmpdir(), `omk-ok-value-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'contains', value: 'ECONNREFUSED', weight: 1 },
        { type: 'contains', value: 'skylark_doc_create', weight: 1 },
        { type: 'contains_any', values: ['x-trace-id', 'request-id'], weight: 1 },
      ],
    }]));
    withStrict(() => {
      const r = loadSamples(p);
      assert.equal(r.samples.length, 1);
      assert.equal(r.samples[0].assertions?.length, 3);
    });
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('rule A loader: lenient mode (OMK_LENIENT_ASSERTIONS=1) downgrades throws to stderr warn', () => {
    const p = join(tmpdir(), `omk-lenient-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [
        { type: 'contains', value: '留档', weight: 1 }, // would throw in strict mode
        { type: 'contains', value: 'OK_TOKEN', weight: 1 },
      ],
    }]));
    const orig = process.env.OMK_LENIENT_ASSERTIONS;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
      captured += s;
      return true;
    };
    try {
      process.env.OMK_LENIENT_ASSERTIONS = '1';
      const r = loadSamples(p);
      // 数据透传(不 strip,因为 loader 没改 sample,只 warn 给用户看);assertion 数应保留原样。
      // 反而 generator boundary 的 sanitize 是 strip;loader 不动 sample 内容,只是宣告校验状态。
      assert.equal(r.samples.length, 1);
      assert.equal(r.samples[0].assertions?.length, 2, 'lenient mode keeps violating assertion in place');
      assert.ok(captured.includes('lenient') || captured.includes('LENIENT') || captured.includes('CJK'),
        'stderr should mention the violation: ' + JSON.stringify(captured).slice(0,200));
    } finally {
      (process.stderr as unknown as { write: (s: string) => boolean }).write = origStderrWrite;
      if (orig === undefined) delete process.env.OMK_LENIENT_ASSERTIONS;
      else process.env.OMK_LENIENT_ASSERTIONS = orig;
    }
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });

  it('rule A loader (strict): 拒绝 regex pattern 含 CJK', () => {
    const p = join(tmpdir(), `omk-regex-cjk-${Date.now()}.json`);
    cleanups.push(p);
    writeFileSync(p, sampleSetJson([{
      sample_id: 's1', prompt: 'p',
      assertions: [{ type: 'regex', pattern: '风险等级:\\s*(高|中|低)', weight: 1 }],
    }]));
    withStrict(() => assert.throws(() => loadSamples(p), /CJK|regex/i));
    for (const f of cleanups) { try { unlinkSync(f); } catch {} }
    cleanups.length = 0;
  });
});

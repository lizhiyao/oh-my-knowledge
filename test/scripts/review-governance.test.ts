import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { testDirectory } from '../helpers/temp-directory.js';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('autonomous review governance', () => {
  it('keeps local Markdown links in repository rules resolvable', () => {
    for (const path of [
      'AGENTS.md', 'CLAUDE.md', 'CODE_REVIEW.md', 'CONTRIBUTING.md',
      'PRODUCT.md', 'SECURITY.md', 'schemas/README.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
    ]) {
      for (const match of read(path).matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1].split(/[?#]/)[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const file = resolve(dirname(join(root, path)), decodeURIComponent(target));
        expect(existsSync(file), `${path} -> ${target}`).toBe(true);
      }
    }
  });

  it('keeps the cross-agent entrypoints connected to the review playbook', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('## 自主 CR 与完成定义');
    expect(agents).toContain('## Code Review Rules');
    expect(agents).toContain('必须完整阅读 [`CODE_REVIEW.md`](./CODE_REVIEW.md)');
    expect(agents).toContain('### CR 运行产物隔离');
    expect(agents).toContain('CR 工具产物不得写入源码工作树');
    expect(agents).toContain('artifacts/cr/');
    expect(agents).toContain('knowledge/cr/');
    expect(Buffer.byteLength(agents, 'utf8')).toBeLessThan(32 * 1024);
    expect(agents).toContain('帮助人和 Agent 沉淀、维护并复用有价值的知识');
    expect(agents).toContain('区分产品意图、当前实现、已发布能力与历史记录');
    expect(read('CLAUDE.md')).toContain('@AGENTS.md');
    expect(read('CONTRIBUTING.md')).toContain('[`CODE_REVIEW.md`](./CODE_REVIEW.md)');
    const playbook = read('CODE_REVIEW.md');
    expect(playbook).toContain('CR 工具产物必须与源码工作树隔离');
    expect(playbook).toContain('`mktemp -d`');
    expect(playbook).toContain('只有所用工具实际需要写盘时');
    expect(playbook).toContain('不得用 `.gitignore` 掩盖工具写入');
    expect(agents).toContain('PR 边界在开工划分工作时就确定');
    expect(playbook).toContain('### 2. 实现中保持可审查');
  });

  it('keeps official Skill routing and result guidance aligned with execution boundaries', () => {
    const skill = read('.agents/skills/omk/SKILL.md');
    const intent = skill.indexOf('## 第一步：理解用户意图');
    const environment = skill.indexOf('## 第二步：检查所选操作的环境');
    expect(intent).toBeGreaterThan(-1);
    expect(environment).toBeGreaterThan(intent);
    const discussion = skill.split('## 纯讨论与只读核对\n')[1]?.split('\n## ')[0];
    expect(discussion).toContain('不运行 `which omk`');
    expect(discussion).toContain('不扫描评测项目');
    const results = skill.split('## 第五步：解读结果\n')[1]?.split('\n## ')[0];
    for (const boundary of [
      'decision.decisionStatus', 'gate.gateStatus', 'release-gates-passed',
      'solo-layer-gate-passed', 'UNDERPOWERED', '发布授权',
    ]) expect(results).toContain(boundary);
    expect(results).not.toContain('跑完会自动启动 studio 并输出 JSON');
  });

  it('keeps domain-specific review rules close to the code they govern', () => {
    for (const path of [
      'src/eval-core/AGENTS.md',
      'src/eval-workflows/AGENTS.md',
      'src/observe/AGENTS.md',
      'src/cli/AGENTS.md',
      'src/studio/AGENTS.md',
    ]) {
      const instructions = read(path);
      expect(instructions).toContain('补充仓库根 `AGENTS.md`');
      expect(instructions).toContain('## Code Review Rules');
    }
  });

  it('keeps the pull request template aligned with the review completion contract', () => {
    const template = read('.github/PULL_REQUEST_TEMPLATE.md');
    expect(template).toContain('AGENTS.md');
    expect(template).toContain('CODE_REVIEW.md');
    expect(template).not.toMatch(/read\s+CLAUDE\.md/i);
    for (const heading of [
      '## 用户影响',
      '## 迁移／兼容决策',
      '## 测量学影响',
      '## 自主 CR',
      '## 验证',
      '## 未解决风险',
    ]) {
      expect(template).toContain(heading);
    }
  });

  it('discovers new official Skill files without exposing personal Agent data or ignored secrets', () => {
    const directory = testDirectory('omk-official-skill-ignore-');
    const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    writeFileSync(join(directory, '.gitignore'), read('.gitignore'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, env });
    const official = [
      '.agents/skills/omk/SKILL.md', '.agents/skills/omk/references/new/deep/reference.md',
      '.agents/skills/omk/assets/new-template.json', '.agents/skills/omk/.env.example',
    ];
    const privatePaths = [
      '.agents/config.toml', '.agents/hooks/local.sh', '.agents/skills/private/SKILL.md',
      '.agents/skills/omk-private/SKILL.md', '.codex/config.toml',
      '.agents/skills/omk/.env', '.agents/skills/omk/assets/credentials.json',
      '.agents/skills/omk/node_modules/local/index.js',
    ];
    const result = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: directory, env, encoding: 'utf8', input: [...official, ...privatePaths].join('\0') + '\0',
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout.split('\0').filter(Boolean).sort()).toEqual([...privatePaths].sort());
  });

  it('keeps generated CR state outside the repository', () => {
    for (const path of ['artifacts/cr', 'knowledge/cr']) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });
});

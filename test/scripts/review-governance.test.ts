import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('autonomous review governance', () => {
  it('keeps the cross-agent entrypoints connected to the review playbook', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('## 自主 CR 与完成定义');
    expect(agents).toContain('## Code Review Rules');
    expect(agents).toContain('必须完整阅读 [`CODE_REVIEW.md`](./CODE_REVIEW.md)');
    expect(agents).toContain('### CR 运行产物隔离');
    expect(agents).toContain('不得在仓库内创建或保留');
    expect(agents).toContain('不得执行回写仓库的结果同步');
    expect(Buffer.byteLength(agents, 'utf8')).toBeLessThan(32 * 1024);
    expect(read('CLAUDE.md')).toContain('@AGENTS.md');
    expect(read('CONTRIBUTING.md')).toContain('[`CODE_REVIEW.md`](./CODE_REVIEW.md)');
    const playbook = read('CODE_REVIEW.md');
    expect(playbook).toContain('CR 工具产物必须与源码工作树隔离');
    expect(playbook).toContain('`mktemp -d`');
    expect(playbook).toContain('不得用 `.gitignore` 掩盖工具写入');
  });

  it('keeps domain-specific review rules close to the code they govern', () => {
    for (const path of [
      'src/eval-core/AGENTS.md',
      'src/eval-workflows/AGENTS.md',
      'src/observability/AGENTS.md',
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

  it('keeps generated CR state outside the repository', () => {
    for (const path of ['artifacts/cr', 'knowledge/cr']) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });
});

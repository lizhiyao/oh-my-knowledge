import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('autonomous review governance', () => {
  it('keeps the cross-agent entrypoints connected to the review playbook', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('## 自主 CR 与完成定义');
    expect(agents).toContain('必须完整阅读 [`CODE_REVIEW.md`](./CODE_REVIEW.md)');
    expect(read('CONTRIBUTING.md')).toContain('[`CODE_REVIEW.md`](./CODE_REVIEW.md)');
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
});

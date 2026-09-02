import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { readPromptDocument } from '../../src/observability/prompts/document.js';
import { PROMPTS_DIR } from '../../src/observability/soft-standards/index.js';

// llm-enhanced-review prompt 的 byte-level 冻结已统一进 test/measurement-governance/prompt-registry-freeze.test.ts
// (registry 条目 `observe-llm-enhanced-review`)。这里只保留 prompt 文件的 cwd 可移植性测试 ——
// 它不属于「评分类 prompt 编目」,但对 npm 安装场景至关重要,故留在 observability 旁。
describe('llm-enhanced-review prompt portability', () => {
  it('loads prompt regardless of process.cwd() (npm-installed portability)', () => {
    // npm install -g omk 后,用户 cwd 是自己项目目录,不是 omk 包目录。
    // PROMPTS_DIR 用 import.meta.url 锁定 src/observability/prompts/ sibling 路径,
    // 不能 fallback 到 process.cwd()。这条测试模拟用户场景,锁住 portability。
    const load = (): string => readPromptDocument({
      dir: PROMPTS_DIR,
      fileName: 'llm-enhanced-review.prompt.md',
      id: 'llm-enhanced-review',
      version: '2026-05-22.v7',
    }).hash;

    const fromRepo = load();
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      assert.equal(load(), fromRepo, 'prompt 必须能从任意 cwd 加载且 hash 一致(否则 npm 用户跑 --llm-enhanced-review 必挂)');
    } finally {
      process.chdir(original);
    }
    assert.ok(fromRepo.length > 0, 'prompt 应非空');
  });
});

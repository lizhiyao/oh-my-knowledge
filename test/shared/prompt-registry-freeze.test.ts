import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_REGISTRY } from '../../src/shared/llm-prompts/registry.js';

// 统一冻结:omk 所有「直接决定分数」的评委 prompt 的 byte-level 锚点。任何动其模板字节(含
// 标点 / 空白 / 版本串 / 共享去偏块)都会让对应 hash 变,从而让历史报告不可比。除非显式想 bump
// 对应 prompt 的版本,否则这些断言必须永远通过。取代了原 judge-hash-frozen / llm-enhanced-review-prompt
// 两个分散的冻结测试,统一由 PROMPT_REGISTRY 驱动。
//
// rubric 评委历史值(已 archive,仅留底):
//   v2-cot          : fdc81b19c721
//   v3-cot-length   : 629bf3b8c41d
//   v3-cot-toolargs : 9c441e9b6a73   (off)
//   v4-cot-len-args : bd1d97c86a5f   (on)
//
// 确需 bump 某条:改对应 prompt 的版本串 / 模板,再来更新此处冻结值(评分类 = BREAKING-COMPARABILITY)。
const FROZEN: Record<string, string> = {
  'rubric-judge-debias-on': 'bb393197cd41',  // v5-cot-toolargs-fmt-len
  'rubric-judge-debias-off': '74be4a6a2439', // v5-cot-toolargs-fmt
  'semantic-similarity': 'e0d0931c6ee6',
  'rag-faithfulness': 'f1d37fd8e3d6',
  'rag-answer-relevancy': 'f776a5d12b5c',
  'rag-context-recall': 'a1ad34978824',
  'observe-llm-enhanced-review': '5c5c8e5bf0af8fce3ebf22d2363ca863cdb430dafd087bec19e170517cfa0b83', // 2026-05-22.v7
};

const INVARIANT = PROMPT_REGISTRY.filter((e) => e.measurementInvariant);

describe('prompt-registry byte-level freeze', () => {
  for (const entry of INVARIANT) {
    it(`${entry.promptId} hash 冻结`, () => {
      assert.ok(entry.getHash, `${entry.promptId} 是 measurementInvariant,必须提供 getHash`);
      assert.equal(
        entry.getHash!(),
        FROZEN[entry.promptId],
        `prompt "${entry.promptId}" 模板字节变了 → 历史报告不可比;确需改,先 bump 对应 prompt 版本串再更新此冻结值`,
      );
    });
  }

  it('FROZEN 表无悬空键(每个冻结值都对应一个 invariant 条目)', () => {
    const ids = new Set(INVARIANT.map((e) => e.promptId));
    for (const id of Object.keys(FROZEN)) {
      assert.ok(ids.has(id), `FROZEN["${id}"] 无对应 registry invariant 条目`);
    }
  });
});

describe('prompt-registry 完整性', () => {
  it('每个 invariant 条目都有 getHash 且产出 12 或 64 位 hex', () => {
    for (const e of INVARIANT) {
      assert.ok(e.getHash, `${e.promptId} 缺 getHash`);
      assert.match(e.getHash!(), /^[0-9a-f]{12}$|^[0-9a-f]{64}$/, `${e.promptId} hash 非 12/64 位 hex`);
    }
  });

  it('每条 module 路径真实存在(发现入口不腐烂)', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    for (const e of PROMPT_REGISTRY) {
      assert.ok(existsSync(join(repoRoot, e.module)), `registry 条目 "${e.promptId}" 的 module 路径不存在: ${e.module}`);
    }
  });

  it('promptId 唯一', () => {
    const ids = PROMPT_REGISTRY.map((e) => e.promptId);
    assert.equal(new Set(ids).size, ids.length, 'promptId 有重复');
  });
});

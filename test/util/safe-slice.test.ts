import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { safeSliceForJson } from '../../src/util/safe-slice.js';

describe('safeSliceForJson', () => {
  it('短字符串原样返回(无 suffix)', () => {
    assert.equal(safeSliceForJson('hello', 100), 'hello');
  });

  it('普通 BMP 字符按 maxLen 切并加 suffix', () => {
    assert.equal(safeSliceForJson('hello world', 5), 'hello…');
  });

  it('emoji 在切口处不破坏 surrogate pair (回退一位)', () => {
    // '🐛' = U+1F41B 用 🐛 两个 code unit 表示
    // 'ab🐛cd'.length === 6 (a, b, \uD83D, \uDC1B, c, d)
    const s = 'ab🐛cd';
    // 在 emoji 高位之后切(maxLen=3): 切完应该回退一位变 'ab' + '…'
    const r = safeSliceForJson(s, 3);
    assert.equal(r, 'ab…');
    // 整个 emoji 都包含的切点(maxLen=4): 留 'ab🐛'
    assert.equal(safeSliceForJson(s, 4), 'ab🐛…');
  });

  it('结果通过严格 JSON 序列化往返不报 surrogate 错', () => {
    // 模拟 omk 的 outputPreview 场景:LLM 输出含 emoji,被截断后写盘
    const llmOutput = '执行完成 🐛 发现一个 bug';
    // 不安全切法可能在 emoji 中间断
    const truncated = safeSliceForJson(llmOutput, 5);
    const json = JSON.stringify({ outputPreview: truncated });
    // 解析回来应该不报错
    const parsed = JSON.parse(json);
    assert.equal(typeof parsed.outputPreview, 'string');
    // 检查没有孤悬 surrogate(高位后面必须跟低位)
    for (let i = 0; i < parsed.outputPreview.length; i++) {
      const code = parsed.outputPreview.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = parsed.outputPreview.charCodeAt(i + 1);
        assert.ok(next >= 0xDC00 && next <= 0xDFFF, `orphan high surrogate at ${i}: ${parsed.outputPreview!}`);
      }
    }
  });

  it('自定义 suffix 生效', () => {
    assert.equal(safeSliceForJson('hello world', 5, '...[truncated]'), 'hello...[truncated]');
  });

  it('maxLen 等于字符串长度时不加 suffix', () => {
    assert.equal(safeSliceForJson('hello', 5), 'hello');
  });

  it('多 emoji 边界场景', () => {
    const s = '🚀🐛🎉';  // 3 个 emoji = 6 code units
    // 切 1(在第一个 emoji 高位后):回退,得 ''+ suffix
    assert.equal(safeSliceForJson(s, 1), '…');
    // 切 2(完整保留第一个 emoji)
    assert.equal(safeSliceForJson(s, 2), '🚀…');
    // 切 3(在第二个 emoji 高位后):回退到 2
    assert.equal(safeSliceForJson(s, 3), '🚀…');
  });
});

/**
 * 会话列表空状态分类（#903 第二项）：四种空的下一步完全不同，
 * 用同一句「暂无匹配的会话」覆盖全部，等于让用户自己判断该做什么。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { listEmptyState } from '../../../src/studio/application/conversations/list-states.js';
import type { ListEmptyState } from '../../../src/studio/application/conversations/list-states.js';

const state = (input: { searching: boolean; view: string; viewExists: boolean }): ListEmptyState => listEmptyState(input);

describe('listEmptyState', () => {
  it('搜索无匹配优先于其它解释，下一步是清空搜索', () => {
    assert.equal(state({ searching: true, view: 'recent', viewExists: false }), 'no-match');
    assert.equal(state({ searching: true, view: 'running', viewExists: false }), 'no-match');
    assert.equal(state({ searching: true, view: 'project-a', viewExists: true }), 'no-match');
  });

  it('没有进行中的会话不等于没有记录，下一步是回到全部对话', () => {
    assert.equal(state({ searching: false, view: 'running', viewExists: false }), 'no-running');
  });

  it('视图指向已不存在的项目时说明它可能已被清理', () => {
    assert.equal(state({ searching: false, view: 'project-a', viewExists: false }), 'unknown-project');
  });

  it('项目视图存在但恰好为空不算项目丢失', () => {
    assert.equal(state({ searching: false, view: 'project-a', viewExists: true }), 'no-data');
  });

  it('全部对话视图下确实没有记录时才是无数据', () => {
    assert.equal(state({ searching: false, view: 'recent', viewExists: false }), 'no-data');
  });
});

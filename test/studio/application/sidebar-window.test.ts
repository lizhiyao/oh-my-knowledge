/**
 * 侧栏与列表的可见窗口（#903 第二项）：截断只是默认视野，被截掉的内容必须仍然可达。
 *
 * 这些判定原先内联在 `workspace.tsx` 的 JSX 里（含两处重复的「把选中项补回视野」），只能靠整页渲染才能触发，
 * 因此边界场景一直没有验证记录。下沉成纯函数后，截断上限、越界页码与选中项补位都可以直接钉住。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  INDEPENDENT_LIMIT,
  LIST_PAGE_SIZE,
  PROJECT_LIMIT,
  keepSelectedVisible,
  listPage,
  visibleProjectIds,
} from '../../../src/studio/application/conversations/sidebar-window.js';
import type { ConversationListItem } from '../../../src/observability/view-models/conversation.js';

const item = (threadId: string): ConversationListItem => ({ threadId } as ConversationListItem);
const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `project-${index}`);

describe('visibleProjectIds', () => {
  it('默认只给前 6 个项目，超出的不进视野', () => {
    const visible = visibleProjectIds(ids(9), { all: false, searching: false });
    assert.equal(visible.length, PROJECT_LIMIT);
    assert.equal(visible.at(-1), `project-${PROJECT_LIMIT - 1}`);
  });

  it('展开与搜索时全部项目可见，不靠用户猜还有多少', () => {
    assert.equal(visibleProjectIds(ids(9), { all: true, searching: false }).length, 9);
    assert.equal(visibleProjectIds(ids(9), { all: false, searching: true }).length, 9);
  });

  it('当前打开或正在查看的项目即使排在上限外也留在视野内', () => {
    const visible = visibleProjectIds(ids(9), { all: false, searching: false, selectedId: 'project-8' });
    assert.deepEqual(visible, [...ids(PROJECT_LIMIT), 'project-8']);
    assert.ok(visibleProjectIds(ids(9), { all: false, searching: false, activeId: 'project-7' }).includes('project-7'));
  });

  it('项目不足上限时不产生任何截断', () => {
    assert.deepEqual(visibleProjectIds(ids(3), { all: false, searching: false }), ids(3));
  });
});

describe('keepSelectedVisible', () => {
  it('截断把正在看的会话挤出去时补回视野末尾', () => {
    const candidates = Array.from({ length: INDEPENDENT_LIMIT + 3 }, (_, index) => item(`thread-${index}`));
    const selected = candidates.at(-1);
    const shown = keepSelectedVisible(candidates.slice(0, INDEPENDENT_LIMIT), candidates, selected);
    assert.equal(shown.length, INDEPENDENT_LIMIT + 1);
    assert.equal(shown.at(-1)?.threadId, selected?.threadId);
  });

  it('选中项不属于当前候选集时不补，避免项目会话混进独立对话', () => {
    const candidates = [item('a'), item('b')];
    assert.deepEqual(keepSelectedVisible(candidates, candidates, item('elsewhere')), candidates);
  });

  it('已在视野内时不重复追加', () => {
    const candidates = [item('a'), item('b')];
    assert.deepEqual(keepSelectedVisible(candidates, candidates, item('a')), candidates);
  });

  it('没有选中项时原样返回', () => {
    assert.deepEqual(keepSelectedVisible([item('a')], [item('a')], undefined), [item('a')]);
  });
});

describe('listPage', () => {
  const rows = Array.from({ length: 45 }, (_, index) => index);

  it('按每页 20 条切页', () => {
    assert.equal(listPage(rows, 1).rows.length, LIST_PAGE_SIZE);
    assert.deepEqual(listPage(rows, 3).rows, [40, 41, 42, 43, 44]);
  });

  it('总数变少后把越界页码夹回最后一页，不停在空列表上', () => {
    const narrowed = listPage(rows.slice(0, 5), 3);
    assert.equal(narrowed.page, 1);
    assert.equal(narrowed.rows.length, 5);
  });

  it('空列表也给出有效页码，分页控件不会出现第 0 页', () => {
    assert.deepEqual(listPage([], 4), { rows: [], page: 1 });
  });

  it('非法页码夹回首页', () => {
    assert.equal(listPage(rows, 0).page, 1);
    assert.equal(listPage(rows, -3).page, 1);
  });
});

/**
 * 会话列表的空状态分类。四种空的下一步完全不同：搜索无匹配要清空搜索，没有进行中的要回到全部，
 * 视图指向已不存在的项目要说明它可能已被清理，真正无数据才该解释记录从哪里来。
 * 用同一句「暂无匹配的会话」覆盖全部，等于让用户自己判断该做什么。
 */
export type ListEmptyState = 'no-match' | 'no-running' | 'unknown-project' | 'no-data';

export function listEmptyState(input: { searching: boolean; view: string; viewExists: boolean }): ListEmptyState {
  if (input.searching) return 'no-match';
  if (input.view === 'running') return 'no-running';
  if (input.view !== 'recent' && !input.viewExists) return 'unknown-project';
  return 'no-data';
}

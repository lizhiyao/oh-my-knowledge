/** 阶段记录和预算账本共用的非负单调时长投影。 */
export function durationMs(started: number, completed: number): number {
  return Math.max(0, completed - started);
}

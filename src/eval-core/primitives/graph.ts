import { compareStrings } from './ordering.js';

/** 单节点就绪优先和整层推进是既有阶段的两种调度顺序，均复用同一拓扑算法。 */
export function topologicalOrder(
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  scheduling: 'ready-node' | 'ready-frontier',
  cycleMessage: string,
): string[] {
  const remaining = new Set(dependencies.keys());
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((nodeId) => (
      [...(dependencies.get(nodeId) ?? [])].every((dependency) => !remaining.has(dependency))
    )).sort(compareStrings);
    if (ready.length === 0) throw new TypeError(cycleMessage);
    const next = scheduling === 'ready-node' ? ready.slice(0, 1) : ready;
    for (const nodeId of next) {
      ordered.push(nodeId);
      remaining.delete(nodeId);
    }
  }
  return ordered;
}

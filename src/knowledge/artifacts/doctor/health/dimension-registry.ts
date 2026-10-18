/**
 * HealthDimensionSpec 全局注册表(module-level singleton)。
 *
 * 内置 7 个维度由 health/register.ts 注册;用户通过 registerHealthDimension()
 * 注册自定义维度。注册顺序就是 prompt 中的章节编号顺序。
 *
 * id 冲突会抛 — 防止意外覆盖。__resetForTest 给单测用。
 */

import type { HealthDimensionSpec } from './dimension-spec.js';

const dimensions: HealthDimensionSpec[] = [];
const seenIds = new Set<string>();

export function registerHealthDimension(spec: HealthDimensionSpec): void {
  if (!spec.id || spec.id.includes(':')) {
    throw new Error(`invalid health dimension id: "${spec.id}" (non-empty, no ":")`);
  }
  if (seenIds.has(spec.id)) {
    throw new Error(`health dimension id collision: ${spec.id}`);
  }
  seenIds.add(spec.id);
  dimensions.push(spec);
}

export function getRegisteredHealthDimensions(): HealthDimensionSpec[] {
  return [...dimensions]; // 防止外部 mutate
}

export function __resetHealthDimensionsForTest(): void {
  dimensions.length = 0;
  seenIds.clear();
}

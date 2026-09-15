import type { DiagnosisLifecycle } from './contracts.js';

/** Diagnosis 是否「active problem」的唯一权威定义。
 *
 *  Studio projection rule:
 *    active = detected / candidate / stale
 *    inactive = resolved / rejected(默认从 active 列表隐藏)
 *    confirmed:目前 mapper 不产出,如果将来 producer / review-state 写出,会被一并算 inactive
 *               —— 跟 confirmed soft standard 的「已被认知、进入处理流程」语义一致。
 *
 *  抽这个 helper 是为了让 Insight 投影（影响 skill 健康 / 待优化数）与 Studio 的 active 诊断列表
 *  共用同一份口径，避免「Insight 把 confirmed 算 active 但页面不算」的口径分叉。
 */
const ACTIVE_DIAGNOSIS_LIFECYCLES: ReadonlySet<DiagnosisLifecycle> = new Set<DiagnosisLifecycle>([
  'detected',
  'candidate',
  'stale',
]);

export function isActiveDiagnosisLifecycle(lifecycle: DiagnosisLifecycle): boolean {
  return ACTIVE_DIAGNOSIS_LIFECYCLES.has(lifecycle);
}

/** Merge lifecycle states without making the result depend on bundle order. */
export function maxDiagnosisLifecycle(
  a: DiagnosisLifecycle,
  b: DiagnosisLifecycle,
): DiagnosisLifecycle {
  const rank: Record<DiagnosisLifecycle, number> = {
    resolved: 6,
    rejected: 5,
    detected: 4,
    candidate: 3,
    confirmed: 2,
    stale: 1,
  };
  return rank[a] >= rank[b] ? a : b;
}

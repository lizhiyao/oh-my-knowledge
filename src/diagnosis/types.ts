export type {
  Diagnosis,
  DiagnosisAudience,
  DiagnosisBundle,
  DiagnosisEvidenceRef,
  DiagnosisLifecycle,
  DiagnosisOccurrence,
  DiagnosisPatch,
  DiagnosisScope,
  DiagnosisSeverity,
  DiagnosisSource,
  DiagnosisSourceCoverage,
  DiagnosisType,
  StudioDiagnosisSummary,
} from '../types/diagnosis.js';

import type { DiagnosisLifecycle } from '../types/diagnosis.js';

/** Diagnosis 是否「active problem」的唯一权威定义。
 *
 *  Studio projection rule:
 *    active = detected / candidate / stale
 *    inactive = resolved / rejected(默认从 active 列表隐藏)
 *    confirmed:目前 mapper 不产出,如果将来 producer / review-state 写出,会被一并算 inactive
 *               —— 跟 confirmed soft standard 的「已被认知、进入处理流程」语义一致。
 *
 *  抽这个 helper 是为了:Insight 投影(影响 skill 健康 / 待优化数)和 /api/observations/diagnostics
 *  的 active 列表共用同一份口径,避免「Insight 把 confirmed 算 active 但 API 不算」的口径分叉。
 */
const ACTIVE_DIAGNOSIS_LIFECYCLES: ReadonlySet<DiagnosisLifecycle> = new Set<DiagnosisLifecycle>([
  'detected',
  'candidate',
  'stale',
]);

export function isActiveDiagnosisLifecycle(lifecycle: DiagnosisLifecycle): boolean {
  return ACTIVE_DIAGNOSIS_LIFECYCLES.has(lifecycle);
}

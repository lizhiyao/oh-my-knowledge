/**
 * Holdout split + train/holdout composite breakdown.
 *
 * Deterministic (no RNG) train/holdout partitioning of a sample set, plus the
 * subset-composite recompute that lets `omk eval --holdout-ratio` and `omk evolve`
 * score a variant on a withheld slice using the *same* aggregation as the headline
 * composite (`buildVariantSummary`). Lives in eval-core so both the eval pipeline
 * and the authoring/evolve loop depend *down* into it (authoring → eval-core is the
 * established direction).
 *
 * A large train − holdout composite gap is the generalization / sample-set-overfitting
 * signal the verdict's overfitting gate reads (`src/eval-core/verdict.ts`).
 */

import { buildVariantSummary } from './schema.js';
import type { Report, VariantResult, HoldoutBreakdown } from '../types/index.js';

/** A train / holdout partition of a sample set. */
export interface HoldoutSplit {
  trainIds: Set<string>;
  holdoutIds: Set<string>;
}

/** Below this many samples on any side, a split is too small to be meaningful —
 *  callers fall back to full-set scoring and mark the breakdown `disabled`. */
export const MIN_HOLDOUT_SUBSET = 3;

/** Pick `count` ids at an even stride across `ids` (deterministic, no RNG) so the
 *  picked subset is representative of the ordering and stable across rounds/runs. */
export function pickByStride(ids: string[], count: number): Set<string> {
  const picked = new Set<string>();
  if (count <= 0) return picked;
  const stride = ids.length / count;
  for (let k = 0; k < count; k++) picked.add(ids[Math.floor(k * stride)]);
  return picked;
}

/**
 * Deterministically split sample ids into train / holdout by `ratio` (fraction
 * held out). Holdout members are picked at an even stride so the partition is
 * representative of the ordering, and the split is stable across rounds and runs
 * (no RNG). Returns null when ratio ≤ 0 or either side would drop below
 * MIN_HOLDOUT_SUBSET — the caller then scores on the full set.
 */
export function splitHoldout(sampleIds: string[], ratio: number): HoldoutSplit | null {
  if (!(ratio > 0) || sampleIds.length === 0) return null;
  const holdoutCount = Math.round(sampleIds.length * ratio);
  const trainCount = sampleIds.length - holdoutCount;
  if (holdoutCount < MIN_HOLDOUT_SUBSET || trainCount < MIN_HOLDOUT_SUBSET) return null;
  const holdoutIds = pickByStride(sampleIds, holdoutCount);
  const trainIds = new Set(sampleIds.filter((id) => !holdoutIds.has(id)));
  return { trainIds, holdoutIds };
}

/**
 * Mean composite over the subset of a report's results whose sample_id is in
 * `ids`, using the same aggregation as the full-run summary
 * (`buildVariantSummary`) so train / holdout scores stay comparable to the
 * headline composite. Returns 0 when the subset has no scorable entries.
 */
export function subsetCompositeScore(report: Report, variantKey: string, ids: Set<string>): number {
  const entries: VariantResult[] = [];
  for (const r of report.results) {
    if (!ids.has(r.sample_id)) continue;
    const v = r.variants[variantKey];
    if (v) entries.push(v);
  }
  if (entries.length === 0) return 0;
  return buildVariantSummary(entries).avgCompositeScore ?? 0;
}

/**
 * Train vs holdout composite breakdown per variant for `omk eval --holdout-ratio`.
 * Post-hoc — never perturbs the headline aggregation or bootstrap CI.
 *
 * The split is taken over `sampleIdOrder` — the **stable authored sample order**
 * (the loaded `samples` file order), NOT `report.results`, whose insertion order
 * is the concurrent-completion order and drifts run-to-run. Binding the stride pick
 * to the authored order is what makes the holdout (and the verdict overfitting gate
 * it feeds) deterministic and reproducible. Subset scores are then read from
 * `report.results` by id-set membership, which is order-independent.
 *
 * When the split is too small on either side (< MIN_HOLDOUT_SUBSET) it returns
 * `{ disabled: true }` with an empty `perVariant`, so the verdict overfitting gate
 * stays inert. The testSetHash watermark (gap-spec §7.1) is attached by the caller,
 * shared with gapReports.
 */
export function computeHoldoutBreakdown(
  report: Report,
  variantNames: string[],
  ratio: number,
  sampleIdOrder: string[],
): HoldoutBreakdown {
  const split = splitHoldout(sampleIdOrder, ratio);
  if (!split) {
    return { ratio, disabled: true, perVariant: {} };
  }
  const perVariant: HoldoutBreakdown['perVariant'] = {};
  for (const v of variantNames) {
    perVariant[v] = {
      trainScore: Number(subsetCompositeScore(report, v, split.trainIds).toFixed(4)),
      holdoutScore: Number(subsetCompositeScore(report, v, split.holdoutIds).toFixed(4)),
      trainCount: split.trainIds.size,
      holdoutCount: split.holdoutIds.size,
    };
  }
  return { ratio, perVariant };
}

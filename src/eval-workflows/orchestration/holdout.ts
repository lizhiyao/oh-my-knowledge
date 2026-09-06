export interface HoldoutSplit {
  trainIds: Set<string>;
  holdoutIds: Set<string>;
}

export const MIN_HOLDOUT_SUBSET = 3;

export function pickByStride(ids: readonly string[], count: number): Set<string> {
  const picked = new Set<string>();
  if (count <= 0) return picked;
  const stride = ids.length / count;
  for (let index = 0; index < count; index += 1) {
    picked.add(ids[Math.floor(index * stride)]);
  }
  return picked;
}

/** Deterministic cohort assignment over canonical sample order. */
export function splitHoldout(sampleIds: readonly string[], ratio: number): HoldoutSplit | null {
  if (!(ratio > 0) || sampleIds.length === 0) return null;
  const holdoutCount = Math.round(sampleIds.length * ratio);
  const trainCount = sampleIds.length - holdoutCount;
  if (holdoutCount < MIN_HOLDOUT_SUBSET || trainCount < MIN_HOLDOUT_SUBSET) return null;
  const holdoutIds = pickByStride(sampleIds, holdoutCount);
  return {
    holdoutIds,
    trainIds: new Set(sampleIds.filter((sampleId) => !holdoutIds.has(sampleId))),
  };
}

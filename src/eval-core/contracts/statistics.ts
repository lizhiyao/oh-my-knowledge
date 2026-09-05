export function bonferroniMarginalAlpha(
  familyConfidenceLevel: number,
  familySize: number,
): number {
  if (!Number.isFinite(familyConfidenceLevel)
      || familyConfidenceLevel <= 0
      || familyConfidenceLevel >= 1
      || !Number.isSafeInteger(familySize)
      || familySize < 2) {
    throw new TypeError(
      'Bonferroni interval family requires confidence in (0, 1) and at least two members.',
    );
  }
  return Number(((1 - familyConfidenceLevel) / familySize).toPrecision(15));
}

export function bonferroniMarginalConfidenceLevel(
  familyConfidenceLevel: number,
  familySize: number,
): number {
  const confidenceLevel = 1 - bonferroniMarginalAlpha(familyConfidenceLevel, familySize);
  if (!Number.isFinite(confidenceLevel)
      || confidenceLevel <= 0
      || confidenceLevel >= 1) {
    throw new TypeError(
      'Bonferroni marginal confidence is not representable as a probability in (0, 1).',
    );
  }
  return confidenceLevel;
}

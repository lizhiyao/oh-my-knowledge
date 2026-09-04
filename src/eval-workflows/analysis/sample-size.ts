export const PAIRED_NORMAL_POWER_METHOD_ID =
  'omk.paired-mean-difference-normal-approximation/v1' as const;

export interface PairedNormalPowerAssumptions {
  readonly minimumDetectableDifference: number;
  readonly expectedDifferenceStandardDeviation: number;
  readonly targetPower: number;
  readonly familywiseAlpha: number;
  readonly plannedComparisonCount: number;
}

function inverseStandardNormal(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw new TypeError('Normal quantile probability must be in (0, 1).');
  }
  const a = [
    -3.969683028665376e+1,
    2.209460984245205e+2,
    -2.759285104469687e+2,
    1.38357751867269e+2,
    -3.066479806614716e+1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e+1,
    1.615858368580409e+2,
    -1.556989798598866e+2,
    6.680131188771972e+1,
    -1.328068155288572e+1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q
      + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q
      + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r
    + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r
      + b[4]!) * r + 1);
}

/**
 * Plans complete paired comparison units before outcomes are observed.
 *
 * The standardized mean-difference formula uses a two-sided normal
 * approximation and Bonferroni allocation across the planned comparison
 * family. It deliberately accepts no observed effect or run variance.
 */
export function requiredPairedComparisonUnits(
  assumptions: PairedNormalPowerAssumptions,
): number {
  const {
    minimumDetectableDifference,
    expectedDifferenceStandardDeviation,
    targetPower,
    familywiseAlpha,
    plannedComparisonCount,
  } = assumptions;
  if (!Number.isFinite(minimumDetectableDifference)
      || !(minimumDetectableDifference > 0)
      || !Number.isFinite(expectedDifferenceStandardDeviation)
      || !(expectedDifferenceStandardDeviation > 0)
      || !(targetPower > 0.5 && targetPower < 1)
      || !(familywiseAlpha > 0 && familywiseAlpha < 1)
      || !Number.isSafeInteger(plannedComparisonCount)
      || plannedComparisonCount < 1) {
    throw new TypeError('Paired power assumptions are invalid.');
  }
  const perComparisonAlpha = familywiseAlpha / plannedComparisonCount;
  const significanceQuantile = inverseStandardNormal(1 - perComparisonAlpha / 2);
  const powerQuantile = inverseStandardNormal(targetPower);
  const standardized = (
    (significanceQuantile + powerQuantile)
    * expectedDifferenceStandardDeviation
    / minimumDetectableDifference
  );
  const required = Math.ceil(standardized * standardized);
  if (!Number.isSafeInteger(required)) {
    throw new TypeError('Paired power assumptions produce an unsafe sample size.');
  }
  return Math.max(2, required);
}

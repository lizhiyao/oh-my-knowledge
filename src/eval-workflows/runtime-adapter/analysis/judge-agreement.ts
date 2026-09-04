interface JudgeAgreement {
  readonly pearson?: number;
  readonly meanAbsDiff: number;
  readonly pairCount: number;
}

function pearson(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length !== right.length || left.length < 2) return undefined;
  const count = left.length;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / count;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < count; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  return leftVariance === 0 || rightVariance === 0
    ? undefined
    : covariance / Math.sqrt(leftVariance * rightVariance);
}

function meanAbsoluteDifference(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0)
    / left.length;
}

/** Pairwise agreement for the complete judge-member × sample matrix. */
export function computeJudgeAgreement(
  judgeScores: readonly (readonly number[])[],
): JudgeAgreement {
  if (judgeScores.length < 2) return { meanAbsDiff: 0, pairCount: 0 };

  let meanAbsoluteDifferenceSum = 0;
  let pearsonSum = 0;
  let pearsonCount = 0;
  let pairCount = 0;
  for (let leftIndex = 0; leftIndex < judgeScores.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < judgeScores.length; rightIndex++) {
      pairCount += 1;
      const left = judgeScores[leftIndex];
      const right = judgeScores[rightIndex];
      meanAbsoluteDifferenceSum += meanAbsoluteDifference(left, right);
      const correlation = pearson(left, right);
      if (correlation !== undefined) {
        pearsonSum += correlation;
        pearsonCount += 1;
      }
    }
  }

  return {
    meanAbsDiff: Number((meanAbsoluteDifferenceSum / pairCount).toFixed(3)),
    pairCount,
    ...(pearsonCount === 0
      ? {}
      : { pearson: Number((pearsonSum / pearsonCount).toFixed(3)) }),
  };
}

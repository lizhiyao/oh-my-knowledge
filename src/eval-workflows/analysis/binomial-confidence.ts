export interface BinomialProportionInterval {
  readonly lower: number;
  readonly upper: number;
}

const LANCZOS_COEFFICIENTS = [
  676.5203681218851,
  -1259.1392167224028,
  771.3234287776531,
  -176.6150291621406,
  12.507343278686905,
  -0.13857109526572012,
  9.984369578019572e-6,
  1.5056327351493116e-7,
] as const;

function logGamma(value: number): number {
  if (value < 0.5) {
    return Math.log(Math.PI)
      - Math.log(Math.sin(Math.PI * value))
      - logGamma(1 - value);
  }
  const shifted = value - 1;
  let series = 0.9999999999998099;
  for (const [index, coefficient] of LANCZOS_COEFFICIENTS.entries()) {
    series += coefficient / (shifted + index + 1);
  }
  const scale = shifted + LANCZOS_COEFFICIENTS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI)
    + (shifted + 0.5) * Math.log(scale)
    - scale
    + Math.log(series);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const minimum = 1e-300;
  const epsilon = 3e-14;
  const maximumIterations = 300;
  const sum = a + b;
  const aPlusOne = a + 1;
  const aMinusOne = a - 1;
  let c = 1;
  let d = 1 - sum * x / aPlusOne;
  if (Math.abs(d) < minimum) d = minimum;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maximumIterations; iteration++) {
    const doubled = 2 * iteration;
    let coefficient = iteration * (b - iteration) * x
      / ((aMinusOne + doubled) * (a + doubled));
    d = 1 + coefficient * d;
    if (Math.abs(d) < minimum) d = minimum;
    c = 1 + coefficient / c;
    if (Math.abs(c) < minimum) c = minimum;
    d = 1 / d;
    result *= d * c;
    coefficient = -(a + iteration) * (sum + iteration) * x
      / ((a + doubled) * (aPlusOne + doubled));
    d = 1 + coefficient * d;
    if (Math.abs(d) < minimum) d = minimum;
    c = 1 + coefficient / c;
    if (Math.abs(c) < minimum) c = minimum;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) <= epsilon) return result;
  }
  throw new RangeError('Incomplete beta continued fraction did not converge.');
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const scale = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? scale * betaContinuedFraction(a, b, x) / a
    : 1 - scale * betaContinuedFraction(b, a, 1 - x) / b;
}

function inverseRegularizedIncompleteBeta(probability: number, a: number, b: number): number {
  if (probability <= 0) return 0;
  if (probability >= 1) return 1;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 80; iteration++) {
    const candidate = (lower + upper) / 2;
    if (regularizedIncompleteBeta(candidate, a, b) < probability) {
      lower = candidate;
    } else {
      upper = candidate;
    }
  }
  return (lower + upper) / 2;
}

/**
 * Exact equal-tailed Clopper-Pearson interval for a binomial proportion.
 *
 * Bootstrap tail counts are binomial Monte Carlo observations conditional on
 * the evaluated sample. Keeping this interval separate from the bootstrap
 * confidence interval prevents finite resampling error from masquerading as
 * uncertainty about the evaluated population.
 */
export function clopperPearsonInterval(
  successes: number,
  trials: number,
  confidenceLevel: number,
): BinomialProportionInterval {
  if (!Number.isSafeInteger(trials) || trials < 1
      || !Number.isSafeInteger(successes) || successes < 0 || successes > trials
      || !Number.isFinite(confidenceLevel)
      || !(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new TypeError('Binomial confidence interval inputs are invalid.');
  }
  const tail = (1 - confidenceLevel) / 2;
  return {
    lower: successes === 0
      ? 0
      : inverseRegularizedIncompleteBeta(tail, successes, trials - successes + 1),
    upper: successes === trials
      ? 1
      : inverseRegularizedIncompleteBeta(1 - tail, successes + 1, trials - successes),
  };
}

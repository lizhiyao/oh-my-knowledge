/** 所有阶段与 Bundle 校验共享信任偏序；空集合的默认值仍由各自契约决定。 */
export const TRUST_LEVEL = Object.freeze({
  untrusted: 0,
  unknown: 1,
  declared: 2,
  verified: 3,
} as const);

export function isProvenanceTrust(value: unknown): value is keyof typeof TRUST_LEVEL {
  return typeof value === 'string' && Object.hasOwn(TRUST_LEVEL, value);
}

export type ProvenanceTrust = keyof typeof TRUST_LEVEL;

/** 空集合策略由阶段显式给出；非空集合的信任只由实际输入决定。 */
export function minimumTrust(
  values: readonly ProvenanceTrust[],
  empty: ProvenanceTrust,
): ProvenanceTrust {
  let minimum = values[0] ?? empty;
  for (const value of values) {
    if (TRUST_LEVEL[value] < TRUST_LEVEL[minimum]) minimum = value;
  }
  return minimum;
}

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

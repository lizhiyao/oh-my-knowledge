import { assertCanonicalJson } from '../contracts/index.js';
export { deepFreeze } from '../contracts/immutability.js';

export function snapshotJson<T>(value: T): T {
  assertCanonicalJson(value);
  return structuredClone(value);
}

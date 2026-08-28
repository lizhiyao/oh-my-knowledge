import { assertCanonicalJson } from '../contracts/index.js';

export function snapshotJson<T>(value: T): T {
  assertCanonicalJson(value);
  return structuredClone(value);
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

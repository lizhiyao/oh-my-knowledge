/**
 * Runtime guard for data that can cross OMK's JSON persistence boundaries
 * without coercion, property loss, or cycle errors.
 */
export function isJsonValue(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= 32 || seen.has(value)) return false;

  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length
        || value.some((_, index) => !Object.hasOwn(value, index))
      ) return false;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }

    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((entry) => isJsonValue(entry, seen, depth + 1))
      : Object.values(value).every(
        (entry) => isJsonValue(entry, seen, depth + 1),
      );
    seen.delete(value);
    return valid;
  } catch {
    seen.delete(value);
    return false;
  }
}

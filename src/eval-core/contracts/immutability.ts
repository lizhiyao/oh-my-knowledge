function freezePlainGraph(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object'
      || Object.isFrozen(value) || seen.has(value)) return;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
  }
  seen.add(value);
  for (const child of Object.values(value)) freezePlainGraph(child, seen);
  if (!Object.isFrozen(value)) Object.freeze(value);
}

/** Deeply freezes arrays and plain data objects while leaving host objects opaque. */
export function deepFreeze<T>(value: T): T {
  freezePlainGraph(value, new WeakSet());
  return value;
}

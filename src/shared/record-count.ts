export function ownRecordValue<T>(
  record: Record<string, T>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function setOwnRecordValue<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): T {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return value;
}

/**
 * Increment an arbitrary string-keyed counter without reading inherited
 * properties such as `constructor` or invoking the legacy `__proto__` setter.
 */
export function incrementRecordCount(
  record: Record<string, number>,
  key: string,
  amount = 1,
): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`Record count increment must be a non-negative integer, got ${String(amount)}`);
  }
  const ownValue = ownRecordValue(record, key);
  const current = typeof ownValue === 'number' && Number.isSafeInteger(ownValue) && ownValue >= 0
    ? ownValue
    : 0;
  const next = current + amount;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError(`Record count for "${key}" exceeds Number.MAX_SAFE_INTEGER`);
  }
  return setOwnRecordValue(record, key, next);
}

export function sumRecordCounts(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Record count must be a non-negative safe integer, got ${String(value)}`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Record count sum exceeds Number.MAX_SAFE_INTEGER');
    }
  }
  return total;
}

/** Capture map membership at each host boundary without exposing mutable Map methods. */
export function readonlyMapSnapshot<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const snapshot = new Map(source);
  const view: ReadonlyMap<Key, Value> = Object.freeze({
    get size() { return snapshot.size; },
    get(key: Key) { return snapshot.get(key); },
    has(key: Key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
    forEach(
      callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
      thisArg?: unknown,
    ) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });
  return view;
}

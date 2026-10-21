import { resolveJsonPointer } from '../../primitives/json-pointer.js';
import { definitionError } from '../errors.js';

export function assertUnique(
  values: readonly string[],
  namespace: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw definitionError(
        'EVAL_DEFINITION_DUPLICATE_ID',
        `“${namespace}”命名空间中存在重复 ID。`,
        { namespace, duplicateId: value },
      );
    }
    seen.add(value);
  }
}

export function assertReference(
  known: ReadonlySet<string>,
  referenceId: string,
  location: string,
  referenceKind: string,
): void {
  if (known.has(referenceId)) return;
  throw definitionError(
    'EVAL_DEFINITION_MISSING_REFERENCE',
    `“${location}”引用了不存在的${referenceKind}。`,
    { location, referenceKind, referenceId },
  );
}

export function resolvesPointer(value: unknown, pointer: string): boolean {
  return resolveJsonPointer(value, pointer).resolved;
}

import { createHash } from 'node:crypto';
import { z } from 'zod';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

export class InvalidCanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid RFC 8785 JSON value at ${path}: ${reason}`);
    this.name = 'InvalidCanonicalJsonError';
    this.path = path;
  }
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InvalidCanonicalJsonError(path, 'string contains an unpaired high surrogate');
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new InvalidCanonicalJsonError(path, 'string contains an unpaired low surrogate');
    }
  }
}

function assertDataProperty(
  owner: object,
  key: string,
  path: string,
): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new InvalidCanonicalJsonError(path, 'properties must be enumerable data properties');
  }
  return descriptor;
}

function assertCanonicalJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidCanonicalJsonError(path, 'numbers must be finite IEEE 754 doubles');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new InvalidCanonicalJsonError(path, `unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new InvalidCanonicalJsonError(path, 'cyclic references are not JSON');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === 'symbol')) {
        throw new InvalidCanonicalJsonError(path, 'symbol properties are not JSON');
      }
      const stringKeys = ownKeys.filter((key): key is string => typeof key === 'string');
      const expectedKeys = [...value.keys()].map(String);
      const nonLengthKeys = stringKeys.filter((key) => key !== 'length');
      if (
        value.length !== nonLengthKeys.length
        || expectedKeys.some((key, index) => nonLengthKeys[index] !== key)
      ) {
        throw new InvalidCanonicalJsonError(path, 'arrays must be dense and have no extra properties');
      }
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = childPath(path, index);
        const descriptor = assertDataProperty(value, String(index), itemPath);
        assertCanonicalJsonValue(descriptor.value, itemPath, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidCanonicalJsonError(path, 'objects must have Object.prototype or a null prototype');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new InvalidCanonicalJsonError(path, 'symbol properties are not JSON');
    }
    for (const key of ownKeys as string[]) {
      const propertyPath = childPath(path, key);
      assertUnicodeScalarString(key, propertyPath);
      const descriptor = assertDataProperty(value, key, propertyPath);
      assertCanonicalJsonValue(descriptor.value, propertyPath, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertCanonicalJson(value: unknown): asserts value is JsonValue {
  assertCanonicalJsonValue(value, '$', new Set());
}

export function isCanonicalJson(value: unknown): value is JsonValue {
  try {
    assertCanonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

export function parseWireDocument<T>(schema: z.ZodType<T>, value: unknown): T {
  assertCanonicalJson(value);
  return schema.parse(value);
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`)
    .join(',')}}`;
}

export function canonicalizeJson(value: unknown): string {
  assertCanonicalJson(value);
  return serializeCanonical(value);
}

export function canonicalizeJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}

export type Sha256Digest = `sha256:${string}`;

export function digestCanonicalJson(value: unknown): Sha256Digest {
  const hex = createHash('sha256').update(canonicalizeJsonBytes(value)).digest('hex');
  return `sha256:${hex}`;
}

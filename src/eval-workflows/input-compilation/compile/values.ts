import { type JsonValue } from '../../../eval-core/contracts/index.js';
import { CliEvaluationInputError } from '../error.js';

export function fail(input: ConstructorParameters<typeof CliEvaluationInputError>[0]): never {
  throw new CliEvaluationInputError(input);
}

export function canonicalSnapshot(
  value: unknown,
  path = '$',
  ancestors: Set<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail({
      code: 'CLI_INPUT_INVALID',
      fieldPath: path,
      message: `输入字段「${path}」必须是有限数值。`,
    });
    return value;
  }
  if (typeof value !== 'object' || value === null) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: path,
    message: `输入字段「${path}」必须可序列化为 JSON。`,
  });
  if (ancestors.has(value)) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: path,
    message: `输入字段「${path}」不得包含循环引用。`,
  });
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const expected = Array.from({ length: value.length }, (_, index) => String(index));
      const dataKeys = keys.filter((key): key is string => typeof key === 'string' && key !== 'length');
      if (keys.some((key) => typeof key === 'symbol')
          || dataKeys.length !== expected.length
          || dataKeys.some((key, index) => key !== expected[index])) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: path,
        message: `输入字段「${path}」必须是无额外属性的稠密数组。`,
      });
      return expected.map((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail({
          code: 'CLI_INPUT_INVALID',
          fieldPath: `${path}/${index}`,
          message: `输入字段「${path}/${index}」必须是普通数据属性。`,
        });
        return canonicalSnapshot(descriptor.value, `${path}/${index}`, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail({
      code: 'CLI_INPUT_INVALID',
      fieldPath: path,
      message: `输入字段「${path}」只能使用普通 JSON object。`,
    });
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: path,
        message: `输入字段「${path}」不得包含 symbol 属性。`,
      });
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `${path}/${key}`,
        message: `输入字段「${path}/${key}」必须是普通数据属性。`,
      });
      const child = descriptor.value;
      if (child === undefined) continue;
      result[key] = canonicalSnapshot(child, `${path}/${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function assertUnique(values: readonly string[], fieldPath: string): void {
  if (new Set(values).size === values.length) return;
  fail({
    code: 'CLI_INPUT_DUPLICATE_ID',
    fieldPath,
    message: `输入字段「${fieldPath}」包含重复标识。`,
  });
}

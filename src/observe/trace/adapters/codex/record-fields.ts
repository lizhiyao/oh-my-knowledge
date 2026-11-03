/** Codex rollout 单条记录的取值叶子：字段缺失或类型不符一律读成 undefined，不替来源编值。 */

export interface CodexRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

export function parseToolInput(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : { input: value };
  } catch {
    return { input: value };
  }
}

export function asCodexRecord(value: unknown): CodexRecord | undefined {
  return isObject(value) ? value as CodexRecord : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

export function nestedString(value: unknown, key: string): string | undefined {
  return isObject(value) ? stringValue(value[key]) : undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

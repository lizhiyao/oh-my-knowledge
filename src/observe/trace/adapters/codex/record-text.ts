/** Codex 记录正文的文本投影：同一内容在不同视图里的字段优先级只在这里定一次。 */

import { isObject, stringValue } from './record-fields.js';

export function codexContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!isObject(part)) return '';
    const text = stringValue(part.text) ?? stringValue(part.output_text);
    if (text) return text;
    return part.type === 'input_image' ? '[image]' : '';
  }).filter(Boolean).join('\n');
}

export function codexReasoningPlaintext(
  payload: Record<string, unknown>,
): { text: string; contentSource: 'summary' | 'content' | 'text' } | undefined {
  const summary = codexPlaintext(payload.summary);
  if (summary) return { text: summary, contentSource: 'summary' };
  const content = codexPlaintext(payload.content);
  if (content) return { text: content, contentSource: 'content' };
  const text = codexPlaintext(
    payload.text ?? payload.reasoning_text ?? payload.reasoningText,
  );
  return text ? { text, contentSource: 'text' } : undefined;
}

export function codexPlaintext(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => codexPlaintext(part, depth + 1))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (!isObject(value)) return '';
  for (const key of ['text', 'input_text', 'output_text', 'summary_text']) {
    const text = stringValue(value[key]);
    if (text) return text;
  }
  return codexPlaintext(value.content, depth + 1);
}

export function normalizeReasoningMirrorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

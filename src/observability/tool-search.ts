import type { ToolCallInfo } from '../types/index.js';

export function toolCallQuery(tc: ToolCallInfo): { query?: string; path?: string } {
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  if (tc.tool === 'Grep') return { query: String(input.pattern ?? ''), path: String(input.path ?? '') };
  if (tc.tool === 'Read') return { path: String(input.file_path ?? '') };
  if (tc.tool === 'Bash') return { query: String(input.command ?? '') };
  return {};
}

export function bashSearchOrProbeCommand(command: string): boolean {
  if (/\b(grep|rg|find)\b/.test(command)) return true;
  if (/2>\s*\/dev\/null|\|\|\s*(true|echo\b)/.test(command)) return true;
  return /\b(ls|test)\b.+(?:\/|\.\/|\.\.|~)/.test(command);
}

export function isSearchToolCall(tc: ToolCallInfo): boolean {
  if (tc.tool === 'Read' || tc.tool === 'Grep') return true;
  if (tc.tool !== 'Bash') return false;
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  return bashSearchOrProbeCommand(String(input.command ?? ''));
}

export function isFailedSearchToolCall(tc: ToolCallInfo): boolean {
  const output = typeof tc.output === 'string' ? tc.output : String(tc.output ?? '');
  const emptyOutput = output.trim() === '' || /No matches found/i.test(output);

  if (tc.tool === 'Read') {
    return tc.success === false;
  }

  if (tc.tool === 'Grep') {
    if (tc.success === false) return true;
    return emptyOutput;
  }

  if (tc.tool === 'Bash') {
    if (!isSearchToolCall(tc)) return false;
    if (tc.success === false) return true;
    return emptyOutput;
  }

  return false;
}

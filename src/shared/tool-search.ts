import type { ToolCallInfo } from '../types/index.js';
import { isToolCallCancelled, isToolCallFailure, isToolCallSuccess } from './tool-call-status.js';

export function toolCallQuery(tc: ToolCallInfo): { query?: string; path?: string } {
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  const legacyInput = typeof tc.input === 'string' ? tc.input : undefined;
  if (tc.tool === 'Grep') return { query: String(input.pattern ?? ''), path: String(input.path ?? '') };
  if (tc.tool === 'Read') return { path: String(input.file_path ?? legacyInput ?? '') };
  if (tc.tool === 'Bash') return bashStructuredQuery(String(input.command ?? legacyInput ?? ''));
  if (isWebSearchTool(tc.tool)) {
    return {
      query: typeof input.query === 'string' ? input.query : legacyInput,
      path: typeof input.url === 'string' ? input.url : undefined,
    };
  }
  return {};
}

/**
 * 把 Bash command 拆成结构化 query/path,而不是整段命令塞进 query 字段。
 *   - grep / rg / find -name 提取真实 pattern 进 query
 *   - ls / cat / test / head / tail / wc / file / stat / du 走 path-only
 * 否则 query/path 都为空,避免命令全文 (含 cwd / repo path) 污染同主题判定 ——
 * 比如 `Bash(ls /repos/payment-app/src/auth.ts)` 不会因为路径里含 "payment"
 * 而把前面 `Grep("payment")` 的 hard_miss 误降级为 exploratory_miss。
 */
function bashStructuredQuery(command: string): { query?: string; path?: string } {
  const grepRg = /\b(?:grep|rg)\b\s+([^|;&]+)/.exec(command);
  if (grepRg) {
    const args = grepRg[1].trim();
    const tokens = args.split(/\s+/);
    let i = 0;
    let pattern: string | undefined;
    let path: string | undefined;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.startsWith('-')) {
        // -e <pat> / --regexp=<pat>: 显式指定 pattern,优先使用它
        if (tok === '-e' || tok === '--regexp') {
          if (pattern == null && i + 1 < tokens.length) {
            pattern = tokens[i + 1].replace(/^['"]|['"]$/g, '');
          }
          i += 2;
          continue;
        }
        // 带值 flag 跳两格 (-f file / -m N / -A/-B/-C N / --include=... 已自带值)
        if (/^-(?:f|m|A|B|C)$/.test(tok)) {
          i += 2;
          continue;
        }
        // 其他 flag (-r/-R/-i/-l/-n/-v/-w/--include=*.ts 等) 跳一格
        i += 1;
        continue;
      }
      if (pattern == null) pattern = tok.replace(/^['"]|['"]$/g, '');
      else if (path == null && /[/.~]/.test(tok)) path = tok;
      i += 1;
    }
    if (pattern) return { query: pattern, ...(path ? { path } : {}) };
  }
  // find: 支持 -name / -iname / -path / -wholename
  const findName = /\bfind\b[^|;&]*?-(?:i?name|path|wholename)\s+['"]?([^'"\s]+)/.exec(command);
  if (findName) return { query: findName[1] };
  const path = shellReaderPath(command);
  if (path) return { path };
  return {};
}

function shellReaderPath(command: string): string | undefined {
  const match = /\b(ls|cat|test|head|tail|wc|file|stat|du|tree|sed|awk|less|more|bat)\b\s+([^|;&]+)/.exec(command);
  if (!match) return undefined;
  const tool = match[1];
  const tokens = shellWords(match[2]);
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    if (
      (tool === 'head' || tool === 'tail')
      && (token === '-n' || token === '-c')
      && index + 1 < tokens.length
    ) {
      index += 1;
      continue;
    }
    if (tool === 'sed' && (token === '-e' || token === '-f') && index + 1 < tokens.length) {
      index += 1;
    }
  }
  const candidate = tool === 'sed' || tool === 'awk'
    ? positional.at(-1)
    : positional[0];
  if (!candidate || /^\d+$/.test(candidate)) return undefined;
  return /^[\w./~]/.test(candidate) ? candidate : undefined;
}

function shellWords(value: string): string[] {
  return [...value.matchAll(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((token): token is string => Boolean(token));
}

export function bashSearchOrProbeCommand(command: string): boolean {
  if (/\b(grep|rg|find)\b/.test(command)) return true;
  if (/2>\s*\/dev\/null|\|\|\s*(true|echo\b)/.test(command)) return true;
  return /\b(ls|test)\b.+(?:\/|\.\/|\.\.|~)/.test(command);
}

export function isSearchToolCall(tc: ToolCallInfo): boolean {
  if (tc.tool === 'Read' || tc.tool === 'Grep') return true;
  if (isWebSearchTool(tc.tool)) return true;
  if (tc.tool !== 'Bash') return false;
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  const command = input.command ?? (typeof tc.input === 'string' ? tc.input : '');
  return bashSearchOrProbeCommand(String(command));
}

export function isFailedSearchToolCall(tc: ToolCallInfo): boolean {
  const output = typeof tc.output === 'string' ? tc.output : String(tc.output ?? '');
  // Runtime cancellation is authoritative. Some runtimes retain partial or
  // stale output text on cancellation; it must not become knowledge-gap evidence.
  if (isToolCallCancelled(tc)) return false;
  const explicitlyEmpty = /No matches found/i.test(output);
  // An unresolved call also has an empty output. That is missing evidence,
  // not evidence that a search completed with zero matches.
  const completedEmpty = output.trim() === '' && isToolCallSuccess(tc);

  if (tc.tool === 'Read') {
    return isToolCallFailure(tc);
  }

  if (tc.tool === 'Grep') {
    if (isToolCallFailure(tc)) return true;
    return explicitlyEmpty || completedEmpty;
  }

  if (isWebSearchTool(tc.tool)) {
    return isToolCallFailure(tc);
  }

  if (tc.tool === 'Bash') {
    if (!isSearchToolCall(tc)) return false;
    if (isToolCallFailure(tc)) return true;
    return explicitlyEmpty || completedEmpty;
  }

  return false;
}

function isWebSearchTool(tool: string): boolean {
  // `WebSearch` is the Trace IR canonical identity. Keep the old persisted spelling
  // readable because report schemas before v5 could contain runtime-native names.
  return tool === 'WebSearch' || tool === 'web_search';
}

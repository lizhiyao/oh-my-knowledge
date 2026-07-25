import type { ToolCallInfo } from '../types/index.js';

export function toolCallQuery(tc: ToolCallInfo): { query?: string; path?: string } {
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  if (tc.tool === 'Grep') return { query: String(input.pattern ?? ''), path: String(input.path ?? '') };
  if (tc.tool === 'Read') return { path: String(input.file_path ?? '') };
  if (tc.tool === 'Bash') return bashStructuredQuery(String(input.command ?? ''));
  if (tc.tool === 'web_search') {
    return {
      query: typeof input.query === 'string' ? input.query : undefined,
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
  // ls / cat / test / head / tail / wc / file / stat / du / tree → path-only。
  // 路径首字符限制 [\w./~]:
  //   - 排除 flag (`-` 开头) 防 `npm run test --watch` 把 `--watch` 当 path
  //   - 允许字母/数字/`.`/`/`/`~` 开头的 path token (foo / ./foo / /foo / ~/foo)
  const pathOnly = /\b(?:ls|cat|test|head|tail|wc|file|stat|du|tree)\b\s+(?:-\w+\s+)*([\w./~][^\s|;&]*)/.exec(command);
  if (pathOnly) return { path: pathOnly[1] };
  return {};
}

export function bashSearchOrProbeCommand(command: string): boolean {
  if (/\b(grep|rg|find)\b/.test(command)) return true;
  if (/2>\s*\/dev\/null|\|\|\s*(true|echo\b)/.test(command)) return true;
  return /\b(ls|test)\b.+(?:\/|\.\/|\.\.|~)/.test(command);
}

export function isSearchToolCall(tc: ToolCallInfo): boolean {
  if (tc.tool === 'Read' || tc.tool === 'Grep') return true;
  if (tc.tool === 'web_search') return true;
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

  if (tc.tool === 'web_search') {
    return tc.success === false;
  }

  if (tc.tool === 'Bash') {
    if (!isSearchToolCall(tc)) return false;
    if (tc.success === false) return true;
    return emptyOutput;
  }

  return false;
}

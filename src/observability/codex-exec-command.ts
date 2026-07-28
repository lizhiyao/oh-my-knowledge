/** Static extraction for Codex Desktop's JavaScript exec bridge. */

function skipJsString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function skipJsTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      return newline < 0 ? source.length : skipJsTrivia(source, newline + 1);
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      return end < 0 ? source.length : skipJsTrivia(source, end + 2);
    }
    break;
  }
  return index;
}

function commandPropertyEnd(source: string, index: number): number | null {
  const bareKey = source.startsWith('cmd', index)
    && !/[\w$]/.test(source[index - 1] ?? '')
    && !/[\w$]/.test(source[index + 3] ?? '');
  if (bareKey) return index + 3;

  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  const end = skipJsString(source, index);
  return source.slice(index + 1, end - 1) === 'cmd' ? end : null;
}

function commandLiteralValue(source: string, start: number, end: number): string {
  const literal = source.slice(start, end);
  if (source[start] === '"') {
    try {
      const parsed = JSON.parse(literal);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Fall through to the lossless source slice for non-JSON JS escapes.
    }
  }
  return source.slice(start + 1, Math.max(start + 1, end - 1));
}

function extractExecCommandLiteral(source: string, callStart: number): string | null {
  let index = skipJsTrivia(source, callStart + 'tools.exec_command'.length);
  if (source[index] !== '(') return null;
  index = skipJsTrivia(source, index + 1);
  if (source[index] !== '{') return null;

  let depth = 1;
  index += 1;
  while (index < source.length && depth > 0) {
    index = skipJsTrivia(source, index);
    const char = source[index];
    if (depth === 1) {
      const keyEnd = commandPropertyEnd(source, index);
      if (keyEnd !== null) {
        let valueStart = skipJsTrivia(source, keyEnd);
        if (source[valueStart] !== ':') {
          index = keyEnd;
          continue;
        }
        valueStart = skipJsTrivia(source, valueStart + 1);
        const quote = source[valueStart];
        if (quote !== '"' && quote !== "'" && quote !== '`') return null;
        const end = skipJsString(source, valueStart);
        return commandLiteralValue(source, valueStart, end);
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipJsString(source, index);
      continue;
    }
    if (char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  return null;
}

/**
 * Extract only literal `cmd` values from real `tools.exec_command(...)` calls.
 * The bridge source is never evaluated, and examples inside strings/comments
 * remain ignored.
 */
export function extractCodexExecCommands(source: string): string[] {
  const commands: string[] = [];
  let index = 0;
  while (index < source.length) {
    index = skipJsTrivia(source, index);
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipJsString(source, index);
      continue;
    }
    if (
      source.startsWith('tools.exec_command', index)
      && !/[\w$.]/.test(source[index - 1] ?? '')
      && !/[\w$]/.test(source[index + 'tools.exec_command'.length] ?? '')
    ) {
      const command = extractExecCommandLiteral(source, index);
      if (command) commands.push(command);
      index += 'tools.exec_command'.length;
      continue;
    }
    index += 1;
  }
  return commands;
}

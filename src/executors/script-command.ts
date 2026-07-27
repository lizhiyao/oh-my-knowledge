import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

const SCRIPT_FILE_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'bash',
  'sh',
  'zsh',
  'ruby',
  'perl',
  'php',
  'bun',
  'deno',
]);

const SCRIPTLESS_INTERPRETER_FLAGS_WITH_VALUE = new Set([
  '-m',
  '-c',
  '-e',
  '-p',
  '--eval',
  '--print',
]);

export interface ResolvedScriptCommand {
  command: string;
  args: string[];
  /** Existing local files that can change the command's behavior. */
  referencedFiles: string[];
}

export function isScriptFileInterpreter(commandPath: string): boolean {
  const name = basename(commandPath).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return SCRIPT_FILE_INTERPRETERS.has(name) || /^python(?:\d+(?:\.\d+)*)?$/.test(name);
}

function isBareScriptFileArg(part: string): boolean {
  return !part.includes('/')
    && !part.startsWith('.')
    && /\.(?:cjs|cts|js|jsx|mjs|mts|php|pl|py|pyw|rb|sh|ts|tsx)$/i.test(part);
}

function isInlineScriptlessInterpreterFlag(arg: string): boolean {
  return /^(?:--eval=|--print=|-[mcep].+)/.test(arg);
}

function resolveExecutorPath(
  part: string,
  baseCwd: string,
  options: { resolveBare?: boolean } = {},
): string {
  if (isAbsolute(part)) return part;
  if (part.startsWith('-')) return part;
  const pathLike = part.includes('/') || part.startsWith('.');
  if (!pathLike && !options.resolveBare) return part;
  const candidate = resolve(baseCwd, part);
  return existsSync(candidate) ? candidate : part;
}

function resolveExecutorArgs(
  args: string[],
  commandPath: string,
  baseCwd: string,
): string[] {
  if (!isScriptFileInterpreter(commandPath)) {
    return args.map((arg) => resolveExecutorPath(arg, baseCwd));
  }

  let scriptResolved = false;
  let scriptPositionClosed = false;
  let skipNext = false;
  return args.map((arg) => {
    if (skipNext) {
      skipNext = false;
      return arg;
    }
    if (!scriptResolved && !scriptPositionClosed) {
      if (SCRIPTLESS_INTERPRETER_FLAGS_WITH_VALUE.has(arg)) {
        skipNext = true;
        scriptPositionClosed = true;
        return arg;
      }
      if (isInlineScriptlessInterpreterFlag(arg)) {
        scriptPositionClosed = true;
        return arg;
      }
      if (arg.startsWith('-') && arg !== '--') return arg;
      if (arg === '--') return arg;
      scriptResolved = true;
      return resolveExecutorPath(arg, baseCwd, {
        resolveBare: isBareScriptFileArg(arg),
      });
    }
    return resolveExecutorPath(arg, baseCwd);
  });
}

export function resolveScriptCommand(
  commandLine: string,
  baseCwd = process.cwd(),
): ResolvedScriptCommand {
  const parts = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [commandLine];
  const command = resolveExecutorPath(
    parts[0].replace(/^["']|["']$/g, ''),
    baseCwd,
  );
  const rawArgs = parts.slice(1).map((arg) => arg.replace(/^["']|["']$/g, ''));
  const args = resolveExecutorArgs(rawArgs, command, baseCwd);
  const referencedFiles = [command, ...args].filter(
    (part) => isAbsolute(part) && existsSync(part),
  );
  return { command, args, referencedFiles };
}

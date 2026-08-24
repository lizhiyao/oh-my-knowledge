import { Config, type Command } from '@oclif/core';
import { format } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

type CommandClass = {
  new (argv: string[], config: Config): Command;
  id: string;
  name: string;
};
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPromises = new Map<string, Promise<Config>>();

function commandConfig(): Promise<Config> {
  const key = [
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_DATA_HOME,
  ].join('\0');
  let promise = configPromises.get(key);
  if (!promise) {
    promise = Config.load(PROJECT_ROOT);
    configPromises.set(key, promise);
  }
  return promise;
}

export interface RunCommandOptions {
  cwd?: string;
  /** Environment overrides merged onto the current test-process environment. */
  env?: NodeJS.ProcessEnv;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface CommandRunError extends Error, CommandOutput {
  code: number;
  cause: unknown;
}

function exitCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; exitCode?: unknown; oclif?: { exit?: unknown } };
  if (typeof candidate.oclif?.exit === 'number') return candidate.oclif.exit;
  if (typeof candidate.exitCode === 'number') return candidate.exitCode;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
}

function chunkText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

/**
 * Runs one source oclif Command class in-process through its full lifecycle.
 * Dispatcher/startup and module-load-sensitive contracts still use a real
 * `node dist/cli/index.js` process. `options.env` merges runtime overrides onto
 * the current process environment; env-derived constants initialized while
 * importing modules still require a process test.
 */
export async function runCommand(
  CommandType: CommandClass,
  argv: string[],
  options: RunCommandOptions = {},
): Promise<CommandOutput> {
  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const previousExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';

  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunkText(chunk);
    return true;
  }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunkText(chunk);
    return true;
  }) as typeof process.stderr.write);
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += format(...args) + '\n';
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += format(...args) + '\n';
  });

  try {
    process.argv = [process.execPath, 'omk', ...argv];
    if (options.cwd) process.chdir(options.cwd);
    if (options.env) Object.assign(process.env, options.env);

    const command = new CommandType(argv, await commandConfig());
    if (!command.id) command.id = CommandType.name.toLowerCase();
    await (command as Command & { _run(): Promise<unknown> })._run();
    return { stdout, stderr };
  } catch (cause) {
    const code = exitCodeOf(cause) ?? 1;
    if (cause instanceof Error && stderr.length === 0) stderr += cause.message + '\n';
    const error = new Error(cause instanceof Error ? cause.message : `Command exited with code ${code}`) as CommandRunError;
    error.code = code;
    error.stdout = stdout;
    error.stderr = stderr;
    error.cause = cause;
    throw error;
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    consoleLog.mockRestore();
    consoleError.mockRestore();
  }
}

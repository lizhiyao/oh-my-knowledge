import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecEnv } from './shared.js';
import {
  isScriptFileInterpreter,
  resolveScriptCommand,
} from './script-command.js';
import type {
  ExecutorFn,
  ExecutorRuntimeBinary,
  ExecutorRuntimeCapabilities,
  ExecutorRuntimeFingerprint,
  ExecutorRuntimeKind,
  ExecutorRuntimePackage,
} from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

const RUNTIME_CACHE = new Map<string, ExecutorRuntimeFingerprint>();

const UNKNOWN_CAPABILITIES: ExecutorRuntimeCapabilities = {
  systemPrompt: 'unknown',
  costUSD: 'unknown',
  trace: 'unknown',
  skillIsolation: 'unknown',
};

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return '{' + entries.map((k) => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

function packagePathSegments(packageName: string): string[] {
  return packageName.split('/');
}

function findInstalledPackageJson(packageName: string): string | null {
  const parts = packagePathSegments(packageName);
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', ...parts, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findNearestPackageJson(fromPath: string): string | null {
  let dir = dirname(fromPath);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readInvokingDshPackage(): {
  entrypoint?: string;
  package: ExecutorRuntimePackage;
} {
  const entrypoint = process.argv[1];
  if (!entrypoint || !isAbsolute(entrypoint)) {
    return {
      package: { name: '@deepseek-ai/dsh', error: 'DSH host entrypoint not found' },
    };
  }
  let dir = dirname(entrypoint);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@deepseek-ai/dsh') {
          return {
            entrypoint,
            package: {
              name: pkg.name,
              ...(pkg.version ? { version: pkg.version } : {}),
            },
          };
        }
      } catch {
        // Keep walking: a parent package may still be the DSH CLI package.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    entrypoint,
    package: { name: '@deepseek-ai/dsh', error: 'invoking @deepseek-ai/dsh package.json not found' },
  };
}

function resolvePackageJson(packageName: string, from?: string): string | null {
  const req = from ? createRequire(from) : requireFromHere;
  try {
    try {
      return req.resolve(`${packageName}/package.json`);
    } catch {
      const entry = req.resolve(packageName);
      return findNearestPackageJson(entry);
    }
  } catch {
    return findInstalledPackageJson(packageName);
  }
}

function readPackage(packageName: string, from?: string): ExecutorRuntimePackage {
  const packageJson = resolvePackageJson(packageName, from);
  if (!packageJson) {
    return { name: packageName, error: 'package.json not found' };
  }
  try {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: string };
    return { name: packageName, ...(pkg.version ? { version: pkg.version } : {}) };
  } catch (err) {
    return { name: packageName, error: err instanceof Error ? err.message : String(err) };
  }
}

function readPackageField<T = unknown>(packageName: string, field: string, from?: string): T | undefined {
  const packageJson = resolvePackageJson(packageName, from);
  if (!packageJson) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf-8')) as Record<string, unknown>;
    return pkg[field] as T | undefined;
  } catch {
    return undefined;
  }
}

function readCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 3000): { output?: string; error?: string } {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    }).trim();
    return { output };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function resolvePathBinary(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command) && existsSync(command)) return command;
  const pathValue = env.PATH || '';
  const pathExt = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of pathExt) {
      const candidate = join(dir, process.platform === 'win32' && ext && !command.toUpperCase().endsWith(ext) ? `${command}${ext}` : command);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function readPathBinary(command: string, env: NodeJS.ProcessEnv): ExecutorRuntimeBinary {
  const version = readCommand(command, ['--version'], env);
  const path = resolvePathBinary(command, env);
  return {
    name: command,
    source: 'path',
    ...(version.output ? { version: version.output.split('\n')[0].trim() } : {}),
    ...(path ? { path } : {}),
    ...(!version.output && version.error ? { error: version.error } : {}),
  };
}

function withFingerprint(input: Omit<ExecutorRuntimeFingerprint, 'fingerprint'>): ExecutorRuntimeFingerprint {
  const stablePayload = {
    executor: input.executor,
    model: input.model,
    runtimeKind: input.runtimeKind,
    binary: input.binary
      ? {
        name: input.binary.name,
        source: input.binary.source,
        version: input.binary.version,
        contentHash: input.binary.contentHash,
        status: input.binary.version ? 'ok' : input.binary.error ? 'error' : 'missing',
        package: input.binary.package
          ? {
            name: input.binary.package.name,
            version: input.binary.package.version,
            status: input.binary.package.version ? 'ok' : input.binary.package.error ? 'error' : 'missing',
          }
          : undefined,
      }
      : undefined,
    sdk: input.sdk
      ? {
        name: input.sdk.name,
        version: input.sdk.version,
        status: input.sdk.version ? 'ok' : input.sdk.error ? 'error' : 'missing',
      }
      : undefined,
    auditability: input.auditability,
    capabilities: input.capabilities,
  };
  return { ...input, fingerprint: hashString(canonicalStringify(stablePayload)) };
}

function runtime(
  executor: string,
  model: string,
  kind: ExecutorRuntimeKind,
  capabilities: ExecutorRuntimeCapabilities,
  extra: Pick<ExecutorRuntimeFingerprint, 'binary' | 'sdk' | 'auditability'> = {},
): ExecutorRuntimeFingerprint {
  return withFingerprint({
    executor,
    model,
    runtimeKind: kind,
    capabilities,
    ...extra,
  });
}

export interface DshHostRuntimeIdentity {
  provider?: string;
  agentPreset?: string;
  toolSchemas?: readonly unknown[];
}

function ownPackage(): ExecutorRuntimePackage {
  const packageJson = findNearestPackageJson(fileURLToPath(import.meta.url));
  if (!packageJson) return { name: 'oh-my-knowledge', error: 'package.json not found' };
  try {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf-8')) as {
      name?: string;
      version?: string;
    };
    return {
      name: pkg.name ?? 'oh-my-knowledge',
      ...(pkg.version ? { version: pkg.version } : {}),
    };
  } catch (error) {
    return {
      name: 'oh-my-knowledge',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function dshCompositionHash(identity: DshHostRuntimeIdentity): string {
  return createHash('sha256').update(canonicalStringify({
    adapter: 'omk-dsh-host-v1',
    provider: identity.provider ?? null,
    agentPreset: identity.agentPreset ?? null,
    toolSchemas: identity.toolSchemas ?? null,
  })).digest('hex');
}

export interface ExecutorRuntimeFingerprintOptions {
  skillDir?: string | null;
  env?: NodeJS.ProcessEnv;
}

function runtimeEnv(options: ExecutorRuntimeFingerprintOptions | undefined): NodeJS.ProcessEnv {
  return options?.env ?? buildExecEnv(options?.skillDir);
}

function hashRuntimeFiles(paths: string[]): {
  contentHash?: string;
  error?: string;
} {
  const files = [...new Set(paths)]
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  if (files.length === 0) return {};
  const hash = createHash('sha256');
  const errors: string[] = [];
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    try {
      hash.update(readFileSync(path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${path}: ${message}`);
      hash.update(`<unreadable:${message}>`);
    }
    hash.update('\0');
  }
  return {
    contentHash: hash.digest('hex'),
    ...(errors.length > 0 && { error: errors.join('; ') }),
  };
}

function scriptRuntime(
  executorName: string,
  model: string,
  env: NodeJS.ProcessEnv,
): ExecutorRuntimeFingerprint {
  const resolved = resolveScriptCommand(executorName);
  const executablePath = resolvePathBinary(resolved.command, env);
  const interpreter = isScriptFileInterpreter(resolved.command);
  const executable: ExecutorRuntimeBinary = interpreter
    ? readPathBinary(resolved.command, env)
    : {
      name: resolved.command,
      source: executablePath ? 'path' as const : 'unknown' as const,
      ...(executablePath && { path: executablePath }),
      ...(!executablePath && { error: 'executable not found on PATH' }),
    };
  const fileIdentity = hashRuntimeFiles([
    ...resolved.referencedFiles,
    ...(!interpreter && executablePath ? [executablePath] : []),
  ]);
  const errors = [executable.error, fileIdentity.error].filter(Boolean).join('; ');
  return runtime(executorName, model, 'script', {
    ...UNKNOWN_CAPABILITIES,
    trace: 'best-effort',
    skillIsolation: 'none',
  }, {
    binary: {
      ...executable,
      ...(fileIdentity.contentHash && {
        contentHash: fileIdentity.contentHash,
      }),
      ...(errors && { error: errors }),
    },
  });
}

export function createDshHostRuntimeFingerprint(
  model: string,
  identity: DshHostRuntimeIdentity = {},
): ExecutorRuntimeFingerprint {
  const host = readInvokingDshPackage();
  return runtime('dsh-host', model, 'agent-sdk', {
    systemPrompt: 'native',
    costUSD: 'not-reported',
    trace: 'native',
    skillIsolation: 'full-no-partial',
  }, {
    binary: {
      name: '@deepseek-ai/dsh',
      source: host.package.version ? 'path' : 'unknown',
      ...(host.package.version ? { version: host.package.version } : {}),
      ...(host.entrypoint ? { path: host.entrypoint } : {}),
      contentHash: dshCompositionHash(identity),
      package: host.package,
      ...(host.package.error ? { error: host.package.error } : {}),
    },
    sdk: ownPackage(),
    auditability: {
      status: 'partial',
      reasons: [
        'DSH does not expose a canonical digest for every active plugin and policy; the fingerprint covers provider, agent preset, and effective tool schemas',
      ],
    },
  });
}

export function resolveExecutorRuntimeFingerprint(
  executorName: string,
  model: string,
  options: ExecutorRuntimeFingerprintOptions = {},
  executor?: ExecutorFn,
): ExecutorRuntimeFingerprint {
  return executor?.runtimeFingerprint?.(model, options)
    ?? getExecutorRuntimeFingerprint(executorName, model, options);
}

export function getExecutorRuntimeFingerprint(
  executorName: string,
  model: string,
  options: ExecutorRuntimeFingerprintOptions = {},
): ExecutorRuntimeFingerprint {
  const env = runtimeEnv(options);
  if (![
    'claude',
    'claude-sdk',
    'codex',
    'codex-sdk',
    'dsh-host',
    'gemini',
    'anthropic-api',
    'openai-api',
  ].includes(executorName)) {
    // Custom executors are local code. Re-read their referenced files so a
    // long-running Studio process cannot reuse stale outputs after the script
    // changes while the command line remains identical.
    return scriptRuntime(executorName, model, env);
  }
  if (executorName === 'dsh-host') return createDshHostRuntimeFingerprint(model);
  const pathHash = hashString(env.PATH || '');
  const cacheKey = `${executorName}\0${model}\0${pathHash}`;
  const cached = RUNTIME_CACHE.get(cacheKey);
  if (cached) return structuredClone(cached);

  let fp: ExecutorRuntimeFingerprint;
  switch (executorName) {
    case 'claude': {
      fp = runtime(executorName, model, 'agent-cli', {
        systemPrompt: 'native',
        costUSD: 'reported',
        trace: 'native',
        skillIsolation: 'full-no-partial',
      }, { binary: readPathBinary('claude', env) });
      break;
    }
    case 'claude-sdk': {
      const sdkPackageJson = resolvePackageJson('@anthropic-ai/claude-agent-sdk');
      const sdk = readPackage('@anthropic-ai/claude-agent-sdk', sdkPackageJson ?? undefined);
      const claudeCodeVersion = readPackageField<string>('@anthropic-ai/claude-agent-sdk', 'claudeCodeVersion', sdkPackageJson ?? undefined);
      fp = runtime(executorName, model, 'agent-sdk', {
        systemPrompt: 'native',
        costUSD: 'reported',
        trace: 'native',
        skillIsolation: 'full',
      }, {
        sdk,
        binary: {
          name: 'claude-code',
          source: 'bundled',
          ...(claudeCodeVersion ? { version: claudeCodeVersion } : {}),
          package: sdk,
        },
      });
      break;
    }
    case 'codex': {
      fp = runtime(executorName, model, 'agent-cli', {
        systemPrompt: 'prepended',
        costUSD: 'not-reported',
        trace: 'best-effort',
        skillIsolation: 'cwd-only',
      }, { binary: readPathBinary('codex', env) });
      break;
    }
    case 'codex-sdk': {
      const sdkPackageJson = resolvePackageJson('@openai/codex-sdk');
      const sdk = readPackage('@openai/codex-sdk', sdkPackageJson ?? undefined);
      const bundledCodex = readPackage('@openai/codex', sdkPackageJson ?? undefined);
      fp = runtime(executorName, model, 'agent-sdk', {
        systemPrompt: 'prepended',
        costUSD: 'not-reported',
        trace: 'best-effort',
        skillIsolation: 'cwd-only',
      }, {
        sdk,
        binary: {
          name: 'codex',
          source: 'bundled',
          ...(bundledCodex.version ? { version: bundledCodex.version } : {}),
          package: bundledCodex,
        },
      });
      break;
    }
    case 'gemini': {
      fp = runtime(executorName, model, 'agent-cli', {
        systemPrompt: 'prepended',
        costUSD: 'not-reported',
        trace: 'none',
        skillIsolation: 'none',
      }, { binary: readPathBinary('gemini', env) });
      break;
    }
    case 'anthropic-api':
    case 'openai-api': {
      fp = runtime(executorName, model, 'api', {
        systemPrompt: 'native',
        costUSD: 'not-reported',
        trace: 'none',
        skillIsolation: 'none',
      }, { binary: { name: executorName, source: 'none' } });
      break;
    }
    default:
      throw new Error(`unreachable executor runtime: ${executorName}`);
  }

  RUNTIME_CACHE.set(cacheKey, structuredClone(fp));
  return structuredClone(fp);
}

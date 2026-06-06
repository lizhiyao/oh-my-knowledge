import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecEnv } from './shared.js';
import type {
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

function readCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 1000): { output?: string; error?: string } {
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
    kind: input.runtimeKind,
    binary: input.binary
      ? {
        name: input.binary.name,
        source: input.binary.source,
        version: input.binary.version,
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
    capabilities: input.capabilities,
  };
  return { ...input, fingerprint: hashString(canonicalStringify(stablePayload)) };
}

function runtime(
  executor: string,
  model: string,
  kind: ExecutorRuntimeKind,
  capabilities: ExecutorRuntimeCapabilities,
  extra: Pick<ExecutorRuntimeFingerprint, 'binary' | 'sdk'> = {},
): ExecutorRuntimeFingerprint {
  return withFingerprint({
    executor,
    model,
    runtimeKind: kind,
    capabilities,
    ...extra,
  });
}

export interface ExecutorRuntimeFingerprintOptions {
  skillDir?: string | null;
  env?: NodeJS.ProcessEnv;
}

function runtimeEnv(options: ExecutorRuntimeFingerprintOptions | undefined): NodeJS.ProcessEnv {
  return options?.env ?? buildExecEnv(options?.skillDir);
}

export function getExecutorRuntimeFingerprint(
  executorName: string,
  model: string,
  options: ExecutorRuntimeFingerprintOptions = {},
): ExecutorRuntimeFingerprint {
  const env = runtimeEnv(options);
  const pathHash = hashString(env.PATH || '');
  const cacheKey = `${executorName}\0${model}\0${pathHash}`;
  const cached = RUNTIME_CACHE.get(cacheKey);
  if (cached) return cached;

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
    default: {
      fp = runtime(executorName, model, 'script', UNKNOWN_CAPABILITIES, {
        binary: { name: executorName, source: 'unknown' },
      });
    }
  }

  RUNTIME_CACHE.set(cacheKey, fp);
  return fp;
}

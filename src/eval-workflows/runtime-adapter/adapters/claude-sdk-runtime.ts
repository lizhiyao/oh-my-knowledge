import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ContentIdentityFile } from './content-identity.js';

const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export interface ClaudeSdkQueryOptions {
  readonly abortController: AbortController;
  readonly allowDangerouslySkipPermissions: true;
  readonly cwd: string;
  readonly disallowedTools?: readonly string[];
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs?: Readonly<Record<string, string | null>>;
  readonly hooks?: Readonly<Record<string, readonly unknown[]>>;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly model: string;
  readonly permissionMode: 'bypassPermissions';
  readonly persistSession: false;
  readonly settingSources: readonly [];
  readonly skills?: readonly [];
  readonly strictMcpConfig: true;
  readonly systemPrompt?: {
    readonly type: 'preset';
    readonly preset: 'claude_code';
    readonly append: string;
  };
  readonly tools?: readonly string[];
}

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  close(): void;
}

export interface ClaudeSdkQueryInput {
  readonly prompt: string;
  readonly options: ClaudeSdkQueryOptions;
}

export interface ResolvedClaudeSdkRuntime {
  readonly sdkVersion: string;
  readonly claudeCodeVersion: string;
  readonly contentIdentityFiles: readonly ContentIdentityFile[];
  createQuery(input: Readonly<ClaudeSdkQueryInput>): ClaudeSdkQuery | Promise<ClaudeSdkQuery>;
}

export type ClaudeSdkRuntimeResolver = () => Promise<ResolvedClaudeSdkRuntime>;

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly claudeCodeVersion?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface ClaudeSdkModule {
  readonly query: (input: Readonly<ClaudeSdkQueryInput>) => ClaudeSdkQuery;
}

async function readPackageManifest(path: string, expectedName: string): Promise<PackageManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new TypeError(`Claude SDK runtime package ${expectedName} is unavailable.`);
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Record<string, unknown>).name !== expectedName
    || typeof (value as Record<string, unknown>).version !== 'string'
    || (value as Record<string, unknown>).version === ''
  ) throw new TypeError(`Claude SDK runtime package ${expectedName} has an invalid manifest.`);
  return value as PackageManifest;
}

function platformPackageNames(): readonly string[] {
  const key = `${platform}:${arch}`;
  const report = process.report?.getReport() as {
    readonly header?: { readonly glibcVersionRuntime?: string };
  } | undefined;
  const linuxMusl = platform === 'linux'
    && report?.header?.glibcVersionRuntime === undefined;
  const packages: Readonly<Record<string, readonly string[]>> = {
    'linux:x64': linuxMusl
      ? ['@anthropic-ai/claude-agent-sdk-linux-x64-musl', '@anthropic-ai/claude-agent-sdk-linux-x64']
      : ['@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl'],
    'linux:arm64': linuxMusl
      ? ['@anthropic-ai/claude-agent-sdk-linux-arm64-musl', '@anthropic-ai/claude-agent-sdk-linux-arm64']
      : ['@anthropic-ai/claude-agent-sdk-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-arm64-musl'],
    'darwin:x64': ['@anthropic-ai/claude-agent-sdk-darwin-x64'],
    'darwin:arm64': ['@anthropic-ai/claude-agent-sdk-darwin-arm64'],
    'win32:x64': ['@anthropic-ai/claude-agent-sdk-win32-x64'],
    'win32:arm64': ['@anthropic-ai/claude-agent-sdk-win32-arm64'],
  };
  const names = packages[key];
  if (names === undefined) throw new TypeError(`Claude SDK does not support ${key}.`);
  return names;
}

async function identityFilesInDirectory(
  root: string,
  facetNamespace: string,
  current = root,
): Promise<readonly ContentIdentityFile[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    throw new TypeError('Claude SDK runtime package tree is unavailable.');
  }
  const files: ContentIdentityFile[] = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    if (current === root && entry.name === 'node_modules' && entry.isDirectory()) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await identityFilesInDirectory(root, facetNamespace, path));
    } else if (entry.isFile()) {
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const pathDigest = createHash('sha256').update(relativePath).digest('hex');
      files.push({ facetId: `${facetNamespace}.file.${pathDigest}`, path });
    } else {
      throw new TypeError('Claude SDK runtime package contains an unsupported entry.');
    }
  }
  return files;
}

/** Resolves the optional peer once per adapter assembly; no process-level cache is used. */
export async function resolveInstalledClaudeSdkRuntime(): Promise<ResolvedClaudeSdkRuntime> {
  let sdkEntrypointPath: string;
  try {
    const sdkEntrypointUrl = import.meta.resolve(CLAUDE_AGENT_SDK_PACKAGE);
    if (!sdkEntrypointUrl.startsWith('file:')) throw new TypeError();
    sdkEntrypointPath = fileURLToPath(sdkEntrypointUrl);
  } catch {
    throw new TypeError('Claude SDK optional peer dependency is unavailable.');
  }
  const sdkPackageManifestPath = join(dirname(sdkEntrypointPath), 'package.json');
  const sdkManifest = await readPackageManifest(sdkPackageManifestPath, CLAUDE_AGENT_SDK_PACKAGE);
  if (typeof sdkManifest.claudeCodeVersion !== 'string' || sdkManifest.claudeCodeVersion === '') {
    throw new TypeError('Claude SDK package does not declare its bundled Claude Code version.');
  }
  const sdkPackageRoot = dirname(sdkPackageManifestPath);
  const sdkFiles = await identityFilesInDirectory(sdkPackageRoot, 'claude-sdk');
  if (!sdkFiles.some((file) => file.path === sdkEntrypointPath)) {
    throw new TypeError('Claude SDK package entrypoint is outside its package tree.');
  }
  const platformPackages = platformPackageNames();
  const sdkRequire = createRequire(sdkPackageManifestPath);
  let platformPackageManifestPath: string;
  let platformPackage: string | undefined;
  for (const candidate of platformPackages) {
    try {
      platformPackageManifestPath = sdkRequire.resolve(`${candidate}/package.json`);
      platformPackage = candidate;
      break;
    } catch {
      // Match the SDK's preferred libc package with an official fallback.
    }
  }
  if (platformPackage === undefined || platformPackageManifestPath! === undefined) {
    throw new TypeError('Claude SDK bundled Claude Code package is unavailable.');
  }
  const platformManifest = await readPackageManifest(platformPackageManifestPath, platformPackage);
  if (
    sdkManifest.optionalDependencies?.[platformPackage] !== platformManifest.version
    || platformManifest.version !== sdkManifest.version
  ) throw new TypeError('Claude SDK and bundled Claude Code package versions are inconsistent.');
  const platformRoot = dirname(platformPackageManifestPath);
  const platformFiles = await identityFilesInDirectory(platformRoot, 'claude-native');
  const executablePath = join(platformRoot, platform === 'win32' ? 'claude.exe' : 'claude');
  if (!platformFiles.some((file) => file.path === executablePath)) {
    throw new TypeError('Claude SDK bundled Claude Code executable is unavailable.');
  }
  const sdkModuleUrl = pathToFileURL(sdkEntrypointPath);
  sdkModuleUrl.searchParams.set('omk-runtime-instance', randomUUID());
  const contentIdentityFiles = Object.freeze([
    ...sdkFiles.map((file) => {
      if (file.path === sdkPackageManifestPath) {
        return { ...file, facetId: 'claude-sdk.package-manifest' };
      }
      if (file.path === sdkEntrypointPath) {
        return { ...file, facetId: 'claude-sdk.entrypoint' };
      }
      return file;
    }),
    ...platformFiles.map((file) => {
      if (file.path === platformPackageManifestPath) {
        return { ...file, facetId: 'claude-native.package-manifest' };
      }
      if (file.path === executablePath) {
        return { ...file, facetId: 'claude-native.executable' };
      }
      return file;
    }),
  ]);
  return Object.freeze({
    sdkVersion: sdkManifest.version,
    claudeCodeVersion: sdkManifest.claudeCodeVersion,
    contentIdentityFiles,
    async createQuery(input: Readonly<ClaudeSdkQueryInput>): Promise<ClaudeSdkQuery> {
      let sdkModule: ClaudeSdkModule;
      try {
        sdkModule = await import(sdkModuleUrl.href) as ClaudeSdkModule;
      } catch {
        throw new TypeError('Claude SDK optional peer dependency could not be loaded.');
      }
      if (typeof sdkModule.query !== 'function') {
        throw new TypeError('Claude SDK optional peer dependency has an invalid module shape.');
      }
      return sdkModule.query(input);
    },
  });
}

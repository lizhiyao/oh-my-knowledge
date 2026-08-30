import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { arch, platform } from 'node:process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CodexContentIdentityFile } from './codex-content-identity.js';

const CODEX_SDK_PACKAGE = '@openai/codex-sdk';
const CODEX_PACKAGE = '@openai/codex';

export interface CodexSdkThreadOptions {
  readonly model?: string;
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly workingDirectory?: string;
  readonly skipGitRepoCheck?: boolean;
  readonly modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly networkAccessEnabled?: boolean;
  readonly webSearchMode?: 'disabled' | 'cached' | 'live';
  readonly approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
}

export interface CodexSdkThread {
  runStreamed(input: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<{
    readonly events: AsyncIterable<unknown>;
  }>;
}

export interface CodexSdkClient {
  startThread(options?: CodexSdkThreadOptions): CodexSdkThread;
}

export interface CodexSdkClientOptions {
  readonly env: Record<string, string>;
}

export interface ResolvedCodexSdkRuntime {
  readonly sdkVersion: string;
  readonly codexVersion: string;
  readonly contentIdentityFiles: readonly CodexContentIdentityFile[];
  createClient(options: CodexSdkClientOptions): CodexSdkClient | Promise<CodexSdkClient>;
}

export type CodexSdkRuntimeResolver = () => Promise<ResolvedCodexSdkRuntime>;

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface CodexSdkModule {
  readonly Codex: new(options?: CodexSdkClientOptions) => CodexSdkClient;
}

async function readPackageManifest(path: string, expectedName: string): Promise<PackageManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new TypeError(`Codex SDK runtime package ${expectedName} is unavailable.`);
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Record<string, unknown>).name !== expectedName
    || typeof (value as Record<string, unknown>).version !== 'string'
    || (value as Record<string, unknown>).version === ''
  ) throw new TypeError(`Codex SDK runtime package ${expectedName} has an invalid manifest.`);
  return value as PackageManifest;
}

function targetTriple(): string {
  const key = `${platform}:${arch}`;
  const triples: Readonly<Record<string, string>> = {
    'linux:x64': 'x86_64-unknown-linux-musl',
    'linux:arm64': 'aarch64-unknown-linux-musl',
    'android:x64': 'x86_64-unknown-linux-musl',
    'android:arm64': 'aarch64-unknown-linux-musl',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc',
    'win32:arm64': 'aarch64-pc-windows-msvc',
  };
  const triple = triples[key];
  if (triple === undefined) throw new TypeError(`Codex SDK does not support ${key}.`);
  return triple;
}

function platformPackageName(): string {
  const key = `${platform}:${arch}`;
  const packages: Readonly<Record<string, string>> = {
    'linux:x64': '@openai/codex-linux-x64',
    'linux:arm64': '@openai/codex-linux-arm64',
    'android:x64': '@openai/codex-linux-x64',
    'android:arm64': '@openai/codex-linux-arm64',
    'darwin:x64': '@openai/codex-darwin-x64',
    'darwin:arm64': '@openai/codex-darwin-arm64',
    'win32:x64': '@openai/codex-win32-x64',
    'win32:arm64': '@openai/codex-win32-arm64',
  };
  const name = packages[key];
  if (name === undefined) throw new TypeError(`Codex SDK does not support ${key}.`);
  return name;
}

async function identityFilesInDirectory(
  root: string,
  facetNamespace: string,
  current = root,
): Promise<readonly CodexContentIdentityFile[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    throw new TypeError('Codex SDK bundled native runtime is unavailable.');
  }
  const files: CodexContentIdentityFile[] = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    if (current === root && entry.name === 'node_modules' && entry.isDirectory()) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await identityFilesInDirectory(root, facetNamespace, path));
    }
    else if (entry.isFile()) {
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const pathDigest = createHash('sha256').update(relativePath).digest('hex');
      files.push({ facetId: `${facetNamespace}.file.${pathDigest}`, path });
    } else {
      throw new TypeError('Codex SDK bundled native runtime contains an unsupported entry.');
    }
  }
  return files;
}

/** Resolves the optional peer once per adapter assembly; no process-level cache is used. */
export async function resolveInstalledCodexSdkRuntime(): Promise<ResolvedCodexSdkRuntime> {
  let sdkEntrypointPath: string;
  try {
    const sdkEntrypointUrl = import.meta.resolve(CODEX_SDK_PACKAGE);
    if (!sdkEntrypointUrl.startsWith('file:')) throw new TypeError();
    sdkEntrypointPath = fileURLToPath(sdkEntrypointUrl);
  } catch {
    throw new TypeError('Codex SDK optional peer dependency is unavailable.');
  }
  const sdkPackageManifestPath = join(dirname(dirname(sdkEntrypointPath)), 'package.json');
  const sdkManifest = await readPackageManifest(sdkPackageManifestPath, CODEX_SDK_PACKAGE);
  const sdkPackageRoot = dirname(sdkPackageManifestPath);
  const sdkPackageFiles = await identityFilesInDirectory(sdkPackageRoot, 'codex-sdk');
  const sdkRuntimeJavaScriptFiles = sdkPackageFiles.filter((file) => /\.(?:c|m)?js$/.test(file.path));
  if (
    sdkRuntimeJavaScriptFiles.length !== 1
    || sdkRuntimeJavaScriptFiles[0]?.path !== sdkEntrypointPath
  ) {
    throw new TypeError('Codex SDK package uses an unsupported runtime module layout.');
  }
  const sdkModuleUrl = pathToFileURL(sdkEntrypointPath);
  sdkModuleUrl.searchParams.set('omk-runtime-instance', randomUUID());
  const sdkRequire = createRequire(sdkPackageManifestPath);
  let codexPackageManifestPath: string;
  let nativePackageManifestPath: string;
  try {
    codexPackageManifestPath = sdkRequire.resolve(`${CODEX_PACKAGE}/package.json`);
    const codexRequire = createRequire(codexPackageManifestPath);
    nativePackageManifestPath = codexRequire.resolve(`${platformPackageName()}/package.json`);
  } catch {
    throw new TypeError('Codex SDK bundled Codex CLI package is unavailable.');
  }
  const codexManifest = await readPackageManifest(codexPackageManifestPath, CODEX_PACKAGE);
  if (sdkManifest.dependencies?.[CODEX_PACKAGE] !== codexManifest.version) {
    throw new TypeError('Codex SDK and bundled Codex CLI package versions are inconsistent.');
  }
  const vendorRoot = join(dirname(nativePackageManifestPath), 'vendor');
  const nativeRoot = join(vendorRoot, targetTriple());
  const nativeFiles = await identityFilesInDirectory(nativeRoot, 'codex-native');
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  let binaryPath = join(nativeRoot, 'bin', binaryName);
  if (!nativeFiles.some((file) => file.path === binaryPath)) {
    const legacyBinaryPath = join(nativeRoot, 'codex', binaryName);
    if (!nativeFiles.some((file) => file.path === legacyBinaryPath)) {
      throw new TypeError('Codex SDK bundled Codex executable is unavailable.');
    }
    binaryPath = legacyBinaryPath;
  }
  const contentIdentityFiles = Object.freeze([
    ...sdkPackageFiles.map((file) => {
      if (file.path === sdkPackageManifestPath) {
        return { ...file, facetId: 'codex-sdk.package-manifest' };
      }
      if (file.path === sdkEntrypointPath) {
        return { ...file, facetId: 'codex-sdk.entrypoint' };
      }
      return file;
    }),
    { facetId: 'codex.package-manifest', path: codexPackageManifestPath },
    { facetId: 'codex-native.package-manifest', path: nativePackageManifestPath },
    ...nativeFiles.map((file) => (
      file.path === binaryPath ? { ...file, facetId: 'codex-native.executable' } : file
    )),
  ]);
  return Object.freeze({
    sdkVersion: sdkManifest.version,
    codexVersion: codexManifest.version,
    contentIdentityFiles,
    async createClient(options: CodexSdkClientOptions): Promise<CodexSdkClient> {
      let sdkModule: CodexSdkModule;
      try {
        sdkModule = await import(sdkModuleUrl.href) as CodexSdkModule;
      } catch {
        throw new TypeError('Codex SDK optional peer dependency could not be loaded.');
      }
      if (typeof sdkModule.Codex !== 'function') {
        throw new TypeError('Codex SDK optional peer dependency has an invalid module shape.');
      }
      return new sdkModule.Codex(options);
    },
  });
}

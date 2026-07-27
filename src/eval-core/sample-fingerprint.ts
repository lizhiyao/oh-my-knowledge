import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, parse } from 'es-module-lexer';
import type { Assertion, Sample } from '../types/index.js';

const MAX_ASSERTION_MODULE_FILES = 512;
const MAX_ASSERTION_MODULE_BYTES = 32 * 1024 * 1024;
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

initSync();

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) =>
      entry === undefined ? 'null' : canonicalStringify(entry)
    ).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${entries.map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(record[key])}`
  ).join(',')}}`;
}

function hashString(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function dependencyContentFingerprint(path: string, baseDir: string | undefined): string {
  if (!baseDir && !isAbsolute(path)) return 'base-dir-unavailable';
  const resolvedPath = isAbsolute(path) ? path : resolve(baseDir!, path);
  try {
    return `sha256:${hashString(readFileSync(resolvedPath))}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `unavailable:${code ?? 'unknown'}`;
  }
}

function customAssertionPaths(assertions: Assertion[] | undefined): string[] {
  if (!assertions) return [];
  return assertions.flatMap((assertion) => {
    const record = assertion as unknown as Record<string, unknown>;
    const current = assertion.type === 'custom' && typeof record.fn === 'string'
      ? [record.fn]
      : [];
    const children = assertion.type === 'assert-set' && Array.isArray(assertion.children)
      ? customAssertionPaths(assertion.children)
      : [];
    return [...current, ...children];
  });
}

function displayDependencyPath(path: string, baseDir: string | undefined): string {
  if (!baseDir) return path;
  const rel = relative(baseDir, path);
  return rel || '.';
}

function resolveImportedModule(specifier: string, importer: string): string | undefined {
  if (BUILTIN_MODULES.has(specifier)) return undefined;
  if (specifier.startsWith('file:')) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return undefined;
    }
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const clean = specifier.replace(/[?#].*$/, '');
    const path = specifier.startsWith('/') ? clean : resolve(dirname(importer), clean);
    return existsSync(path) && statSync(path).isFile() ? path : undefined;
  }
  try {
    const resolved = createRequire(importer).resolve(specifier);
    return BUILTIN_MODULES.has(resolved) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

function customAssertionModuleEntries(
  path: string,
  baseDir: string | undefined,
): Array<[string, string]> {
  if (!baseDir && !isAbsolute(path)) {
    return [[`module:${path}`, 'base-dir-unavailable']];
  }
  const entryPath = isAbsolute(path) ? path : resolve(baseDir!, path);
  const entries: Array<[string, string]> = [];
  const visited = new Set<string>();
  let totalBytes = 0;

  const visit = (modulePath: string): void => {
    if (visited.has(modulePath)) return;
    if (visited.size >= MAX_ASSERTION_MODULE_FILES) {
      throw new Error(
        `custom assertion module graph exceeds ${MAX_ASSERTION_MODULE_FILES} files: ${entryPath}`,
      );
    }
    visited.add(modulePath);
    let source: Buffer;
    try {
      source = readFileSync(modulePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      entries.push([
        `module:${displayDependencyPath(modulePath, baseDir)}`,
        `unavailable:${code ?? 'unknown'}`,
      ]);
      return;
    }
    totalBytes += source.byteLength;
    if (totalBytes > MAX_ASSERTION_MODULE_BYTES) {
      throw new Error(
        `custom assertion module graph exceeds ${MAX_ASSERTION_MODULE_BYTES} bytes: ${entryPath}`,
      );
    }
    entries.push([
      `module:${displayDependencyPath(modulePath, baseDir)}`,
      `sha256:${hashString(source)}`,
    ]);
    if (!/\.[cm]?js$/i.test(modulePath)) return;
    let imports;
    try {
      [imports] = parse(source.toString('utf8'));
    } catch {
      entries.push([
        `module-parse:${displayDependencyPath(modulePath, baseDir)}`,
        'unparseable',
      ]);
      return;
    }
    for (const imported of imports) {
      if (!imported.n) {
        if (imported.d >= 0) {
          entries.push([
            `module-dynamic:${displayDependencyPath(modulePath, baseDir)}:${imported.ss}`,
            'non-literal',
          ]);
        }
        continue;
      }
      const resolvedImport = resolveImportedModule(imported.n, modulePath);
      if (resolvedImport) visit(resolvedImport);
    }
  };

  visit(entryPath);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function sampleDependencyEntries(
  sample: Sample,
  baseDir: string | undefined,
  includeCustomAssertions: boolean,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [index, mock] of (sample.mocks ?? []).entries()) {
    if (typeof mock.return_file !== 'string' || !mock.return_file) continue;
    entries.push([
      `mock:${index}:return_file:${mock.return_file}`,
      dependencyContentFingerprint(mock.return_file, baseDir),
    ]);
  }
  if (includeCustomAssertions) {
    for (const [index, path] of customAssertionPaths(sample.assertions).entries()) {
      for (const [modulePath, fingerprint] of customAssertionModuleEntries(path, baseDir)) {
        entries.push([
          `assertion:${index}:fn:${path}:${modulePath}`,
          fingerprint,
        ]);
      }
    }
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Content fingerprint for files that can change executor output while the
 * inline sample contract remains byte-for-byte identical.
 */
export function hashSampleExecutionDependencies(
  sample: Sample,
  baseDir?: string,
): string | undefined {
  const entries = sampleDependencyEntries(sample, baseDir, false);
  return entries.length > 0 ? hashString(canonicalStringify(entries)).slice(0, 12) : undefined;
}

/**
 * Stable hash of the complete sample measurement contract, including external
 * mock fixtures and the statically resolvable ESM import graph of custom
 * assertion modules when a sample base directory is available.
 */
export function hashSample(sample: Sample, baseDir?: string): string {
  const contract = Object.fromEntries(
    Object.entries(sample).filter(
      ([key, value]) => key !== 'sample_id' && value !== undefined,
    ),
  );
  const dependencies = sampleDependencyEntries(sample, baseDir, true);
  return hashString(canonicalStringify({
    contract,
    ...(dependencies.length > 0 ? { dependencies } : {}),
  })).slice(0, 12);
}

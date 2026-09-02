import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = resolve('src/eval-core');
const ALLOWED_EXTERNAL_IMPORTS = new Set(['zod', 'node:crypto']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && TYPESCRIPT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function hasNonLiteralDependency(source: string): boolean {
  return /\b(?:import|require)\s*\(\s*[^\s'"]/.test(source);
}

function importsFrom(source: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) imports.add(match[1]);
    }
  }
  return [...imports];
}

describe('Evaluation Core dependency boundary', () => {
  it('recognizes every dependency syntax that the boundary prohibits', () => {
    const source = [
      "import value from 'static-package';",
      "export { value } from './relative-export.js';",
      "import 'side-effect-package';",
      "await import('dynamic-package');",
      "require('commonjs-package');",
    ].join('\n');

    expect(importsFrom(source).sort()).toEqual([
      './relative-export.js',
      'commonjs-package',
      'dynamic-package',
      'side-effect-package',
      'static-package',
    ]);
    expect(hasNonLiteralDependency(source)).toBe(false);
    expect(hasNonLiteralDependency('await import(dynamicSpecifier);')).toBe(true);
    expect(hasNonLiteralDependency('require(dynamicSpecifier);')).toBe(true);
  });

  it('does not reverse-import host, filesystem, environment, or provider dependencies', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(CORE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (/\bprocess\.(?:env|cwd)\b/.test(source)) {
        violations.push(`${file}: ambient process state`);
      }
      if (hasNonLiteralDependency(source)) {
        violations.push(`${file}: non-literal dependency`);
      }
      for (const specifier of importsFrom(source)) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          if (target !== CORE_ROOT && !target.startsWith(`${CORE_ROOT}${sep}`)) {
            violations.push(`${file}: ${specifier}`);
          }
          continue;
        }
        if (!ALLOWED_EXTERNAL_IMPORTS.has(specifier)) {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

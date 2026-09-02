import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RETIRED_DIRECTORY = ['evaluation', 'core'].join('-');
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.js', '.json', '.md', '.mjs', '.mts', '.ts', '.tsx', '.yaml', '.yml',
]);

function textFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'dist' || entry.name === 'node_modules' ? [] : textFiles(path);
    return entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe('retired evaluation layout', () => {
  it('keeps the historical source and test directories absent', () => {
    expect(existsSync(resolve('src', RETIRED_DIRECTORY))).toBe(false);
    expect(existsSync(resolve('test', RETIRED_DIRECTORY))).toBe(false);
    expect(existsSync(resolve('schemas', RETIRED_DIRECTORY))).toBe(false);
  });

  it('prevents source, tests, scripts, and docs from restoring retired paths', () => {
    const forbiddenFragments = [
      ['src', RETIRED_DIRECTORY].join('/'),
      ['test', RETIRED_DIRECTORY].join('/'),
      ['dist', RETIRED_DIRECTORY].join('/'),
      ['oh-my-knowledge', RETIRED_DIRECTORY].join('/'),
    ];
    const violations = ['src', 'test', 'scripts', 'docs']
      .flatMap((directory) => textFiles(resolve(directory)))
      .flatMap((file) => {
        const content = readFileSync(file, 'utf8');
        return forbiddenFragments
          .filter((fragment) => content.includes(fragment))
          .map((fragment) => `${file}: ${fragment}`);
      });

    expect(violations).toEqual([]);
  });
});

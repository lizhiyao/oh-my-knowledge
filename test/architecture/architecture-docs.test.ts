import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const trees = [
  { header: 'eval-workflows/', root: 'src/eval-workflows' },
  { header: 'observability/', root: 'src/observability' },
  { header: 'knowledge-artifacts/', root: 'src/knowledge-artifacts' },
  { header: 'executors/', root: 'src/executors' },
  { header: 'eval-workflows/hosts/', root: 'src/eval-workflows/hosts' },
  { header: 'evidence/', root: 'src/evidence' },
] as const;

function parseDocumentedTree(markdown: string, header: string) {
  const block = markdown.split(`\n${header}\n`)[1]?.split(/\n(?:\n|```)/)[0];
  expect(block, `Missing ${header} inventory`).toBeDefined();
  const directories: string[] = [];
  const files: string[] = [];
  let placeholders = 0;
  for (const match of block!.matchAll(/^[├└]── ([\w.<>-]+?)(\/)?\s*(?:#.*)?$/gm)) {
    const [, name, slash] = match;
    if (name.startsWith('<')) {
      placeholders += 1;
    } else if (slash) {
      directories.push(name);
    } else {
      files.push(name);
    }
  }
  return { directories: directories.sort(), files, placeholders };
}

describe('架构文档子域清单与源码对账', () => {
  for (const document of ['docs/explanation/architecture.md', 'docs/zh/explanation/architecture.md']) {
    it.each(trees)(`${document} 完整列出 $header 的实际内容`, ({ header, root }) => {
      const markdown = readFileSync(resolve(document), 'utf8');
      const documented = parseDocumentedTree(markdown, header);
      const actual = readdirSync(resolve(root), { withFileTypes: true });
      const actualDirectories = actual
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name).sort();
      if (documented.placeholders === 0) {
        expect(documented.directories).toEqual(actualDirectories);
      } else {
        for (const directory of documented.directories) {
          expect(actualDirectories, `${header} 列出 ${directory}/ 但源码中不存在`).toContain(directory);
        }
        const unmatched = actualDirectories.length - documented.directories.length;
        expect(
          unmatched >= documented.placeholders,
          `${header} 的 ${documented.placeholders} 个占位符只覆盖 ${unmatched} 个未列出的目录`,
        ).toBe(true);
      }
      const actualFiles = new Set(actual.filter((entry) => entry.isFile()).map((entry) => entry.name));
      for (const file of documented.files) {
        expect(actualFiles.has(file), `${header} 列出 ${file} 但源码中不存在`).toBe(true);
      }
    });
  }
});

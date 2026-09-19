import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('架构文档子域清单与源码对账', () => {
  for (const document of ['docs/explanation/architecture.md', 'docs/zh/explanation/architecture.md']) {
    it.each(['eval-workflows', 'observability'])(`${document} 完整列出 %s 的实际子域`, (domain) => {
      const markdown = readFileSync(resolve(document), 'utf8');
      const block = markdown.split(`\n${domain}/\n`)[1]?.split(/\n(?:\n|```)/)[0];
      expect(block, `Missing ${domain} inventory`).toBeDefined();
      const documented = [...block!.matchAll(/^[├└]── ([\w-]+)\//gm)]
        .map((match) => match[1]).sort();
      const actual = readdirSync(resolve('src', domain), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name).sort();
      expect(documented).toEqual(actual);
    });
  }
});

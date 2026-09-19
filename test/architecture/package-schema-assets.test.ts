import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageManifest from '../../package.json';


/**
 * 公开 schema 子路径必须同时满足三件事：
 * ① 有一个声明它、并真的会产出它的构建步骤（`scripts/build/assets.cjs` 的目录拷贝清单）；
 * ② 与 Core／样本 resolver 的「模块同级」读法一致，不能让 exports 与运行时各指一处；
 * ③ 真值源目录里对应版本的 schema 文件确实存在。
 * 少任何一环，`build:src` 之外的部分构建或新增子路径就会在用户侧悬空，而 CI 不会红。
 */
const SCHEMA_EXPORTS: Readonly<Record<string, {
  truthSource: string;
  resolverFile: string;
  resolverTail: string;
}>> = {
  './eval-core/schemas/*': {
    truthSource: 'schemas/eval-core',
    resolverFile: 'src/eval-core/schema-url.ts',
    resolverTail: './contracts/schemas/',
  },
  './eval-samples/schemas/v3/*': {
    truthSource: 'schemas/eval-samples/v3',
    resolverFile: 'src/eval-workflows/inputs/eval-samples.ts',
    resolverTail: './contracts/schemas/v3/',
  },
};

function assetDirectoryCopies(): Map<string, string> {
  const source = readFileSync('scripts/build/assets.cjs', 'utf8');
  const block = source.slice(source.indexOf('const DIR_ASSETS'));
  const copies = new Map<string, string>();
  for (const match of block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)) {
    copies.set(match[2], match[1]);
  }
  return copies;
}

function exportsTargets(): Record<string, string> {
  const exports = packageManifest.exports as Record<string, unknown>;
  return Object.fromEntries(Object.entries(exports).map(([key, value]) => [key, String(value)]));
}

describe('公开 schema 子路径的生产者与读法必须同源', () => {
  const copies = assetDirectoryCopies();
  const targets = exportsTargets();

  it('清单里的 schema 子路径与 package.json 严格一致，新增必须同步登记', () => {
    const published = Object.keys(targets).filter((key) => key.includes('/schemas/'));
    expect(published.sort()).toEqual(Object.keys(SCHEMA_EXPORTS).sort());
  });

  for (const [subpath, expected] of Object.entries(SCHEMA_EXPORTS)) {
    it(`${subpath} 的目标目录由构建步骤产出，且与 resolver 同级读法一致`, () => {
      const target = targets[subpath];
      expect(target, `缺少 ${subpath} 的 exports 目标`).toBeTruthy();
      expect(target.startsWith('./dist/'), `目标必须落在 dist 内：${target}`).toBe(true);

      // ① 生产者：assets.cjs 的目录拷贝清单里必须有这个目标目录。
      const targetDir = target.replace(/\/\*$/, '').replace(/^\.\//, '');
      const source = copies.get(targetDir);
      expect(source, `${targetDir} 没有任何构建步骤产出（assets.cjs 缺条目）`).toBe(expected.truthSource);

      // ② 读法：resolver 以模块同级 URL 读取，其拼出的路径必须与 exports 目标同一处。
      const resolverSource = readFileSync(expected.resolverFile, 'utf8');
      expect(resolverSource).toContain(`new URL(\`${expected.resolverTail}`);
      const moduleDir = expected.resolverFile.replace(/^src\//, '').replace(/\/[^/]+\.ts$/, '');
      const sibling = resolve('dist', moduleDir, expected.resolverTail.slice(2).replace(/\/$/, ''));
      expect(relative(process.cwd(), sibling).split(/[\\/]+/).join('/')).toBe(targetDir);

      // ③ 真值源存在且非空。
      expect(existsSync(expected.truthSource), `真值源缺失：${expected.truthSource}`).toBe(true);
      const versionDirs = readdirSync(expected.truthSource, { recursive: true })
        .filter((entry) => String(entry).endsWith('.json'));
      expect(versionDirs.length, `${expected.truthSource} 里没有 schema 文件`).toBeGreaterThan(0);
    });
  }

});

/** 通用生产者约束：任何指向 dist 的公开子路径，要么由 tsc 编译，要么在 assets.cjs 的拷贝清单里。 */
describe('公开 exports 的每条 dist 路径都要有声明它的构建步骤', () => {
  function distPaths(value: unknown, acc: string[] = []): string[] {
    if (typeof value === 'string') {
      if (value.startsWith('./dist/')) acc.push(value.slice(2));
    } else if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) distPaths(nested, acc);
    }
    return acc;
  }

  const copies = assetDirectoryCopies();
  const suffix = /(?:\.d)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

  function hasProducer(target: string): boolean {
    if (suffix.test(target)) {
      const stem = target.replace(/^dist\//, '').replace(suffix, '');
      return ['.ts', '.tsx', '.mts', '.cts'].some((ext) => (
        existsSync(join('src', `${stem}${ext}`)) || existsSync(join('src', stem, `index${ext}`))
      ));
    }
    for (const [destination, origin] of copies) {
      if (target === destination || target.startsWith(`${destination}/`)) {
        return existsSync(origin);
      }
    }
    return false;
  }

  const published = Object.entries((packageManifest.exports ?? {}) as Record<string, unknown>)
    .flatMap(([key, value]) => distPaths(value).map((target) => [key, target] as const));

  it('每条已发布的 dist 路径都能追溯到生产者', () => {
    expect(published.length).toBeGreaterThan(0);
    const orphans = published.filter(([, target]) => !hasProducer(target));
    expect(orphans.map(([key, target]) => `${key} -> ${target}`)).toEqual([]);
  });

  it('生产者判定本身可被绕过情形抓到', () => {
    expect(hasProducer('dist/eval-core/index.js')).toBe(true);
    expect(hasProducer('dist/index.d.ts')).toBe(true);
    expect(hasProducer('dist/eval-core/contracts/schemas/v1/execution-bundle.schema.json')).toBe(true);
    expect(hasProducer('dist/eval-core/ghost/whatever.schema.json')).toBe(false);
    expect(hasProducer('dist/ghost-module/index.js')).toBe(false);
  });
});

/**
 * Packaging smoke test — sandbox mock 主能力依赖 src/eval-core/mock-hook.cjs
 * 这份 hook 是 runtime executable,tsc 不处理 .cjs 文件,build script 必须把它复制到
 * dist/eval-core/。本测试保证:
 *   1) 源码位置:src/eval-core/mock-hook.cjs 存在(否则 build 也会挂)
 *   2) build 产物:dist/eval-core/mock-hook.cjs 存在(否则运行时 readMockHookTemplate 挂)
 *   3) npm tarball:发布的 package 含这个文件(否则 npm 安装版 sandbox mock 主能力丢)
 *
 * 历史背景:assets/ 旧位置 + package.json.files 漏 dist 子目录,发出去的 tarball 漏 hook,
 * 本测试是这个 issue 的回归门。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

describe('packaging — mock-hook ships with omk package', () => {
  it('源码位置存在 mock-hook.cjs', () => {
    expect(existsSync('src/eval-core/mock-hook.cjs')).toBe(true);
  });

  it('build 后 dist 里有 mock-hook.cjs(否则运行时挂)', () => {
    if (!existsSync('dist/eval-core/mocks-runtime.js')) {
      console.warn('[skip] dist/ 缺失,先 `yarn build` 再跑');
      return;
    }
    expect(existsSync('dist/eval-core/mock-hook.cjs')).toBe(true);
  });

  it('npm pack 清单含 mock-hook.cjs(否则发出去的包漏 hook)', () => {
    if (!existsSync('dist/eval-core/mocks-runtime.js')) {
      console.warn('[skip] dist/ 缺失,先 `yarn build` 再跑');
      return;
    }
    const out = execSync('npm pack --dry-run --json', { encoding: 'utf-8' });
    const meta = JSON.parse(out)[0];
    const paths: string[] = (meta.files || []).map((f: { path: string }) => f.path);
    expect(paths).toContain('dist/eval-core/mock-hook.cjs');
  });

  // dist/ 扁平化(rootDir=src,outDir=dist)后,任何 dist/src/** 都是旧产物
  // 残留;dist-scripts/ 是内部脚本构建产物不该发包;tsbuildinfo 是 tsc
  // incremental cache,出现在 tarball 都是 build 链路 / files 字段出问题的信号。
  it('npm pack 清单不含旧产物残留(dist/src/、dist-scripts/、tsbuildinfo)', () => {
    if (!existsSync('dist/eval-core/mocks-runtime.js')) {
      console.warn('[skip] dist/ 缺失,先 `yarn build` 再跑');
      return;
    }
    const out = execSync('npm pack --dry-run --json', { encoding: 'utf-8' });
    const meta = JSON.parse(out)[0];
    const paths: string[] = (meta.files || []).map((f: { path: string }) => f.path);
    const leaks = paths.filter((p) =>
      p.startsWith('dist/src/') ||
      p.startsWith('dist-scripts/') ||
      p.endsWith('.tsbuildinfo')
    );
    expect(leaks).toEqual([]);
  });
});

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Studio React 页面的测试是 .tsx；只收 .ts 会让它们被静默跳过而 CI 仍然全绿。
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 30000,
    // maxWorkers 不显式配置：vitest 按 CPU 核数自动决定。本地 11 核默认 ~10 workers，
    // 历史上 80%（~9 workers）曾在内存压力下被 SIGKILL；若默认配置在本机复现 SIGKILL，
    // 需恢复显式护栏（曾用 70%，~7 workers，实测 122s→80s 且全绿）。
    // OMK_HOME 一处重定向,把整棵默认产物树(reports / doctors / observe-health / state 下的
    // cache / trees / jobs / artifact-index)全部移到临时目录,从根上隔离 —— 任何从深层调用点写全局默认
    // 目录的写路径(如 persistReport 间接写产物索引卡片、materialize 写隔离副本)都自动落 temp,不再需要
    // 每个子目录单独补 env 兜底,也消除「新写路径忘了补兜底就静默污染真实 ~/.oh-my-knowledge」的隐患。
    // 需要更细粒度的用例仍可 per-test 覆盖 OMK_TREES_DIR / OMK_ARTIFACT_INDEX_DIR 等子目录变量。
    env: {
      OMK_HOME: join(tmpdir(), `omk-test-home-${process.pid}`),
      // Update-check behavior has dedicated tests. Disable it everywhere else
      // so CLI integration tests do not create caches or detached refresh
      // workers for every command invocation.
      OMK_SKIP_UPDATE_CHECK: '1',
    },
  },
});

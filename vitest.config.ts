import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Studio React 页面的测试是 .tsx；只收 .ts 会让它们被静默跳过而 CI 仍然全绿。
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 30000,
    // CLI、打包与 provider fixture 会在 worker 内派生进程；只按 CPU 数启动会耗尽资源。
    // 2026-09-19 全量验证中默认并发及 4 workers 均出现 SIGKILL，显式限制并发峰值。
    maxWorkers: 2,
    // OMK_HOME 一处重定向,把整棵默认产物树(reports / doctors / observe-health / state 下的
    // cache / trees / jobs / artifact-index)全部移到临时目录,从根上隔离 —— 任何从深层调用点写全局默认
    // 目录的写路径(如 persistReport 间接写产物索引卡片、materialize 写隔离副本)都自动落 temp,不再需要
    // 每个子目录单独补 env 兜底,也消除「新写路径忘了补兜底就静默污染真实 ~/.oh-my-knowledge」的隐患。
    // 需要更细粒度的用例仍可 per-test 覆盖 OMK_TREES_DIR / OMK_ARTIFACT_INDEX_DIR 等子目录变量。
    env: {
      // 展示语言会按系统 locale 推断默认值；不钉住 LANG，「默认输出中文」这类断言就跟着
      // 开发者 shell 或 CI 镜像漂。C = 无 locale 信号 = 走兜底，locale 推断本身另有用例显式覆盖。
      LANG: 'C',
      LC_ALL: 'C',
      LC_MESSAGES: 'C',
      OMK_HOME: join(tmpdir(), `omk-test-home-${process.pid}`),
      // Update-check behavior has dedicated tests. Disable it everywhere else
      // so CLI integration tests do not create caches or detached refresh
      // workers for every command invocation.
      OMK_SKIP_UPDATE_CHECK: '1',
    },
  },
});

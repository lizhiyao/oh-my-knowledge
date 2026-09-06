import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    // Git/Node subprocesses become I/O-bound under full CPU parallelism.
    // Keep proportional headroom while allowing larger hosts to scale.
    maxWorkers: '55%',
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

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 产物层清单：依赖构建产物（dist/、dist-scripts/、src/studio/web/.next）的测试文件，
// 必须在 `yarn build` 之后运行。清单实测得出（issue #932），新增产物依赖文件时必须加入。
const productLayerFiles = readFileSync(join(__dirname, 'test', 'product-layer.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .sort();

// 源码层分片清单：由 `yarn test:profile` 实测时长贪心装箱生成（issue #932），
// 替代 vitest --shard 的下标切片（重活集中在字母序前段导致 105s/27s 倾斜）。
// OMK_SOURCE_SHARD=<1-4> 时只跑对应清单；未设置时跑全部源码层文件。
// 新增/删除源码层测试文件后必须重跑装箱更新 test/shards/source-*.txt，
// 否则新文件会落回默认行为；test/architecture/test-gate-coverage.test.ts 守住覆盖不减。
function sourceShardInclude(): string[] {
  const shard = process.env.OMK_SOURCE_SHARD;
  if (shard === undefined || shard === '') return ['test/**/*.test.{ts,tsx}'];
  const files = readFileSync(join(__dirname, 'test', 'shards', `source-${shard}.txt`), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return files.map((file) => `**/${file}`);
}

export default defineConfig({
  test: {
    // Studio React 页面的测试是 .tsx；只收 .ts 会让它们被静默跳过而 CI 仍然全绿。
    // include 只在各 project 内声明：根级 include 会与 project include 取并集，
    // 导致 --project 过滤失效（产物层会跑全部文件）。
    testTimeout: 30000,
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
    projects: [
      {
        // 源码层：不依赖构建产物，CI 可跳过 `yarn build` 直接分片并行。
        // maxWorkers 70%：11 核实测 55% → 70%（~7 workers）跑测 122s → ~80s，
        // isolate 保留（vi.mock 依赖）。80%（~9 workers）曾试过并回调：
        // 内存压力下 worker 被 SIGKILL，且放大既有 capture 文件竞态（已用原子 rename 修复）。
        test: {
          name: 'source',
          include: sourceShardInclude(),
          exclude: productLayerFiles.map((file) => `**/${file}`),
          maxWorkers: '70%',
        },
      },
      {
        // 产物层：依赖 dist/、dist-scripts/、src/studio/web/.next，必须在 `yarn build` 后运行。
        // maxWorkers=1：Next/打包/真 CLI 子进程叠加的内存峰值是 runner SIGKILL 的主因
        // （issue #932 实测近 40 轮失败全是 runner 级终止，集中在这类文件），单 worker 压低峰值。
        test: {
          name: 'product',
          include: productLayerFiles.map((file) => `**/${file}`),
          maxWorkers: 1,
        },
      },
    ],
  },
});

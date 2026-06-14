import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    // Default the test suite to lenient assertion-language enforcement so that
    // legacy fixture sample files (e.g. examples/code-review/eval-samples.json
    // containing `not_contains "looks good"`) keep loading via stderr-warning
    // path. The generator-boundary hard strip inside sanitizeGeneratedSamples
    // is unaffected by this env — that pipeline still gives the strict
    // guarantee for newly authored samples. Tests that specifically verify
    // the loader's strict-throw behavior toggle this off case-locally via
    // the withStrict helper in dependency-checker.test.ts. The "[omk
    // loadSamples] ⚠ lenient mode" stderr lines that appear during test runs
    // are diagnostic noise — they confirm which fixtures contain legacy-style
    // text-class assertions and are not failures.
    // OMK_HOME 一处重定向,把整棵默认产物树(reports / doctors / observe-health / state 下的
    // cache / trees / jobs / artifact-index)全部移到临时目录,从根上隔离 —— 任何从深层调用点写全局默认
    // 目录的写路径(如 persistReport 间接写产物索引卡片、materialize 写隔离副本)都自动落 temp,不再需要
    // 每个子目录单独补 env 兜底,也消除「新写路径忘了补兜底就静默污染真实 ~/.oh-my-knowledge」的隐患。
    // 需要更细粒度的用例仍可 per-test 覆盖 OMK_TREES_DIR / OMK_ARTIFACT_INDEX_DIR 等子目录变量。
    env: {
      OMK_LENIENT_ASSERTIONS: '1',
      OMK_HOME: join(tmpdir(), 'omk-test-home'),
    },
  },
});

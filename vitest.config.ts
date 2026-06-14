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
    // 把隔离副本根重定向到临时目录:测试解析 dir-skill 时(materialize 默认 true)不写用户真实
    // ~/.oh-my-knowledge/trees。需要断言「无 .tmp- 残留」等全局扫描的用例再各自 per-test 覆盖。
    // OMK_ARTIFACT_INDEX_DIR 同理:persistReport 被海量测试间接调用会写产物索引卡片,重定向到 temp
    // 避免污染真实 ~/.oh-my-knowledge/state/artifact-index。索引语义的用例各自 per-test 覆盖具体目录。
    env: {
      OMK_LENIENT_ASSERTIONS: '1',
      OMK_TREES_DIR: join(tmpdir(), 'omk-test-trees'),
      OMK_ARTIFACT_INDEX_DIR: join(tmpdir(), 'omk-test-artifact-index'),
    },
  },
});

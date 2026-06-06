/**
 * issue #206 护栏:裸 `kind` 留给 `ArtifactKind`。
 *
 * 产品语义里不带限定词的 `kind` 一律指 knowledge artifact 类型(`Artifact.kind`)。
 * 其它判别字段必须用限定名(`reportKind` / `eventKind` / `runtimeKind` / `standardKind` ...)。
 * 本测试 scan `src/**\/*.ts`,把「含裸 `kind` 作为对象 key / 字段声明」的文件集合冻结在
 * ALLOWED_KIND_FILES 里。新文件引入裸 `kind` → 失败:
 *   - 一般情况:改成限定名;
 *   - 若确实是新的持久化判别字段:把文件加进 ALLOWED_KIND_FILES 并在 PR 里说明理由。
 *
 * 已序列化进 report / observe / doctor / diagnosis JSON 的 `kind` 是可比性不变量,不在
 * 渐进重命名范围内(改它要走 schema migration)。详见 docs/specs/terminology-spec.md §5.4。
 *
 * 检测口径与生成白名单的 grep 一致(逐行原文,不剥注释):
 *   `kind` 前面不是标识符字符或点(排除 `artifactKind` / `byKind` / `.kind`),后跟 `?:` 或 `:`。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(PROJECT_ROOT, 'src');

const BARE_KIND = /(^|[^A-Za-z0-9_.])kind\s*\??\s*:/;

// 当前(post-#206-rename)合法持有裸 `kind` 的文件:
//   - category A:`Artifact.kind: ArtifactKind` 及其构造点(eval.ts / skill-loader / task-planner ...);
//   - category B:已持久化进 report / observe / doctor / diagnosis JSON 的判别字段(冻结);
//   - 少数局部 param(parsers.ts 的数字解析 `kind`)。
// 渐进重命名只动「内部非持久」字段,不动 B;新增裸 `kind` 一律先看能不能改限定名。
const ALLOWED_KIND_FILES = new Set<string>([
  'src/authoring/evolver.ts',
  'src/cli/commands/eval/index.ts',
  'src/cli/commands/observe/inbox.ts',
  'src/cli/oclif/parsers.ts',
  'src/diagnosis/observe-mapper.ts',
  'src/diagnosis/observe-producer.ts',
  'src/doctor/index.ts',
  'src/doctor/preflight.ts',
  'src/eval-core/evaluation-reporting.ts',
  'src/eval-core/task-planner.ts',
  'src/eval-workflows/batch-evaluation-workflow.ts',
  'src/executors/runtime-fingerprint.ts',
  'src/executors/shared.ts',
  'src/inputs/skill-loader.ts',
  'src/observability/experience.ts',
  'src/observability/inbox.ts',
  'src/observability/problem-patterns.ts',
  'src/observability/resolved-review.ts',
  'src/observability/review-state.ts',
  'src/observability/skill-chain.ts',
  'src/observability/soft-standards/llm-extractor.ts',
  'src/observability/soft-standards/runtime-evaluator.ts',
  'src/observability/soft-standards/skill-standards-store.ts',
  'src/observability/soft-standards/types.ts',
  'src/renderer/observation-inbox-renderer.ts',
  'src/server/report-store.ts',
  'src/types/diagnosis.ts',
  'src/types/doctor.ts',
  'src/types/eval.ts',
  'src/types/executor.ts',
  'src/types/observability.ts',
  'src/types/report.ts',
]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function hasBareKind(file: string): boolean {
  return readFileSync(file, 'utf8').split('\n').some((line) => BARE_KIND.test(line));
}

describe('issue #206: 裸 kind 护栏', () => {
  it('src 里没有未登记的裸 kind 声明文件', () => {
    const actual = new Set(
      collectTsFiles(SRC_DIR)
        .filter(hasBareKind)
        .map((f) => relative(PROJECT_ROOT, f).split('\\').join('/')),
    );
    const extra = [...actual].filter((f) => !ALLOWED_KIND_FILES.has(f)).sort();
    const missing = [...ALLOWED_KIND_FILES].filter((f) => !actual.has(f)).sort();

    assert.deepEqual(
      extra,
      [],
      `这些文件新引入了裸 \`kind\`(issue #206)。裸 kind 留给 ArtifactKind;` +
        `请改成限定名(reportKind/eventKind/runtimeKind/standardKind 等),` +
        `或——若确为新的持久化判别字段——把文件加进 ALLOWED_KIND_FILES 并注明理由:\n  ${extra.join('\n  ')}`,
    );
    assert.deepEqual(
      missing,
      [],
      `这些文件已不再含裸 \`kind\`,请从 ALLOWED_KIND_FILES 删除以保持白名单收紧:\n  ${missing.join('\n  ')}`,
    );
  });
});

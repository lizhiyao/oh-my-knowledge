/**
 * eval 报告写入默认目录(parseRunConfig.outputDir)三态:
 *   - 默认 → 项目级 .omk/reports(绑用例集,construct validity)
 *   - --global → 全局 ~/.oh-my-knowledge/reports
 *   - --output-dir → 显式目录(最高优先)
 * 纯文件落点,不动任何评分;读取侧 studio / resume / gold-compare / 复用走 overlay 兜底(见 report-store)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseRunConfig } from '../../src/cli/lib/parse-run-config.js';
import { globalReportsDir, projectReportsDir } from '../../src/eval-core/measurement-dirs.js';
import { OMK_HOME } from '../../src/eval-core/default-dirs.js';

const BASE_FLAGS = {
  'skill-dir': 'test/fixtures/code-review/skills',
  control: 'baseline',
  treatment: 'v1',
  'dry-run': true,
};

describe('eval 报告写入默认目录', () => {
  it('默认 → 项目级 .omk/reports', () => {
    const { config } = parseRunConfig({ ...BASE_FLAGS });
    assert.equal(config.outputDir, projectReportsDir());
    assert.ok(config.outputDir.endsWith(join('.omk', 'reports')), '应落项目 .omk/reports');
  });

  it('--global → 全局 reports', () => {
    const { config } = parseRunConfig({ ...BASE_FLAGS, global: true });
    assert.equal(config.outputDir, globalReportsDir());
    // 全局目录从 OMK_HOME 派生(可被 env 整体重定向),不硬编码 .oh-my-knowledge。
    assert.equal(config.outputDir, join(OMK_HOME, 'reports'));
  });

  it('--output-dir 最高优先(压过默认与 --global)', () => {
    const { config } = parseRunConfig({ ...BASE_FLAGS, global: true, 'output-dir': 'custom-reports' });
    assert.equal(config.outputDir, join(process.cwd(), 'custom-reports'));
  });
});

/**
 * 当 CLI 未传 `--samples` 时,自动发现 sample 路径。
 *
 * 发现顺序:
 *   1. 单 treatment → 找该 skill 私有 samples(`<skill>/.omk/`)或扁平 skill paired 文件
 *   2. 终极兜底 cwd 下的项目级 `eval-samples.{json,yaml,yml}`
 *
 * `loadSamples` 在下游自己处理「文件 vs 目录」—— 目录模式 glob `*.{json,yaml,yml}`
 * 合并,跳过 reserved 前缀(`report-` / `health-` / `_`)。所以一个 skill 可以把
 * sample 拆到多文件(`workflow.json` + `platform.json`),也可以单 `samples.json`,
 * 两种都行。
 *
 * 多 treatment 评测不会触发 skill-local 自动发现(因为「找哪个 skill 的 bundled samples」
 * 没有唯一答案),只回到项目级 samples 兜底。
 */

import { findProjectSamplesFile, findSingleTreatmentSamplesPath } from '../../../inputs/sample-locator.js';

export function discoverSamplesPath(values: Record<string, unknown>, skillDir: string): string {
  const treatmentRaw = values.treatment as string | undefined;
  const treatments = treatmentRaw
    ? treatmentRaw.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  if (treatments.length === 1) {
    const samplesPath = findSingleTreatmentSamplesPath(treatments[0], skillDir, process.cwd());
    if (samplesPath) return samplesPath;
  }
  return findProjectSamplesFile(process.cwd()) ?? 'eval-samples.json';
}

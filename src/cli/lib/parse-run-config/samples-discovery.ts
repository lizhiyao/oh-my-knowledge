/**
 * 当 CLI 未传 `--samples` 时,自动发现 sample 路径。
 *
 * 发现顺序:
 *   1. 单 treatment 目录 skill → 找私有 `<skill>/.omk/eval-samples.{json,yaml}`
 *   2. 终极兜底 cwd 下的项目级 `eval-samples.{json,yaml}`
 *
 * 隐式发现只返回 canonical 单文件；显式 `--samples` 仍可交给 `loadSamples` 读取
 * 自定义 JSON / YAML 文件或分片目录。
 *
 * 多 treatment 评测不会触发 skill-local 自动发现(因为「找哪个 skill 的 bundled samples」
 * 没有唯一答案),只回到项目级 samples 兜底。
 */

import { findProjectSamplesFile, findSingleTreatmentSamplesPath } from '../../../eval-workflows/inputs/sample-locator.js';
import { withLocalizedSampleDiscovery } from '../localized-sample-discovery.js';
import type { CliLang } from '../i18n.js';

export function discoverSamplesPath(values: Record<string, unknown>, skillDir: string, lang: CliLang = 'zh'): string {
  return withLocalizedSampleDiscovery(() => {
    const treatmentRaw = values.treatment as string | undefined;
    const treatments = treatmentRaw
      ? treatmentRaw.split(',').map((v) => v.trim()).filter(Boolean)
      : [];
    if (treatments.length === 1) {
      const samplesPath = findSingleTreatmentSamplesPath(treatments[0], skillDir, process.cwd());
      if (samplesPath) return samplesPath;
    }
    return findProjectSamplesFile(process.cwd()) ?? 'eval-samples.json';
  }, lang);
}

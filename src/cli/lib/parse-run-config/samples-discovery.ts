/**
 * 当 CLI 未传 `--samples` 时,自动发现 sample 路径。
 *
 * 发现顺序(单 treatment 模式):
 *   1. treatment 是绝对 / 相对路径(文件 / 目录) → 找它所在目录的 `.omk/`
 *   2. fallback 找目录里的 `eval-samples.{json,yaml,yml}`
 *   3. fallback `<skillDir>/<treatmentName>/.omk/`
 *   4. 终极兜底 cwd 下的 `eval-samples.{json,yaml,yml}`
 *
 * `loadSamples` 在下游自己处理「文件 vs 目录」—— 目录模式 glob `*.{json,yaml,yml}`
 * 合并,跳过 reserved 前缀(`report-` / `health-` / `_`)。所以一个 skill 可以把
 * sample 拆到多文件(`workflow.json` + `platform.json`),也可以单 `samples.json`,
 * 两种都行。
 *
 * 多 treatment 评测必须显式传 `--samples`(因为「找哪个 skill 的 bundled samples」
 * 没有唯一答案)。本函数仅处理单 treatment 与零 treatment 情况。
 */

import { resolve, join, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';

export function discoverSamplesPath(values: Record<string, unknown>, skillDir: string): string {
  const treatmentRaw = values.treatment as string | undefined;
  const treatments = treatmentRaw
    ? treatmentRaw.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  if (treatments.length === 1) {
    const expr = treatments[0];
    const resolved = resolve(expr);
    if (existsSync(resolved)) {
      const treatmentDir = statSync(resolved).isDirectory() ? resolved : dirname(resolved);
      const omkDir = join(treatmentDir, '.omk');
      if (existsSync(omkDir)) return omkDir;
      for (const name of ['eval-samples.json', 'eval-samples.yaml', 'eval-samples.yml']) {
        if (existsSync(join(treatmentDir, name))) return join(treatmentDir, name);
      }
    }
    const omkDir = join(skillDir, expr, '.omk');
    if (existsSync(omkDir)) return omkDir;
  }
  let cwdFile = 'eval-samples.json';
  if (!existsSync(resolve(cwdFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) cwdFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) cwdFile = 'eval-samples.yml';
  }
  return cwdFile;
}

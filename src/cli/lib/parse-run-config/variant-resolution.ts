/**
 * 解析 `--control` / `--treatment` 与 eval.yaml `variants` 的优先级合并。
 *
 * 三态精度:
 *   - CLI roles 出现(--control 或 --treatment 任一) → 完全替换 config.variants
 *     (no merging)。CLI 跟 yaml 同时给意味着用户在 override yaml,合并会让
 *     control / treatment 角色和「跑哪些 variant」两件事纠缠
 *   - 仅 yaml → 用 `configVariantsToSpecs` 转换
 *   - 仅 batch 模式 → 留空,batch workflow 自己生成(baseline vs 每个 skill)
 *   - 都没有 → throw,附带 skill-dir 下候选 variant 提示,引导显式声明
 *
 * 之后做 variant name 唯一性检查 —— 同名 variant 不能同时在 --control 和
 * --treatment,也不能 --treatment 内重复。否则 ensemble agreement / report 字段
 * 都会按 name 去重,跑了但聚不到。
 */

import { discoverVariants, variantExprToSkillName } from '../../../inputs/skill-loader.js';
import { configVariantsToSpecs } from '../../../inputs/eval-config.js';
import type { EvalConfig, VariantSpec } from '../../../types/index.js';

export function resolveVariantSpecs(
  values: Record<string, unknown>,
  evalConfig: EvalConfig | null,
  skillDir: string,
): VariantSpec[] {
  const controlExpr = values.control as string | undefined;
  const treatmentExprs: string[] = values.treatment
    ? (values.treatment as string).split(',').map((v: string) => v.trim()).filter(Boolean)
    : [];

  let variantSpecs: VariantSpec[];
  if (controlExpr || treatmentExprs.length > 0) {
    // CLI roles present → CLI entirely replaces config.variants (no merging).
    variantSpecs = [];
    if (controlExpr) {
      variantSpecs.push({ name: variantExprToSkillName(controlExpr), role: 'control', expr: controlExpr });
    }
    for (const expr of treatmentExprs) {
      variantSpecs.push({ name: variantExprToSkillName(expr), role: 'treatment', expr });
    }
  } else if (evalConfig) {
    variantSpecs = configVariantsToSpecs(evalConfig.variants);
  } else if (values.batch) {
    // --batch 模式自动用 baseline (control) vs 每个 skill (treatment),
    // 不需要用户显式传 --control / --treatment,校验跳过。
    variantSpecs = [];
  } else {
    const discovered = discoverVariants(skillDir);
    const hint = discovered.length > 0 ? `\n  skill-dir (${skillDir}) 下发现的候选：${discovered.join(', ')}` : '';
    throw new Error(
      `请通过 --control / --treatment 或 --config eval.yaml 声明 variant 角色。\n`
      + `  示例：omk eval --control baseline --treatment my-skill${hint}\n`
      + `  --batch 模式下自动用 baseline vs 每个 skill,无需显式声明\n`
      + `  术语见 docs/specs/terminology-spec.md（v0.16 起废除 --variants，改用 experiment role 显式声明）`,
    );
  }

  const seenNames = new Set<string>();
  for (const spec of variantSpecs) {
    if (seenNames.has(spec.name)) {
      throw new Error(
        `variant "${spec.name}" 重复出现——同一 variant 不能同时属于 --control 与 --treatment，也不能在 --treatment 中重复。`,
      );
    }
    seenNames.add(spec.name);
  }

  return variantSpecs;
}

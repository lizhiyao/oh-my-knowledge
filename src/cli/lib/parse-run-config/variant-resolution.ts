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
 * 之后做 variant 唯一性检查 —— 同一个物理 variant 不能同时在 --control 和
 * --treatment,也不能 --treatment 内重复。按 `variantIdentity`(规范化后的物理身份,
 * 路径 resolve、目录与 SKILL.md 折叠、cwd 纳入)判重,而非派生短名,也不是裸 expr 字面量:
 *   - `v1/greeter.md` 与 `v2/greeter.md` 短名都是 greeter 却是两个 variant —— 不该误判重复,
 *     最终唯一名由 resolveArtifacts 的 ensureUniqueVariantNames 消歧。
 *   - `./x.md` 与 `x.md`、`dir` 与 `dir/SKILL.md` 是同一份 skill —— 必须判为重复,
 *     否则会被解析成两个 artifact 后用 `x` / `x#2` 消歧,变成同一份 skill 自比,
 *     悄悄废掉「control 不能等于 treatment」的测量保护。
 */

import { discoverVariants, variantExprToSkillName, variantIdentity, parseVariantCwd } from '../../../inputs/skill-loader.js';
import { configVariantsToSpecs } from '../../../inputs/eval-config.js';
import type { EvalConfig, ExperimentRole, VariantSpec } from '../../../types/index.js';

/** CLI 的 --control / --treatment 只收 artifact 身份。`name@cwd` 语法已移除:撞到就抛迁移错误,
 *  引导用户改用 --control-cwd / --treatment-cwd 或 eval.yaml 的 variant.cwd。git 修订语法 `@{...}`
 *  由 parseVariantCwd 保护、不误判。cwd 由调用方在边界注入(见 eval-runner)。 */
function cliVariantSpec(rawExpr: string, role: ExperimentRole, cwd?: string): VariantSpec {
  // 远端 git 不走 CLI 字符串(URL 的 `:`/`@` 会被 parseGitInput / parseVariantCwd 误切)——
  // 先于 @cwd guard 拦协议 URL 与 scp 形式 `git@host:path`,给明确的「走 eval.yaml」指引,
  // 而非让 scp 形式落到下面 @cwd 的迁移报错(误导)。绝对本地路径 `/abs/skill.md` 不在此列。
  if (/^(https?|ssh|git):\/\//i.test(rawExpr) || /^[\w.-]+@[\w.-]+:/.test(rawExpr)) {
    throw new Error(
      `远端 git 源不支持经 --${role} 字符串传入: "${rawExpr}"。请在 eval.yaml 的 variant 上用结构化 `
      + `git: { url, ref, spec } 字段(避开 URL 里的 : / @ 被误切),CLI 仅支持本地路径与 git:<ref>:<spec>。`,
    );
  }
  // 探测旧 name@cwd 形态报错。注:含合法 `@`(非 `@{`)的路径(如 /x/@dir/skill.md)会被一并
  // 误判 —— 属 pre-existing 限制(这类路径本就不被 @cwd 支持),报错文案仍指向迁移指引。
  if (parseVariantCwd(rawExpr).cwd !== undefined) {
    throw new Error(
      `「name@cwd」语法已移除: "${rawExpr}"。请改用 --${role}-cwd <dir> 声明 runtime context，`
      + `或在 eval.yaml 的 variant 上用结构化 cwd: 字段。`,
    );
  }
  return { name: variantExprToSkillName(rawExpr), role, expr: rawExpr, ...(cwd ? { cwd } : {}) };
}

export function resolveVariantSpecs(
  values: Record<string, unknown>,
  evalConfig: EvalConfig | null,
  skillDir: string,
): VariantSpec[] {
  const controlExpr = values.control as string | undefined;
  const treatmentExprs: string[] = values.treatment
    ? (values.treatment as string).split(',').map((v: string) => v.trim()).filter(Boolean)
    : [];
  const controlCwd = values['control-cwd'] as string | undefined;
  // 逗号列表,与 treatment 按序对齐;空位(空串)= 该 treatment 无 cwd。不 filter,保留位次。
  const treatmentCwds: string[] = values['treatment-cwd']
    ? (values['treatment-cwd'] as string).split(',').map((v: string) => v.trim())
    : [];

  let variantSpecs: VariantSpec[];
  if (controlExpr || treatmentExprs.length > 0) {
    // CLI roles present → CLI entirely replaces config.variants (no merging).
    if (controlCwd !== undefined && !controlExpr) {
      throw new Error('--control-cwd 需要配 --control 一起用。');
    }
    if (treatmentCwds.length > 0 && treatmentCwds.length !== treatmentExprs.length) {
      throw new Error(
        `--treatment-cwd 的数量(${treatmentCwds.length})必须与 --treatment(${treatmentExprs.length})按序对齐;`
        + `某个 treatment 不需要 cwd 就在该位留空(如 /a,,/c)。`,
      );
    }
    variantSpecs = [];
    if (controlExpr) {
      variantSpecs.push(cliVariantSpec(controlExpr, 'control', controlCwd));
    }
    treatmentExprs.forEach((expr, i) => {
      variantSpecs.push(cliVariantSpec(expr, 'treatment', treatmentCwds[i]));
    });
  } else if (controlCwd !== undefined || treatmentCwds.length > 0) {
    throw new Error('--control-cwd / --treatment-cwd 需要配 --control / --treatment 一起用(eval.yaml 用 variant 的 cwd: 字段)。');
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
      + `  术语见 docs/zh/specs/terminology-spec.md（v0.16 起废除 --variants，改用 experiment role 显式声明）`,
    );
  }

  const seenIdentities = new Set<string>();
  for (const spec of variantSpecs) {
    const key = variantIdentity(spec.expr, skillDir, spec.cwd);
    if (seenIdentities.has(key)) {
      throw new Error(
        `variant "${spec.expr}" 重复出现——同一 variant 不能同时属于 --control 与 --treatment，也不能在 --treatment 中重复。`,
      );
    }
    seenIdentities.add(key);
  }

  return variantSpecs;
}

/**
 * HealthDimensionSpec — 健康度维度的可扩展接口。
 *
 * 用户写一个 spec 描述自己想加的维度,通过 registerHealthDimension(spec) 注册;
 * composer 在拼 prompt 时把所有注册的 spec 的 promptSection 拼进"检查维度"区块,
 * 同时把 spec.id 加入 dim_id 枚举,LLM 必须在 checklist 中按每个 id 出一项。
 *
 * 维度结果(level + findings)的解析按统一规则跑;若维度需要特殊解析(eg. 把
 * subtype 作为 finding 一级字段),后续可以加可选 hooks(parseFindings 等)。
 */

import type { DoctorSeverity } from '../../types/doctor.js';

export type HealthDimensionLevel = '健康' | '亚健康' | '不健康' | '不适用';
export type HealthFindingLevel = '错误' | '警告' | '建议';

export interface HealthFinding {
  level: HealthFindingLevel;
  /** 仅 security 维度填(`不可逆操作 | 凭据硬编码 | 个人化耦合`),其它维度空字符串。
   *  保留为通用字段,未来其它维度也可借此做子分类。 */
  subtype?: string;
  evidence: string;
  description: string;
}

export interface HealthDimensionResult {
  level: HealthDimensionLevel;
  findings: HealthFinding[];
  suggestions: string[];
  /** 内部标记:LLM 没产出该维度时,parser 会塞一个 placeholder + _missing=true,
   *  composer 据此把 status 置为 skipped + message 提示 LLM 漏报。 */
  _missing?: boolean;
}

export interface HealthDimensionSpec {
  /** 稳定的英文 id。会成为 prompt 里 dim_id 的取值,以及 ruleId 后缀。
   *  不允许重复;不允许包含 `:`(避免和 composer ruleId 分隔符冲突)。 */
  id: string;
  /** 给人看的简短显示名(LLM prompt 里的章节标题用 + renderer 用)。
   *  可以是中文或多语言混用,稳定性不重要(因为 LLM 通过 id 派发,不看 displayName)。 */
  displayName: string;
  /** i18n key,doctor result 的 labelKey 用。renderer 走 tCli 出最终标题。 */
  labelKey: string;
  /** 该维度的严重度。`不健康` → fail 时,severity=fatal 才会让 doctor outcome 进 `failed`。
   *  内置 7 维度按重要性区分(eg. dependency/security 是 fatal, doc-clarity 是 warn)。 */
  severity: DoctorSeverity;
  /** 拼到 prompt 的检查内容片段(纯 markdown,**不写 ## N. 标题** —— 框架自动加章节号)。
   *  描述这一维度查什么、判定标准、example。 */
  promptSection: string;
}

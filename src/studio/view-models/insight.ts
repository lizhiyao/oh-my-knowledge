import type { Diagnosis } from '../../diagnosis/contracts.js';

export type InsightCategory =
  | 'environment-blocked-mocks'
  | 'skill-doc-gap'
  | 'failure-mode-skill'
  | 'coverage-gap'
  | 'production-instability'
  | 'skill-too-long'
  | 'omk-doctor-blindspot'
  | 'other';

export type InsightSeverity = 'high' | 'medium' | 'low';

export type InsightAudience = 'skill-author' | 'sample-author' | 'omk-maintainer';

export type InsightPerspective = 'doctor' | 'observe';

/** 现象证据:把抽象"X 模式 N 条"翻译成用户能看到的具体行为。 */
export interface InsightIllustration {
  sampleId: string;
  /** 用户给 LLM 的 prompt(截断到 ~200 字)。 */
  samplePrompt?: string;
  /** LLM 最终输出(截断到 ~200 字)。 */
  llmOutput?: string;
  /** LLM 实际调的工具(简化字符串列表,顺序保留)。 */
  toolCalls?: string[];
  /** 哪条 assertion 没过 + value。 */
  failedAssertion?: string;
}

export interface InsightEvidence {
  perspective: InsightPerspective;
  status: 'flagged' | 'blind' | 'silent' | 'na';
  /** 简短说明(用户语,不堆术语)。 */
  message: string;
  ref?: string;
  /** 如果有现象证据,展开看 1-2 条具体 sample 的实际 prompt/output/toolCalls。 */
  illustrations?: InsightIllustration[];
}

/** 可粘贴的 patch 片段。target 指明改哪种文件,location 是文件/章节,snippet 是代码块。 */
export interface InsightPatch {
  target: 'skill' | 'sample-environment' | 'sample-mocks' | 'doctor-rule';
  /** 目标位置描述,如 'sample s003 的 mocks 数组' / 'SKILL.md「项目创建」节'。 */
  location: string;
  /** 代码块或 diff 片段。 */
  snippet: string;
}

export interface InsightRecommendation {
  action: string;
  priority: InsightSeverity;
  patch?: InsightPatch;
}

/** 该 insight 关联的具体阶段元素 — UI 渲染 timeline 时用来在阶段卡内挂 #N 徽章。 */
export interface InsightStageRefs {
  doctorRuleIds?: string[];
  /** observe 信号类型标签:'high-failure-rate' / 'gap' / 'uncovered-files'。
   *  observe 内单条信号没像 doctor rule / eval sample 那么细的 id,用类型标即可。 */
  observeRefs?: string[];
}

export interface Insight {
  id: string;
  category: InsightCategory;
  audience: InsightAudience;
  /** 用户语标题。 */
  title: string;
  /** 一句话现象描述(标题之外的细节)。 */
  description?: string;
  severity: InsightSeverity;
  affectedCount: number;
  evidence: InsightEvidence[];
  recommendations: InsightRecommendation[];
  /** 关联到 timeline 哪些阶段元素 — renderer 据此在阶段卡内插入 #N 徽章。 */
  stageRefs?: InsightStageRefs;
}

export interface DetectInsightsOptions {
  /**
   * Diagnosis 是 observe 侧迁移后的主数据源。传入该字段时,observe 相关 insight
   * 从 Diagnosis 投影,不再从 entry.observe 重复推断,避免维护者新增规则时双写。
   */
  diagnostics?: Diagnosis[];
}

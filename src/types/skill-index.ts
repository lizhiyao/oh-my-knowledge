/**
 * Skill-centric 聚合 DTO 与 Insight DTO。
 *
 * Studio 的 list / detail 视图层(renderer/skill-*-renderer)只依赖这些稳定形状,
 * 不直接 import server 装配层。runtime 函数(buildSkillIndex / detectInsights 等)
 * 仍在 src/server/skill-index.ts 与 src/server/skill-insights.ts。
 */
import type { Diagnosis, StudioDiagnosisSummary } from './diagnosis.js';
import type { DoctorRuleResult, DoctorSkillStatus } from './doctor.js';

export interface SkillDoctorSnapshot {
  reportId: string;
  timestamp: string;
  status: DoctorSkillStatus;
  passCount: number;
  warnCount: number;
  failCount: number;
  results: DoctorRuleResult[];
}

export interface SkillEvalSnapshot {
  reportId: string;
  timestamp: string;
  variantName: string;
  verdictLevel: string;
  verdictHeadline: string;
  compositeScore: number | null;
  passCount: number;
  failCount: number;
  tripwireCount: number;
  totalSamples: number;
}

export interface SkillObserveSnapshot {
  analysisId: string;
  generatedAt: string;
  healthBand: 'green' | 'yellow' | 'red';
  failureRate: number;
  segmentCount: number;
  gapRate: number;
}

export interface SkillIndexEntry {
  skillName: string;
  /** 当前(最新)snapshot — 等价于对应 history 的最后一项,空时为 null。renderer
   *  老路径直接读这个,不必动 history。 */
  doctor: SkillDoctorSnapshot | null;
  eval: SkillEvalSnapshot | null;
  observe: SkillObserveSnapshot | null;
  /** 历史 snapshot,chronological 升序(最早 → 最近)。renderer 用它画 sparkline 趋势。 */
  doctorHistory: SkillDoctorSnapshot[];
  evalHistory: SkillEvalSnapshot[];
  observeHistory: SkillObserveSnapshot[];
  /** 综合健康灯。doctor / eval / observe 任一红 → red;任一黄 → yellow;
   *  全绿 → green;皆未跑 → gray。 */
  band: 'green' | 'yellow' | 'red' | 'gray';
}

export interface SkillIndexSummary {
  totalSkills: number;
  withEval: number;
  withObserve: number;
  withDoctor: number;
  red: number;
  yellow: number;
  green: number;
  gray: number;
}

export interface SkillIndex {
  entries: SkillIndexEntry[];
  summary: SkillIndexSummary;
  /** detectInsights 结果按 skillName 索引。在 buildSkillIndex 时同步算好,跟 SkillIndex
   *  本身共享同一 fingerprint 缓存(reports 数组 + dir mtime 任一变就 invalidate)。
   *  list 页 N×detectInsights 重算的 CPU 开销由此消除。 */
  insightsBySkill: Map<string, Insight[]>;
  diagnosticsBySkill: Map<string, Diagnosis[]>;
  diagnosisSummary: StudioDiagnosisSummary;
}

// ───────── Insight ─────────

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

export type InsightPerspective = 'doctor' | 'eval-score' | 'eval-functional' | 'observe';

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
  evalSampleIds?: string[];
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

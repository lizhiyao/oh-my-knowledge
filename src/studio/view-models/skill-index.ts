/**
 * Skill-centric 聚合 DTO。
 *
 * Studio 的 list / detail 视图层(renderer/skill-*-renderer)只依赖这些稳定形状,
 * 不直接 import server 装配层。runtime 函数(buildSkillIndex / detectInsights 等)
 * 运行逻辑归属于 src/studio/application/，与 HTTP host 解耦。
 */
import type { Diagnosis, StudioDiagnosisSummary } from '../../diagnosis/contracts.js';
import type { DoctorRuleResult, DoctorSkillStatus } from '../../doctor/contracts.js';
import type { Insight } from './insight.js';

export interface SkillDoctorSnapshot {
  reportId: string;
  timestamp: string;
  status: DoctorSkillStatus;
  passCount: number;
  warnCount: number;
  failCount: number;
  results: DoctorRuleResult[];
}

export interface SkillObserveSnapshot {
  analysisId: string;
  generatedAt: string;
  healthBand: 'green' | 'yellow' | 'red';
  failureRate: number;
  toolCallCount?: number;
  toolResolvedCount?: number;
  toolCancelledCount?: number;
  toolUnknownCount?: number;
  segmentCount: number;
  gapRate: number;
  stability?: 'stable' | 'unstable' | 'very-unstable' | 'unknown';
  /** 统计可信度(按 segment 数)。underpowered 时下游 insight / card 不应触发硬红或 high severity。
   *  历史快照缺此字段时由 segmentCount 兜底推导。 */
  confidence: 'high' | 'low' | 'underpowered';
}

export interface SkillGraphStageSnapshot {
  sourceKind: 'doctor';
  sourceId: string;
  graphId: string;
  generatedAt: string;
  graphPath?: string;
  nodeCount: number;
  edgeCount: number;
}

export interface SkillGraphNodePreview {
  stableKey?: string;
  nodeKind: string;
  label: string;
  status?: string;
  /** Studio evidence view 用于把 assertion / diagnostic 归到对应 sample。 */
  parentSampleStableKey?: string;
  coverage?: 'declared' | 'undeclared';
  coveredBySamples?: string[];
}

export interface SkillGraphCoverageEdgePreview {
  sampleStableKey?: string;
  sampleLabel: string;
  sampleStatus?: string;
  targetStableKey: string;
  targetNodeKind: string;
  targetLabel: string;
}

export interface SkillGraphSnapshot {
  /** Studio 聚合 graph sidecar 时实际采用的绑定强度。 */
  bindingStrength: 'content-hash' | 'source-locator' | 'name-only' | 'mixed';
  artifactHash?: string;
  sourceLocator?: string;
  doctor?: SkillGraphStageSnapshot & {
    references: number;
    scripts: number;
    workflows: number;
    workflowNodes: number;
    hardRules: number;
    definitionNodes: SkillGraphNodePreview[];
  };
}

export interface SkillIndexEntry {
  skillName: string;
  /** 当前(最新)snapshot — 等价于对应 history 的最后一项,空时为 null。renderer
   *  老路径直接读这个,不必动 history。 */
  doctor: SkillDoctorSnapshot | null;
  observe: SkillObserveSnapshot | null;
  /** 历史 snapshot,chronological 升序(最早 → 最近)。renderer 用它画 sparkline 趋势。 */
  doctorHistory: SkillDoctorSnapshot[];
  observeHistory: SkillObserveSnapshot[];
  /** 综合健康灯。doctor / observe 任一红 → red;任一黄 → yellow;
   *  全绿 → green;皆未跑 → gray。 */
  band: 'green' | 'yellow' | 'red' | 'gray';
  /** doctor graph sidecar 的轻量 Studio 投影。 */
  graph?: SkillGraphSnapshot;
}

export interface SkillIndexSummary {
  totalSkills: number;
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

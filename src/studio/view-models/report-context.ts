/** 一个维度 chip（doctor / eval / observe）。score 0-100,null=无分;href=null 表示当前页或无数据。 */
export interface SkillReportContextChip {
  dim: 'doctor' | 'eval' | 'observe';
  label: string;
  score: number | null;
  band: 'green' | 'yellow' | 'red' | 'gray';
  href: string | null;
  active: boolean;
}

/** 「全部历史」弹框里的一条历史记录(doctor / eval 的某一次 run)。 */
export interface SkillReportHistoryItem {
  dim: 'doctor' | 'eval' | 'observe';
  dateText: string;
  scoreText: string;
  /** 分数色档,用于一眼扫出哪次回归。 */
  band: 'green' | 'yellow' | 'red' | 'gray';
  metaText: string;
  href: string;
  current: boolean;
}

/** 报告页顶部的「skill 上下文」：三个维度互链 + 「全部历史」弹框。让同一 skill 的报告跨维度/跨轮次都能一跳到达。 */
export interface SkillReportContext {
  /** 规范 skill 名(来自 skill-index entry)— 各报告页头部统一用它,避免 eval/doctor 名字不一致。 */
  skillName: string;
  /** 综合健康分(跨维度聚合,与首页列表同口径)。报告页只显单维度,这里把「总分」也带上。 */
  overall: { score: number | null; band: 'green' | 'yellow' | 'red' | 'gray' };
  chips: SkillReportContextChip[];
  /** 该 skill 的 doctor + eval 历次报告,供「全部历史」弹框选择。 */
  history: SkillReportHistoryItem[];
}


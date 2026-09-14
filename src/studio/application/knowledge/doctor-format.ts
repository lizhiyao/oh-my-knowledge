/**
 * 体检结果的呈现口径投影。
 *
 * finding 的强弱分级、规则排序、采样降级判定都是「同一条 finding 在列表／详情／图例里必须读成同一种
 * 颜色」的口径，放在这里一次算完，React 树只取标签与色调，不重新解释体检引擎的词汇 —— 与
 * application/observe/health-format.ts、application/knowledge/managed-format.ts 同一条边界。
 */
import type { DoctorRuleResult, DoctorRuleStatus } from '../../../knowledge-artifacts/doctor/contracts.js';
import type { SkillGraphNodePreview, SkillGraphSnapshot } from '../../view-models/knowledge/skill-index.js';

/** 体检引擎在 finding 上使用的中文分级词（见 doctor/health/dimension-spec.ts 的 HealthFindingLevel）。 */
type EngineFindingLevel = '错误' | '警告' | '建议';

/** 呈现分级：error=确诊问题，warning=亚健康，tip=建议，info=引擎给了未知级别时按信息呈现。 */
type DoctorFindingTone = 'error' | 'warning' | 'tip' | 'info';

interface DoctorFindingView {
  tone: DoctorFindingTone;
  description: string;
  suggestion?: string;
  /** 多采样共识支持度：N 次采样里有 k 次报了这条。n<=1 时不呈现（单次采样无意义）。 */
  support?: { k: number; n: number };
}

export interface DoctorRuleView {
  ruleId: string;
  /** 人话规则名（维度 displayName），缺失时回退 ruleId —— 与终端渲染器同一读法。 */
  title: string;
  status: DoctorRuleStatus;
  /** 引擎给出的这条规则一句话结论（已 i18n）。没有 findings 的规则只剩它可读。 */
  message: string;
  /** 规则级修复建议（已 i18n），finding 之外的可操作提示。 */
  hint?: string;
  findings: DoctorFindingView[];
}

export interface DoctorSamplingView {
  requested: number;
  succeeded: number;
}

interface RawFinding {
  level?: unknown;
  description?: unknown;
  suggestion?: unknown;
  support?: unknown;
}

const TONE_BY_LEVEL: Record<EngineFindingLevel, DoctorFindingTone> = {
  '错误': 'error',
  '警告': 'warning',
  '建议': 'tip',
};

/** 同一 finding 集合内的呈现顺序：错误 → 警告 → 建议；未知级别原序落在最后，不丢弃。 */
const TONE_ORDER: Record<DoctorFindingTone, number> = { error: 0, warning: 1, tip: 2, info: 3 };

const SORT_ORDER: Record<DoctorRuleStatus, number> = { fail: 0, warn: 1, pass: 2, skipped: 3 };

const SUMMARY_SUFFIX = ':_summary';

function toFinding(raw: RawFinding): DoctorFindingView {
  const level = raw.level;
  const tone = typeof level === 'string' && level in TONE_BY_LEVEL
    ? TONE_BY_LEVEL[level as EngineFindingLevel]
    : 'info';
  const support = raw.support as { k?: unknown; n?: unknown } | undefined;
  const view: DoctorFindingView = {
    tone,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
  if (typeof raw.suggestion === 'string' && raw.suggestion) view.suggestion = raw.suggestion;
  if (typeof support?.k === 'number' && typeof support.n === 'number' && support.n > 1) {
    view.support = { k: support.k, n: support.n };
  }
  return view;
}

function detailOf(result: DoctorRuleResult): { displayName?: unknown; findings?: unknown } {
  return (result.detail ?? {}) as { displayName?: unknown; findings?: unknown };
}

/**
 * 逐条规则视图：pass / warn 的 `:_summary` 伪规则剔除（它承载采样元数据，不是一条体检规则），
 * 但**失败的 `_summary` 必须保留**——全部采样解析失败时 composer 只产出这一条 fatal 记录，
 * 剔掉它页面会同时「报红」和「所有规则通过」，唯一可操作诊断消失。
 * 按 fail → warn → pass → skipped 排序，组内保持引擎产出顺序。
 */
export function projectDoctorRules(results: readonly DoctorRuleResult[]): DoctorRuleView[] {
  return results
    .filter((result) => !result.ruleId.endsWith(SUMMARY_SUFFIX) || result.status === 'fail')
    .map((result) => {
      const detail = detailOf(result);
      const rawFindings = Array.isArray(detail.findings) ? detail.findings as RawFinding[] : [];
      const findings = rawFindings
        .map(toFinding)
        .sort((left, right) => TONE_ORDER[left.tone] - TONE_ORDER[right.tone]);
      return {
        ruleId: result.ruleId,
        title: typeof detail.displayName === 'string' && detail.displayName ? detail.displayName : result.ruleId,
        status: result.status,
        message: result.message,
        ...(typeof result.hint === 'string' && result.hint ? { hint: result.hint } : {}),
        findings,
      };
    })
    .sort((left, right) => SORT_ORDER[left.status] - SORT_ORDER[right.status]);
}

/** 该次体检的 summary 规则（无则 null），用于采样降级与耗时等元信息。 */
function findDoctorSummary(results: readonly DoctorRuleResult[]): DoctorRuleResult | undefined {
  return results.find((result) => result.ruleId.endsWith(SUMMARY_SUFFIX));
}

/**
 * 采样降级：请求 n 次只成功解析 k<n 次时，finding 的 k/n 支持度只基于成功样本，
 * 必须显式告警而不是让用户以为共识完整。未降级（或单次采样）返回 null。
 */
export function projectDoctorSampling(results: readonly DoctorRuleResult[]): DoctorSamplingView | null {
  const detail = findDoctorSummary(results)?.detail as { samples?: DoctorSamplingView } | undefined;
  const requested = detail?.samples?.requested;
  const succeeded = detail?.samples?.succeeded;
  if (typeof requested !== 'number' || typeof succeeded !== 'number') return null;
  if (requested <= 1 || succeeded >= requested) return null;
  return { requested, succeeded };
}

/** 结构证据的分组条目：同一类定义节点归并，供折叠区按类呈现。 */
interface DoctorGraphNodeGroup {
  nodeKind: string;
  nodes: SkillGraphNodePreview[];
}

export interface DoctorGraphView {
  /**
   * Studio 聚合 sidecar 时实际采用的绑定强度。`source-locator` 是路径对上、`name-only` 只是
   * 名称对上，两档弱绑定都不构成内容证明。
   */
  binding: SkillGraphSnapshot['bindingStrength'];
  /**
   * 可跨机器核对的内容身份。`sourceLocator` 是用户本机的绝对路径，对页面没有额外信息量，
   * 因此不进这层投影，只留内容哈希。
   */
  artifactHash?: string;
  /** 该结构来自哪一轮体检——与页面正在查看的轮次不一定同一次。 */
  sourceId: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  counts: {
    references: number;
    scripts: number;
    workflows: number;
    workflowNodes: number;
    hardRules: number;
  };
  nodeGroups: DoctorGraphNodeGroup[];
}

/** 定义节点的呈现顺序：跟着 skill 的物理结构走，未知类型排最后且不丢弃。 */
const DEFINITION_NODE_ORDER: readonly string[] = [
  'skill_file', 'frontmatter', 'reference', 'script', 'preflight', 'tool',
  'hard_rule', 'workflow', 'workflow_node', 'doctor_rule_result',
];

function nodeOrder(kind: string): number {
  const index = DEFINITION_NODE_ORDER.indexOf(kind);
  return index < 0 ? DEFINITION_NODE_ORDER.length : index;
}

/**
 * doctor graph sidecar 的结构证据投影。没有 sidecar、或 sidecar 里没有 doctor 阶段的
 * 结构事实时返回 null —— 页面宁可不显示，也不给出一份读不出绑定强度的空壳。
 */
export function projectDoctorGraph(graph: SkillGraphSnapshot | undefined | null): DoctorGraphView | null {
  const stage = graph?.doctor;
  if (!graph || !stage) return null;
  const grouped = new Map<string, SkillGraphNodePreview[]>();
  for (const node of stage.definitionNodes) {
    const list = grouped.get(node.nodeKind) ?? [];
    list.push(node);
    grouped.set(node.nodeKind, list);
  }
  return {
    binding: graph.bindingStrength,
    ...(graph.artifactHash ? { artifactHash: graph.artifactHash } : {}),
    sourceId: stage.sourceId,
    generatedAt: stage.generatedAt,
    nodeCount: stage.nodeCount,
    edgeCount: stage.edgeCount,
    counts: {
      references: stage.references,
      scripts: stage.scripts,
      workflows: stage.workflows,
      workflowNodes: stage.workflowNodes,
      hardRules: stage.hardRules,
    },
    nodeGroups: [...grouped]
      .sort(([left], [right]) => nodeOrder(left) - nodeOrder(right) || left.localeCompare(right))
      .map(([nodeKind, nodes]) => ({ nodeKind, nodes })),
  };
}

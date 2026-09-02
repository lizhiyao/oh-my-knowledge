import type { ArtifactKind } from '../knowledge-artifacts/contracts.js';

/**
 * 受管 artifact 记录(managed record)——证据门控管理的最小持久单元。
 *
 * 设计原则(见 docs/specs/evidence-gated-management.md §5/§6):**只落盘事实与指针**。
 * verdict / 可比性 / underpowered 是从 Evaluation Core 投影得到的事实；生命周期标签
 * (installed / measurable / stale)也是读时推导(见 `deriveManagedState`),不持久 ——
 * 持久一个会随源文件漂移而过期的标签等于让记录"撒谎"。需要"状态随时间"时持久化
 * append-only 事件(installedAt、未来的 promote/reject/rollback 决定),而非可变标签。
 *
 * 判别字命名:外层 `recordKind` / 决定的 `decisionKind` 都是限定名;唯一的裸 `kind` 是
 * `ManagedArtifactRecord.kind: ArtifactKind`——这正是裸 kind 该有的语义(知识 artifact 类型)。
 */

/** 一次分发落点的事实(把 skill 拷进某个 agent 工具 skill 目录)。 */
export interface ManagedDistributionTarget {
  /** 目标标签,如 'Claude Code' / 'Codex/AGENTS' / 'custom'。 */
  label: string;
  /** 实际写入的绝对路径({skillsDir}/{name} 或 {skillsDir}/{name}.md)。 */
  path: string;
  /** 拷到此目标的内容 hash(= 安装时源 hash)。 */
  contentHash: string;
  copiedAt: string;
}

/** Evaluation Core 认证产物的最小受管证据投影。install 时为空，eval 完成后追加。 */
export interface ManagedEvidenceRef {
  evidenceSource: 'evaluation-core';
  runId: string;
  reportId: string;
  reportDigest: string;
  /** 该 report 测的是哪份内容（artifact contentHash）。读时只把与记录当前 contentHash 匹配的
   *  evidence 算作当前有效证据——重装到新内容后旧证据保留供回滚,但不让新内容显得已测。 */
  contentHash: string;
  artifactDigest: string;
  targetId: string;
  recordedAt: string;
  /** Core decision policy 产生的 verdict。存字符串而非引用 policy 类型，保持受管契约不反向依赖 Core；
   *  promote 门禁只接受明确列入白名单的值。 */
  verdict?: string;
  decisionReasonCodes?: string[];
  evidenceReadiness: 'decision-ready' | 'measurement-only' | 'insufficient';
  /** §5 mandatory：`count` 是 Core execution plan 的样本数，`hash` 是 sealed dataset revision digest。 */
  sampleCoverage: { count: number; hash: string };
  coreComparability: {
    runContractDigest: string;
    datasetRevisionDigest: string;
    executionPlanDigest: string;
    evaluationPlanDigest: string;
    analysisPlanDigest: string;
    decisionPlanDigest: string;
  };
}

export type ManagedDecisionKind = 'promote' | 'reject' | 'rollback';

/** 一次人工管理决定。install 时为空,promote/reject/rollback 追加(append-only 事件流)。 */
export interface ManagedDecision {
  decisionKind: ManagedDecisionKind;
  actor: string;
  decidedAt: string;
  reason?: string;
  /** 被该决定接受 / 回滚到的内容 hash —— 锚定「决定的是哪份内容」。promote 取决定时的 record.contentHash;
   *  读时只把与当前 contentHash 匹配的 promote 决定算作「当前版本已 promoted」(旧内容的决定不冒充当前)。 */
  contentHash?: string;
  /** 该决定锚定的 Core run，可回溯「凭什么 ship」。 */
  runId?: string;
  /** 越门记录:门禁本应拦下,经 --force 显式越过时记下供审计(spec §7「Overrides must be explicit and
   *  recorded」)。无此字段 = 正常通过门禁。`verdict` 是越门时证据的 verdict(上下文);`overriddenBlocks`
   *  是真正被越过的判据（drifted / verdict_blocked），让审计能回答「越过了什么」—— 只看
   *  verdict 会误导(仅因 drift 越门时 verdict 可能仍是 PROGRESS)。 */
  override?: { verdict: string; overriddenBlocks?: string[] };
}

/** observe → 管理支柱的生产健康观测(#235)。append-only,与 evidence / decisions 同为事实事件流。
 *  observe 报告只带 skill **名**(无 contentHash)→ 按 name + kind 绑记录,不锚 contentHash;且观测的是线上
 *  **正在跑的那一版**(可能已非记录当前版),故是**版本无关的生产信号**,产出读时 marker(production gap),
 *  绝不翻 stale 生命周期(§6.1 只有内容漂移翻 stale)。样本建议只提示,不改样本集。 */
export interface ManagedObservation {
  /** 限定判别字(裸 kind 留给 ArtifactKind)。 */
  observationKind: 'production-health';
  /** observe-health 报告 id —— append 去重主键(observe 无 contentHash,故不用 (reportId, contentHash))。 */
  reportId: string;
  /** 被观测**流量窗口的结束时刻**(report.meta.timeRange.to)——不是报告生成的「此刻」(generatedAt 恒约等于
   *  now,拿它做 latest-wins 会让所有观测看起来一样新)。deriveProductionGap 据此取最新一条观测。注:观测是
   *  **版本无关的生产信号**(量的是线上部署版),不按源码版归因,见 deriveProductionGap。 */
  observedAt: string;
  /** 该 skill 在窗口内的盲区率与严重度加权盲区率(直接取 observe 已算好的 per-skill 值,不重算)。 */
  gapRate: number;
  weightedGapRate: number;
  /** 统计功效:underpowered = 段数太少不可知(§6.1 unknown,既不放行也不拦截,不当确诊盲区)。 */
  confidence: 'high' | 'low' | 'underpowered';
  /** per-skill 色带,由 observe CLI 侧用 observability 的 healthBandOf 算好传入(阈值单一来源)。 */
  healthBand: 'green' | 'yellow' | 'red';
  /** 该 skill 在窗口内的被观测段数(功效上下文)。 */
  segmentCount: number;
  /** 盲区按信号类型计数 —— 驱动「建议补哪类用例」提示(只展示,不生成用例)。 */
  gapByType: { failed_search: number; explicit_marker: number; hedging: number; repeated_failure: number };
}

export interface ManagedArtifactSource {
  /** 源类型(限定判别字,非裸 kind)。`file`=本地路径;`git`=当前仓库某 ref 或远端(带 url)。 */
  sourceKind: 'file' | 'git';
  /** 源身份,按 sourceKind 分义:
   *   - file:本地重哈根(目录-skill 为根目录、文件-skill 为 .md),`hashArtifactSource(locator, isDirectorySkill)` 直接 round-trip;
   *   - 本地 git:`git:<ref>:<name>`;远端 git:`git+<url>@<sha>:<name>`(均非临时物化路径,远端串仅作身份、不回喂 parseGitInput)。
   *     drift 由 resolver 重物化重哈 —— mutable ref 给真实漂移、SHA 给不可变。 */
  locator: string;
  /** git 来源的 ref(file 源无);远端为 fetch 后 pin 的实际 SHA。 */
  ref?: string;
  /** 远端 git 的 URL(本地源 / 本地 git 无)。结构化存,供 drift 重取,不必从 locator 反 parse。 */
  url?: string;
  /** 目录-skill(SKILL.md + assets)还是裸 .md 文件-skill。 */
  isDirectorySkill: boolean;
}

/** 一条记录一个文件 `.omk/governance/managed/<id>.json`,自带 recordKind + schemaVersion 便于单独迁移。 */
export interface ManagedArtifactRecord {
  recordKind: 'managed-artifact';
  /** v3 仅接受 Evaluation Core 认证证据；旧记录不迁移。 */
  schemaVersion: 3;
  /** 稳定身份 = hash(kind, name);源路径是可变属性、不进 id——挪动源文件不孤儿化记录。 */
  id: string;
  name: string;
  kind: ArtifactKind;
  source: ManagedArtifactSource;
  /** 安装时的源内容 hash——drift baseline。 */
  contentHash: string;
  /** 首次纳管时间("under management since");per-target 时效看 distribution[].copiedAt。 */
  installedAt: string;
  distribution: ManagedDistributionTarget[];
  evidence: ManagedEvidenceRef[];
  decisions: ManagedDecision[];
  /** #235 observe 生产健康观测(append-only)。旧记录无 → optional;deriveManagedState 不依赖它,
   *  production gap 是读时 marker(deriveProductionGap),不翻 stale。 */
  observations?: ManagedObservation[];
}

/** 读时推导的生命周期标签——不持久(见文件头说明)。`promoted` 由当前内容(contentHash 匹配)有一条
 *  promote 决定推出:它是 measurable 之上的「已人工接受当前版本」,故优先级高于 measurable。 */
export type ManagedLifecycleLabel = 'discovered' | 'installed' | 'measurable' | 'stale' | 'promoted';

export interface DerivedManagedState {
  label: ManagedLifecycleLabel;
  /** 当前源 hash 与记录的 contentHash 不一致(或源已不在)。 */
  drifted: boolean;
  hasEvidence: boolean;
}

/** 推导所需、但不在记录里的当前事实(源文件现状、doctor/samples 状态)。 */
export interface DeriveManagedStateInput {
  record: ManagedArtifactRecord;
  /** 源文件当前内容 hash;undefined = 源已不在。 */
  currentContentHash?: string;
  /** 是否已有 samples / doctor 通过(用于 measurable);install 不传。 */
  hasSamplesOrDoctorPass?: boolean;
}

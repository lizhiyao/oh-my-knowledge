import type { ArtifactKind } from './eval.js';

/**
 * 受管 artifact 记录(managed record)——证据门控管理的最小持久单元。
 *
 * 设计原则(见 docs/specs/evidence-gated-management.md §5/§6):**只落盘事实与指针**。
 * verdict / 可比性 / underpowered 是从 Report 推导出来的,不是这里的持久列;生命周期标签
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

/** 指向一份 Report 的引用——不是 verdict 本体。install 时为空,eval/promote 追加。 */
export interface ManagedEvidenceRef {
  reportId: string;
  /** 该 report 测的是哪份内容(artifact contentHash)。读时只把与记录当前 contentHash 匹配的
   *  evidence 算作当前有效证据——重装到新内容后旧证据保留供回滚,但不让新内容显得已测。 */
  contentHash: string;
  recordedAt: string;
}

export type ManagedDecisionKind = 'promote' | 'reject' | 'rollback';

/** 一次人工管理决定。install 时为空,promote/reject/rollback 追加。 */
export interface ManagedDecision {
  decisionKind: ManagedDecisionKind;
  actor: string;
  decidedAt: string;
  reason?: string;
}

export interface ManagedArtifactSource {
  /** 源文件路径(目录-skill 为其 SKILL.md,文件-skill 为 .md);drift 检测据此重读重哈。 */
  locator: string;
  /** git 来源的 ref(预留)。 */
  ref?: string;
  /** 目录-skill(SKILL.md + assets)还是裸 .md 文件-skill。 */
  isDirectorySkill: boolean;
}

/** 一条记录一个文件 `.omk/managed/<id>.json`,自带 recordKind + schemaVersion 便于单独迁移。 */
export interface ManagedArtifactRecord {
  recordKind: 'managed-artifact';
  schemaVersion: 1;
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
}

/** 读时推导的生命周期标签——不持久(见文件头说明)。 */
export type ManagedLifecycleLabel = 'discovered' | 'installed' | 'measurable' | 'stale';

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

/**
 * `omk list` 的纯视图构造(#203 管理支柱)—— 把受管记录摊成可渲染的行,不做任何 IO。
 *
 * 「当前源内容哈」由调用方注入(`currentHashOf`):CLI 侧重物化真源算哈,单测侧给 mock —— 保持本模块
 * 纯函数、可测。生命周期 state 走 `deriveManagedState`(源缺失 / 漂移 → stale;有当前证据 → measurable;
 * 否则 installed)。verdict / 可比性取**当前有效证据**(contentHash == record.contentHash)里 recordedAt
 * 最新那条 —— 旧内容的证据不冒充当前(与 deriveManagedState 同口径)。
 */
import type { ArtifactKind, ManagedArtifactRecord, ManagedLifecycleLabel } from '../types/index.js';
import { deriveManagedState } from './store.js';

export interface ManagedListRow {
  id: string;
  name: string;
  /** artifact 类型,直取自记录(裸 kind 留给 ArtifactKind,见 terminology-spec §5.4)。 */
  kind: ArtifactKind;
  sourceKind: 'file' | 'git';
  /** 展示用源标识:远端 git 优先 url、否则 locator。 */
  sourceLabel: string;
  state: ManagedLifecycleLabel;
  drifted: boolean;
  /** 当前有效证据(若有)里 recordedAt 最新那条的 verdict。 */
  latestVerdict?: string;
  /** 该证据的可比性 marker —— 跨报告比 verdict 前需一致。 */
  comparability?: { cliVersion: string; judgePromptHash?: string; debiasMode?: Array<'length' | 'position'> };
  /** 最新当前证据的记录时间。 */
  recordedAt?: string;
  /** 当前有效证据数 / 全部证据数(含旧内容的历史证据)。 */
  currentEvidenceCount: number;
  totalEvidenceCount: number;
  distributionCount: number;
}

function latestCurrentEvidence(record: ManagedArtifactRecord) {
  const current = record.evidence.filter((e) => e.contentHash === record.contentHash);
  if (current.length === 0) return undefined;
  // recordedAt 是 ISO 串,字典序即时间序;并列取后出现的。
  return current.reduce((a, b) => (b.recordedAt >= a.recordedAt ? b : a));
}

export function buildManagedListRow(
  record: ManagedArtifactRecord,
  currentContentHash: string | undefined,
): ManagedListRow {
  const state = deriveManagedState({ record, currentContentHash });
  const latest = latestCurrentEvidence(record);
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    sourceKind: record.source.sourceKind,
    sourceLabel: record.source.url ?? record.source.locator,
    state: state.label,
    drifted: state.drifted,
    ...(latest?.verdict ? { latestVerdict: latest.verdict } : {}),
    ...(latest?.comparability ? { comparability: latest.comparability } : {}),
    ...(latest?.recordedAt ? { recordedAt: latest.recordedAt } : {}),
    currentEvidenceCount: record.evidence.filter((e) => e.contentHash === record.contentHash).length,
    totalEvidenceCount: record.evidence.length,
    distributionCount: record.distribution.length,
  };
}

/**
 * 组装全部行。`currentHashOf` 给每条记录算当前源内容哈(undefined = 源已不在 → stale)。
 * 按 name 排序(稳定、可读);同名再按 kind。
 */
export function buildManagedListRows(
  records: ManagedArtifactRecord[],
  currentHashOf: (record: ManagedArtifactRecord) => string | undefined,
): ManagedListRow[] {
  return records
    .map((r) => buildManagedListRow(r, currentHashOf(r)))
    .sort((a, b) => (a.name === b.name ? a.kind.localeCompare(b.kind) : a.name.localeCompare(b.name)));
}

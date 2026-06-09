/**
 * `omk list` 的纯视图构造(#203 管理支柱)—— 把受管记录摊成可渲染的行,不做任何 IO。
 *
 * 「当前源探测」由调用方注入(`probeOf`):CLI 侧重物化真源算哈,单测侧给 mock —— 保持本模块纯函数、
 * 可测。探测是**三态**:`reachable:true + hash`(算出了当前哈,可判 drift)/ `reachable:false`(源不可达 /
 * 解析失败 / 拒绝读取)。**不可达 ≠ 已 drift** —— 把「这里查不了」当「内容变了」会对从别处看的本地 git 记录
 * 误报 stale(locator 随 cwd 漂),所以不可达时只按证据给 installed/measurable、不打 drift、单独标「未核」。
 * reachable 时才走 `deriveManagedState`(哈不等 → stale)。verdict / 可比性取**当前有效证据**
 * (contentHash == record.contentHash)里 recordedAt 最新那条 —— 旧内容的证据不冒充当前。
 */
import type { ArtifactKind, ManagedArtifactRecord, ManagedLifecycleLabel } from '../types/index.js';
import { deriveManagedState } from './store.js';

/** 当前源探测结果(三态)。`reachable:false` = 不可达 / 解析失败 / 拒读,**不等于**已 drift。 */
export interface SourceProbe {
  reachable: boolean;
  /** 当前源整树 / 单文件哈;仅 reachable 时有。 */
  hash?: string;
}

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
  /** 当前源是否被成功核对过 hash。false = 不可达/拒读 → drift 未核(不据此判 stale)。 */
  reachable: boolean;
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

export function buildManagedListRow(record: ManagedArtifactRecord, probe: SourceProbe): ManagedListRow {
  const currentEvidenceCount = record.evidence.filter((e) => e.contentHash === record.contentHash).length;
  let state: ManagedLifecycleLabel;
  let drifted: boolean;
  if (probe.reachable) {
    // 算出了当前哈:正常推导(哈不等 → stale/drift)。
    const d = deriveManagedState({ record, currentContentHash: probe.hash });
    state = d.label;
    drifted = d.drifted;
  } else {
    // 不可达:不据此判 stale —— 只按证据给 installed/measurable,drift 标未核。
    state = currentEvidenceCount > 0 ? 'measurable' : 'installed';
    drifted = false;
  }
  const latest = latestCurrentEvidence(record);
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    sourceKind: record.source.sourceKind,
    sourceLabel: record.source.url ?? record.source.locator,
    state,
    drifted,
    reachable: probe.reachable,
    ...(latest?.verdict ? { latestVerdict: latest.verdict } : {}),
    ...(latest?.comparability ? { comparability: latest.comparability } : {}),
    ...(latest?.recordedAt ? { recordedAt: latest.recordedAt } : {}),
    currentEvidenceCount,
    totalEvidenceCount: record.evidence.length,
    distributionCount: record.distribution.length,
  };
}

/**
 * 组装全部行。`probeOf` 给每条记录探测当前源(三态,见文件头)。
 * 按 name 排序(稳定、可读);同名再按 kind。
 */
export function buildManagedListRows(
  records: ManagedArtifactRecord[],
  probeOf: (record: ManagedArtifactRecord) => SourceProbe,
): ManagedListRow[] {
  return records
    .map((r) => buildManagedListRow(r, probeOf(r)))
    .sort((a, b) => (a.name === b.name ? a.kind.localeCompare(b.kind) : a.name.localeCompare(b.name)));
}

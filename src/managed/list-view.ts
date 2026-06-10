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
import { deriveManagedState, isCurrentlyPromoted } from './store.js';

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
  /** 展示用源标识:仅远端 git(sourceKind==='git' 且带 url)显 url,其余一律显 locator —— 保证「显示的」
   *  就是「被 probe / 读取的」路径,file 源即便混入 url(validator 已拒)也不显示它。 */
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

/** 当前有效证据(contentHash == record.contentHash)里 recordedAt 最新那条;无则 undefined。
 *  list(展示最新 verdict)与 promote(门禁取证)共用同一口径——旧内容的证据不冒充当前。 */
export function latestCurrentEvidence(record: ManagedArtifactRecord) {
  const current = record.evidence.filter((e) => e.contentHash === record.contentHash);
  if (current.length === 0) return undefined;
  // 取 recordedAt 最新的一条。omk 自写恒 UTC `Z`、字典序即时间序;但记录可手改 / 随仓库分发,异偏移
  // 或异精度的 ISO 串字典序会乱 → 优先按解析后的真实时刻比,两端都可解析才用;否则退回字典序(不劣化
  // omk 自写场景)。并列取后出现的。
  const ms = (s: string): number | null => { const n = Date.parse(s); return Number.isNaN(n) ? null : n; };
  return current.reduce((a, b) => {
    const ta = ms(a.recordedAt); const tb = ms(b.recordedAt);
    if (ta !== null && tb !== null) return tb >= ta ? b : a;
    return b.recordedAt >= a.recordedAt ? b : a;
  });
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
    // 不可达:不据此判 stale。promote 决定是**内容锚定**的(只看 record.decisions + record.contentHash,
    // 不依赖源能否被 probe),故当前内容仍处于 promoted 态时保留 promoted —— 它比 evidence 更不该因源不可达
    // 丢失(deriveManagedState 的 promoted 分支同理)。否则按证据给 measurable/installed,drift 标未核。
    state = isCurrentlyPromoted(record) ? 'promoted' : currentEvidenceCount > 0 ? 'measurable' : 'installed';
    drifted = false;
  }
  const latest = latestCurrentEvidence(record);
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    sourceKind: record.source.sourceKind,
    sourceLabel: record.source.sourceKind === 'git' && record.source.url ? record.source.url : record.source.locator,
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
 * 按 name 排序(稳定、可读);name collation 相等再按 kind。排序对机读出口(--json)也生效,故:
 *   - **钉死 locale**(`'en'`):缺省 locale 随宿主 LANG / LC_COLLATE 漂,会让两台机器对同一批记录排出不同
 *     JSON 顺序,破坏 omk「确定、可比」的底色。
 *   - 平级判定用**同一 collation 度量**(localeCompare 结果是否为 0)而非 `===`:NFC / NFD 等价的同显示名
 *     在 `===` 下不等、却 collation 相等,用 `===` 会漏掉 kind 平级 tiebreak、令顺序退回 readdir 序(不定)。
 */
export function buildManagedListRows(
  records: ManagedArtifactRecord[],
  probeOf: (record: ManagedArtifactRecord) => SourceProbe,
): ManagedListRow[] {
  return records
    .map((r) => buildManagedListRow(r, probeOf(r)))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name, 'en');
      return byName !== 0 ? byName : a.kind.localeCompare(b.kind, 'en');
    });
}

/**
 * promote 证据门禁(纯函数,无 IO)——`omk list` 读侧判据的写侧对应。
 *
 * 把「这份当前版本是否值得 ship」收成一组可拦截原因。门禁只消费已认证的 Core projection，
 * 不重建评分、不重算可比性。默认只放行 decision-ready + PROGRESS；CAUTIOUS 需显式
 * `acceptCautious`，其余 verdict 一律拦截。
 *
 * force(越门)不在此处:门禁只产「客观判定」。CLI 拿到结果后决定是否 `--force` 越过——但**无当前证据时
 * 无 evidence 可锚定,force 也越不过**(返回的 evidence 为 undefined,CLI 据此拒绝空证据 promote)。
 */
import type { ManagedArtifactRecord, ManagedEvidenceRef } from '../types/index.js';
import { latestCurrentEvidence } from './list-view.js';

export type PromoteBlockKind =
  | 'drifted'             // 源不可达 / 内容已变,证据对应旧内容
  | 'no_current_evidence' // 当前内容无评测证据(终态,force 也越不过)
  | 'verdict_blocked';    // verdict 不在接受集(REGRESS / NOISE / UNDERPOWERED / SOLO / CAUTIOUS 未开关)

export interface PromoteBlock {
  /** 限定判别字(裸 kind 留给 ArtifactKind,见 terminology-spec §5.4);这是「拦截原因」分类、非持久。 */
  blockKind: PromoteBlockKind;
  /** 供 CLI 拼 i18n 参数的可读细节(被拦的 verdict / judge hash 等)。 */
  detail?: Record<string, string>;
}

export interface PromoteGateInput {
  record: ManagedArtifactRecord;
  /** 当前源内容 hash;undefined = 源不可达 / 解析失败(probeSourceState reachable:false)。 */
  currentContentHash?: string;
  /** 接受 CAUTIOUS(默认只接受 PROGRESS)。 */
  acceptCautious?: boolean;
}

export interface PromoteGateResult {
  /** 无任何拦截原因 → 门禁通过。 */
  ok: boolean;
  blocked: PromoteBlock[];
  /** 命中判定的当前有效证据;无当前证据时 undefined —— CLI 据此判定「force 也不能空证据 promote」。 */
  evidence?: ManagedEvidenceRef;
  drifted: boolean;
}

// 默认接受集:只 PROGRESS。
const DEFAULT_ACCEPTED: ReadonlySet<string> = new Set(['PROGRESS']);

export function evaluatePromoteGate(input: PromoteGateInput): PromoteGateResult {
  const { record, currentContentHash, acceptCautious } = input;
  const blocked: PromoteBlock[] = [];
  const drifted = currentContentHash === undefined || currentContentHash !== record.contentHash;

  // 1. drift:源不可达 / 内容已变 → 当前盘上的源不是被测内容,门禁不过(force 可越,见 CLI)。
  if (drifted) blocked.push({ blockKind: 'drifted' });

  // 2. 当前有效证据(contentHash == record.contentHash;源 drift 不影响——证据绑的是记录基线内容)。
  const evidence = latestCurrentEvidence(record);
  if (!evidence) {
    // 无证据无从谈 verdict / 可比性,且 force 也无 evidence 可锚定 → 提前收,终态拦截。
    blocked.push({ blockKind: 'no_current_evidence' });
    return { ok: false, blocked, drifted };
  }

  // 3. Core 投影已认证完整可比性身份；管理门禁只接受 decision-ready 证据。
  if (evidence.evidenceReadiness !== 'decision-ready') {
    blocked.push({
      blockKind: 'verdict_blocked',
      detail: { verdict: 'CORE_EVIDENCE_NOT_DECISION_READY' },
    });
  }
  // 4. verdict ∈ 接受集。
  const accepted = acceptCautious ? new Set([...DEFAULT_ACCEPTED, 'CAUTIOUS']) : DEFAULT_ACCEPTED;
  const verdict = evidence.verdict;
  if (!verdict || !accepted.has(verdict)) {
    blocked.push({ blockKind: 'verdict_blocked', detail: { verdict: verdict ?? 'UNKNOWN' } });
  }

  return { ok: blocked.length === 0, blocked, evidence, drifted };
}

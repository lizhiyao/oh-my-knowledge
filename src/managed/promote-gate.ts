/**
 * promote 证据门禁(纯函数,无 IO)——`omk list` 读侧判据的写侧对应。
 *
 * 把「这份当前版本是否值得 ship」收成一组可拦截原因(spec evidence-gated-management.md §5 mandatory four
 * + §7 default gate)。默认只放行 verdict=PROGRESS(omk default-strict:影响「值得 ship」判定的默认必须严格);
 * CAUTIOUS 需显式 `acceptCautious`;其余 verdict 一律拦。可比性核对(judge prompt 是否还是当前评委)用
 * **注入**的当前 judge hash 集合,故本模块不依赖 grading 层、保持叶子可测。
 *
 * force(越门)不在此处:门禁只产「客观判定」。CLI 拿到结果后决定是否 `--force` 越过——但**无当前证据时
 * 无 evidence 可锚定,force 也越不过**(返回的 evidence 为 undefined,CLI 据此拒绝空证据 promote)。
 */
import type { ManagedArtifactRecord, ManagedEvidenceRef } from '../types/index.js';
import { latestCurrentEvidence } from './list-view.js';

export type PromoteBlockKind =
  | 'drifted'             // 源不可达 / 内容已变,证据对应旧内容
  | 'no_current_evidence' // 当前内容无评测证据(终态,force 也越不过)
  | 'incomparable'        // 证据 judgePromptHash 不属当前评委 → verdict 不可比
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
  /** 当前 omk 的 judge prompt hash 集合(debias on/off 两变体)。CLI 用 getJudgePromptHash 算好注入,
   *  使本模块不依赖 grading 层。空集 / 省略 = 跳过可比性核对(只在无法取 judge hash 时)。 */
  currentJudgeHashes?: ReadonlySet<string>;
}

export interface PromoteGateResult {
  /** 无任何拦截原因 → 门禁通过。 */
  ok: boolean;
  blocked: PromoteBlock[];
  /** 非拦截级提醒(如 judgePromptHash 缺失、无从核对可比性)。 */
  warnings: PromoteBlock[];
  /** 命中判定的当前有效证据;无当前证据时 undefined —— CLI 据此判定「force 也不能空证据 promote」。 */
  evidence?: ManagedEvidenceRef;
  drifted: boolean;
}

// 默认接受集:只 PROGRESS。
const DEFAULT_ACCEPTED: ReadonlySet<string> = new Set(['PROGRESS']);

export function evaluatePromoteGate(input: PromoteGateInput): PromoteGateResult {
  const { record, currentContentHash, acceptCautious, currentJudgeHashes } = input;
  const blocked: PromoteBlock[] = [];
  const warnings: PromoteBlock[] = [];
  const drifted = currentContentHash === undefined || currentContentHash !== record.contentHash;

  // 1. drift:源不可达 / 内容已变 → 当前盘上的源不是被测内容,门禁不过(force 可越,见 CLI)。
  if (drifted) blocked.push({ blockKind: 'drifted' });

  // 2. 当前有效证据(contentHash == record.contentHash;源 drift 不影响——证据绑的是记录基线内容)。
  const evidence = latestCurrentEvidence(record);
  if (!evidence) {
    // 无证据无从谈 verdict / 可比性,且 force 也无 evidence 可锚定 → 提前收,终态拦截。
    blocked.push({ blockKind: 'no_current_evidence' });
    return { ok: false, blocked, warnings, drifted };
  }

  // 3. 可比性:judgePromptHash 在场且不属当前任一评委模板 → 评委已变、旧 verdict 不可比 → 拦。
  //    缺失 → 无从核对(旧报告 / 无 judge 评测)→ warn 不拦。cliVersion 仅展示、不硬卡(否则每次发版即全失效)。
  const judgeHash = evidence.comparability?.judgePromptHash;
  if (evidence.evidenceSource === 'evaluation-core'
      && evidence.evidenceReadiness !== 'decision-ready') {
    blocked.push({
      blockKind: 'verdict_blocked',
      detail: { verdict: 'CORE_EVIDENCE_NOT_DECISION_READY' },
    });
  }
  if (judgeHash !== undefined && currentJudgeHashes && currentJudgeHashes.size > 0) {
    if (!currentJudgeHashes.has(judgeHash)) {
      blocked.push({ blockKind: 'incomparable', detail: { judgePromptHash: judgeHash } });
    }
  } else if (judgeHash === undefined && evidence.evidenceSource !== 'evaluation-core') {
    warnings.push({ blockKind: 'incomparable' });
  }

  // 4. verdict ∈ 接受集。
  const accepted = acceptCautious ? new Set([...DEFAULT_ACCEPTED, 'CAUTIOUS']) : DEFAULT_ACCEPTED;
  const verdict = evidence.verdict;
  if (!verdict || !accepted.has(verdict)) {
    blocked.push({ blockKind: 'verdict_blocked', detail: { verdict: verdict ?? 'UNKNOWN' } });
  }

  return { ok: blocked.length === 0, blocked, warnings, evidence, drifted };
}

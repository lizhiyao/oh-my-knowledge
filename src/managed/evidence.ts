/**
 * eval → managed evidence 写入(承接 #203 管理支柱 / #214 验收第 3 条)。
 *
 * 一次 `omk eval` 跑完,把结果落成一条 `ManagedEvidenceRef` 追加进**已纳管**记录的 evidence[],
 * 让 skill 从 `installed` 走到 `measurable`(由 `deriveManagedState` 读时推导)。承重前提是 #214/#218
 * 已把 install 与 eval 的内容指纹统一到同一空间(整树哈),所以 `report.artifactHashes[variant]` 与
 * `record.contentHash` 可直接相等比对、evidence 绑得上。
 *
 * 三条设计取舍(对应 issue #221 的"待定决策"):
 *   - **触发**:eval 完成**自动**写,但只写**已存在**的受管记录 —— install 是显式 opt-in,未纳管的
 *     skill 永不被凭空建记录(零副作用惊吓)。CLI 另给 `--no-evidence` 关闭。
 *   - **多对一**:append-only + 按 (reportId, contentHash) 去重;保留全部历史条目,当前有效性仍由
 *     `deriveManagedState` 按 contentHash 匹配裁定(重装新内容后旧证据留存供回滚,却不让新内容显得已测)。
 *   - **跨源**:匹配只看 `record.name ∈ report.variants` + 统一的 artifactHash,本地 / 本地 git /
 *     远端 git 一视同仁,无特判 —— 远端记录的整树哈与 report 同空间(#218/#219)即可绑。
 *
 * bundle 按 evidence-gated-management.md §5 denormalize 进记录(reportId / contentHash /
 * verdict / sampleCoverage / comparability),不依赖 report 文件仍在盘。
 */
import type { EvaluationReport, ManagedEvidenceRef } from '../types/index.js';
import { hashString } from '../eval-core/evaluation-reporting.js';
import { loadAllManagedRecords, appendManagedEvidence, managedDir, resolveManagedDir } from './store.js';

/** baseline / 无 skill 变体的 artifactHash 哨兵(见 report.ts artifactHashes 注释)——不产证据。 */
const NO_SKILL = 'no-skill';

/** 样本集覆盖摘要:report 的 sampleHashes 排序后取一个稳定 digest(同一样本集 ⇒ 同 hash)。
 *  缺 sampleHashes(旧报告 / --dry-run)→ undefined,bundle 仍含其余三项 mandatory。 */
function sampleCoverage(report: EvaluationReport): { count: number; hash: string } | undefined {
  const sh = report.meta?.sampleHashes;
  if (!sh) return undefined;
  const entries = Object.entries(sh).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { count: entries.length, hash: hashString(JSON.stringify(entries)) };
}

/**
 * 为某个变体组装一条 evidence ref;变体无真实内容(baseline / no-skill / 缺 hash)→ null。
 * `verdict` 由调用方传入(CLI 已 computeVerdict,避免在此重算)。
 */
export function buildEvidenceRef(
  report: EvaluationReport,
  variant: string,
  verdict: string,
  recordedAt: string,
): ManagedEvidenceRef | null {
  const contentHash = report.meta?.artifactHashes?.[variant];
  if (!contentHash || contentHash === NO_SKILL) return null;
  const meta = report.meta;
  const cov = sampleCoverage(report);
  return {
    reportId: report.id,
    contentHash,
    recordedAt,
    verdict,
    ...(cov ? { sampleCoverage: cov } : {}),
    comparability: {
      cliVersion: meta.cliVersion,
      ...(meta.judgePromptHash ? { judgePromptHash: meta.judgePromptHash } : {}),
      ...(meta.debiasMode ? { debiasMode: meta.debiasMode } : {}),
    },
  };
}

export interface RecordedEvidence {
  recordId: string;
  name: string;
  contentHash: string;
  /** true ⇒ evidence.contentHash 等于记录当前 contentHash → deriveManagedState 计为当前证据 →
   *  measurable。false ⇒ 测的是旧内容(已 drift),证据留存但不绑当前版本。 */
  bound: boolean;
}

/**
 * 驱动:对每个 `name ∈ report.variants` 且带真实 artifactHash 的**已纳管**记录,追加一条 evidence。
 * 返回实际写入的清单(供 CLI 提示)。无任何记录匹配 → 返回空(常见的非管理用户场景,静默无副作用)。
 */
export function recordEvalEvidence(
  report: EvaluationReport,
  verdict: string,
  recordedAt: string,
  opts: { dir?: string } = {},
): RecordedEvidence[] {
  const out: RecordedEvidence[] = [];
  const variants = report.meta?.variants ?? [];
  if (variants.length === 0) return out;
  // 写回读方实际取记录的同一目录(project→global 同口径)。
  const dir = resolveManagedDir(opts.dir ?? managedDir());
  const records = loadAllManagedRecords(dir);
  if (records.length === 0) return out;
  for (const rec of records) {
    if (!variants.includes(rec.name)) continue;
    const ref = buildEvidenceRef(report, rec.name, verdict, recordedAt);
    if (!ref) continue;
    const merged = appendManagedEvidence(dir, rec.id, ref);
    if (!merged) continue;
    out.push({ recordId: rec.id, name: rec.name, contentHash: ref.contentHash, bound: ref.contentHash === merged.contentHash });
  }
  return out;
}

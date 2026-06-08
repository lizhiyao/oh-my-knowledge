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
 *   - **跨源**:连接键是 **contentHash**(#214 已把指纹统一进同一空间),不是 variant 名 —— 因为
 *     install 与 eval 对来源的命名并不一致:install 受管记录名是 skill 短名(如 `review`),而 eval
 *     报告里 variant key 可能是整串表达式(`git:HEAD:skills/review`)、eval.yaml 自定义别名
 *     (`candidate` / `v2`)、甚至 blind 模式的 `A`/`B`(`applyBlindMode` 盲化 variants 但**不**动
 *     artifactHashes 的键面)。按名字匹配会让这些已被 #218/#219 打通指纹的来源静默写不进证据。改为
 *     在 `artifactHashes` 里找哈值等于 `record.contentHash` 的那个 variant key,本地 / 本地 git /
 *     远端 git / blind 一视同仁、无特判。
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
 * 给某条受管记录在报告里找该绑定的 variant key。主键 = **contentHash**(跨源 / blind 都靠它);
 * 找不到则回退到**同名**且带真实(已 drift)哈的 variant —— 记 unbound 证据供版本史(主要服务本地
 * `--treatment <name>` 名一致的场景;git / 远端的 drift 因键名是表达式 / 别名,name 回退多半不命中,
 * 留待将来用 variantConfigs 的 locator/source 消歧,bound 主路径不受影响)。
 */
function matchVariantKey(report: EvaluationReport, record: { name: string; contentHash: string }): string | undefined {
  const hashes = report.meta?.artifactHashes ?? {};
  // 主连接键:哈值等于记录当前 contentHash 的 variant(指纹同空间即绑定,不看键名长什么样)。
  for (const [key, hash] of Object.entries(hashes)) {
    if (hash !== NO_SKILL && hash === record.contentHash) return key;
  }
  // 回退:同名 variant 的真实内容(已 drift,哈不等)。
  const byName = hashes[record.name];
  if (byName && byName !== NO_SKILL) return record.name;
  return undefined;
}

/**
 * 驱动:对每个能在报告里(按 contentHash 主键 / 同名回退)匹配到被测 variant 的**已纳管**记录,
 * 追加一条 evidence。返回实际写入的清单(供 CLI 提示,`name` 取受管记录名而非 variant 键)。
 * 无任何记录匹配 → 返回空(常见的非管理用户场景,静默无副作用)。
 */
export function recordEvalEvidence(
  report: EvaluationReport,
  verdict: string,
  recordedAt: string,
  opts: { dir?: string } = {},
): RecordedEvidence[] {
  const out: RecordedEvidence[] = [];
  if (Object.keys(report.meta?.artifactHashes ?? {}).length === 0) return out;
  // 写回读方实际取记录的同一目录(project→global 同口径)。
  const dir = resolveManagedDir(opts.dir ?? managedDir());
  const records = loadAllManagedRecords(dir);
  if (records.length === 0) return out;
  for (const rec of records) {
    const variantKey = matchVariantKey(report, rec);
    if (!variantKey) continue;
    const ref = buildEvidenceRef(report, variantKey, verdict, recordedAt);
    if (!ref) continue;
    const merged = appendManagedEvidence(dir, rec.id, ref);
    if (!merged) continue;
    out.push({ recordId: rec.id, name: rec.name, contentHash: ref.contentHash, bound: ref.contentHash === merged.contentHash });
  }
  return out;
}

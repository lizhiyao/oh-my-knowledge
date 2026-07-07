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
 *   - **跨源**:用三级身份消歧把被测 variant 对到受管记录(install 与 eval 命名不一致:记录名是
 *     skill 短名 `review`,而 eval 报告 variant key 可能是整串表达式 `git:HEAD:skills/review`、
 *     eval.yaml 别名 `candidate`)。三级都按 `artifactHashes` / `variantConfigs` 的真实键工作:
 *       (a) 显式**同名** variant —— 最强身份(本地 `--treatment <name>` 与 drift);
 *       (b) **结构化源匹配** —— `variantConfigs[].locator(+ref)` 与 `record.source` 对齐(git / 远端 /
 *           别名),即便内容撞哈也能精确消歧;
 *       (c) **纯 contentHash 回退** —— 仅当该内容哈在受管记录中**唯一**才用。否则两条不同记录恰好当前
 *           内容相同(同模板复制 / 刚装)时,只测了一条的 report 会把同哈的另一条也推成 measurable ——
 *           唯一性闸门挡掉这种越权写入(撞哈又非同名 / 无结构化身份 → 跳过,不乱绑)。
 *
 * bundle 按 evidence-gated-management.md §5 denormalize 进记录(reportId / contentHash /
 * verdict / sampleCoverage / comparability),不依赖 report 文件仍在盘。
 */
import { basename, dirname } from 'node:path';
import type { EvaluationReport, ManagedArtifactSource, ManagedEvidenceRef, VariantConfig } from '../types/index.js';
import { hashString } from '../eval-core/evaluation-reporting.js';
import { loadAllManagedRecords, appendManagedEvidence, managedDir, resolveManagedDir, isShaLike } from './store.js';

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
 * 该版的 git 还原坐标(#234/#236):被测 variant 物化时 `<ref>` 解析出的实际 commit(resolveArtifacts 在
 * 物化本地 git variant 时算好,经 `variantConfigs[].resolvedCommit` 透传)。**不是**进程 cwd 的 HEAD ——
 * variant 内容从 object DB 按它自己的 ref 取,在别的分支 / 用显式旧 SHA 跑时 cwd HEAD 会是错版本。
 * 远端 / file variant 无 resolvedCommit → 不记(诚实留空)。读到的值再过一道 SHA 形态守卫,脏报告不污染证据。
 */
function variantResolvedCommit(report: EvaluationReport, variant: string): string | undefined {
  const cfg = report.meta?.variantConfigs?.find((c) => c.variant === variant);
  return isShaLike(cfg?.resolvedCommit) ? cfg!.resolvedCommit : undefined;
}

/**
 * 为某个变体组装一条 evidence ref;变体无真实内容(baseline / no-skill / 缺 hash)→ null。
 * `verdict` 由调用方传入(CLI 已 computeVerdict,避免在此重算)。git 还原坐标从该 variant 的
 * `resolvedCommit` 取(见 variantResolvedCommit),无则不记。
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
  const gitCommit = variantResolvedCommit(report, variant);
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
    ...(gitCommit ? { gitCommit } : {}),
  };
}

export interface RecordedEvidence {
  recordId: string;
  name: string;
  variant: string;
  contentHash: string;
  /** true ⇒ evidence.contentHash 等于记录当前 contentHash → deriveManagedState 计为当前证据 →
   *  measurable。false ⇒ 测的是旧内容(已 drift),证据留存但不绑当前版本。 */
  bound: boolean;
}

/**
 * variantConfig 的源身份是否与受管记录 source 对得上 —— install 与 eval 两侧 locator **口径不同**,
 * 必须先归一化再比,不能裸字符串相等(否则同 hash 多记录场景下正确的本地 git / 目录-skill 也会因
 * locator 不等而漏写):
 *   - 直接相等:远端 git(两侧都 `git+<url>@<sha>:<spec>`)、本地 file-skill(两侧都是 .md 路径);
 *   - 本地 git:install 记完整身份串 `git:<ref>:<spec>`,eval 把 spec 落 `cfg.locator`、ref 另存 `cfg.ref`
 *     → 归一化成 `git:<cfg.ref>:<cfg.locator>` 再比;
 *   - 本地目录-skill:install 记目录根,eval 记 `<dir>/SKILL.md` → 比 `dirname(cfg.locator)`。
 */
function sourceMatches(cfg: VariantConfig, source: ManagedArtifactSource): boolean {
  if (!cfg.locator) return false;
  if (cfg.locator === source.locator) return true;
  if (source.sourceKind === 'git' && cfg.ref && `git:${cfg.ref}:${cfg.locator}` === source.locator) return true;
  if (source.isDirectorySkill && basename(cfg.locator) === 'SKILL.md' && dirname(cfg.locator) === source.locator) return true;
  return false;
}

/**
 * 给某条受管记录在报告里找该绑定的 variant key,三级身份消歧(见文件头「跨源」)。
 * `hashIsUnique` 由调用方按全体受管记录的 contentHash 计数提供 —— 纯 hash 回退的越权闸门。
 */
function matchVariantKey(
  report: EvaluationReport,
  record: { name: string; contentHash: string; source: ManagedArtifactSource },
  hashIsUnique: (hash: string) => boolean,
): string | undefined {
  const hashes = report.meta?.artifactHashes ?? {};
  // (a) 显式同名 variant(本地 --treatment <name> / drift)。
  if (hashes[record.name] && hashes[record.name] !== NO_SKILL) return record.name;
  // (b) 结构化源匹配:variantConfig.locator(+ref) 对齐记录 source(git / 远端 / 别名)。
  for (const cfg of report.meta?.variantConfigs ?? []) {
    const h = hashes[cfg.variant];
    if (!h || h === NO_SKILL) continue;
    if (sourceMatches(cfg, record.source)) return cfg.variant;
  }
  // (c) 纯 contentHash 回退 —— 仅当该哈在受管记录中唯一(否则撞哈会越权写到没测的记录)。
  if (hashIsUnique(record.contentHash)) {
    for (const [key, hash] of Object.entries(hashes)) {
      if (hash !== NO_SKILL && hash === record.contentHash) return key;
    }
  }
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
  // 全体记录的 contentHash 计数 —— 纯 hash 回退只在唯一时放行(挡同内容多记录的越权写)。
  const hashCount = new Map<string, number>();
  for (const r of records) hashCount.set(r.contentHash, (hashCount.get(r.contentHash) ?? 0) + 1);
  const hashIsUnique = (hash: string): boolean => (hashCount.get(hash) ?? 0) === 1;
  for (const rec of records) {
    const variantKey = matchVariantKey(report, rec, hashIsUnique);
    if (!variantKey) continue;
    const ref = buildEvidenceRef(report, variantKey, verdict, recordedAt);
    if (!ref) continue;
    const merged = appendManagedEvidence(dir, rec.id, ref);
    if (!merged) continue;
    out.push({ recordId: rec.id, name: rec.name, variant: variantKey, contentHash: ref.contentHash, bound: ref.contentHash === merged.contentHash });
  }
  return out;
}

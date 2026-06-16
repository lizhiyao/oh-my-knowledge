import { resolve } from 'node:path';
import { createOverlayReportStore } from '../../server/report-store.js';
import { projectReportsDir, globalReportsDir } from '../../eval-core/measurement-dirs.js';
import { computeVerdict } from '../../eval-core/verdict.js';
import { bootstrapPairedDiffCI, DEFAULT_BOOTSTRAP_ALPHA, DEFAULT_BOOTSTRAP_SAMPLES } from '../../eval-core/bootstrap.js';
import {
  resolveManagedDir,
  managedDir,
  loadAllManagedRecords,
  appendManagedEvidence,
  rebaselineManagedContentHash,
  buildEvidenceRef,
  probeSourceState,
} from '../../managed/index.js';
import type { EvaluationReport, ManagedArtifactRecord, ManagedEvidenceRef } from '../../types/index.js';

export interface EvolveOutcomeInput {
  /** 合并 evolve 报告 id（evolveSkill 返回的 reportId）。 */
  reportId?: string;
  /** 胜出轮（0 = 无改进，不记）。 */
  bestRound: number;
  /** resolveSkillInput 给的 skillPath（文件-skill 为 .md、目录-skill 为内部 SKILL.md）。 */
  skillPath: string;
  /** resolveSkillInput 给的 skillDir。 */
  skillDir: string;
  /** evolve 目标本身的形态（目录-skill / 文件-skill），由原始入参 statSync 判定。用于按形态精确匹配受管记录。 */
  isDirectorySkill: boolean;
  /** 报告加载器覆盖（测试用）；默认走 overlay 报告存储（项目 .omk/reports → 全局兜底）按 id 读。 */
  loadReport?: (id: string) => Promise<EvaluationReport | null>;
  /** 受管目录覆盖（测试用）。 */
  dir?: string;
}

export interface EvolveOutcomeResult {
  name: string;
  contentHash: string;
  verdict: string;
}

/**
 * round-bestRound vs round-0 的忠实 verdict：复刻 eval 管线（evaluation-reporting.ts）对两变体抽
 * per-sample composite → bootstrapDiffCI → computeVerdict，与 `omk eval --bootstrap` 同口径、同 α / 重采样数。
 * 不自造门限：评委是否显著、是否 PROGRESS 全交给既有 computeVerdict。
 */
function winnerVerdict(report: EvaluationReport, winnerVariant: string): string {
  const baseline = 'round-0';
  // 按 sample **配对**(与 evaluation-reporting 主 A/B 同口径 —— 本函数职责就是复刻 eval 管线):baseline 与
  // winner 在同一 sample 上都可测(composite > 0)才入对。同一 sample 两版分数正相关,配对 bootstrap 收紧 diff
  // CI;独立重采样会高估方差、保守失功效。diff = b − a = winner − baseline。
  const compositeOf = (v: string, r: typeof report.results[number]): number | undefined => {
    const e = r.variants[v];
    return e && typeof e.compositeScore === 'number' && e.compositeScore > 0 ? e.compositeScore : undefined;
  };
  const pairs: Array<{ a: number; b: number }> = [];
  for (const r of report.results) {
    const a = compositeOf(baseline, r);
    const b = compositeOf(winnerVariant, r);
    if (a !== undefined && b !== undefined) pairs.push({ a, b });
  }
  const pairComparisons = pairs.length >= 2
    ? [{
      control: baseline,
      treatment: winnerVariant,
      diffBootstrapCI: bootstrapPairedDiffCI(pairs, DEFAULT_BOOTSTRAP_ALPHA, DEFAULT_BOOTSTRAP_SAMPLES),
    }]
    : undefined;
  const slice: EvaluationReport = {
    ...report,
    meta: {
      ...report.meta,
      variants: [baseline, winnerVariant],
      ...(pairComparisons ? { pairComparisons } : {}),
    },
    summary: {
      [baseline]: report.summary[baseline],
      [winnerVariant]: report.summary[winnerVariant],
    },
  };
  return computeVerdict(slice).level;
}

/**
 * 受管目录里按源路径定位被 evolve 的那条记录。**形态感知**,且对目录-skill 的两种 install 落盘形态都认:
 *   - 目录-skill(`isDirectorySkill=true`):install 既可能落「目录形态」(`source.isDirectorySkill=true`、
 *     locator=skill 根目录 = skillDir),也可能因用户 `install <dir>/SKILL.md` 落「文件形态」
 *     (`isDirectorySkill=false`、locator=该 SKILL.md = skillPath)。两者都对应同一个 skill,故都匹配。
 *   - 扁平文件-skill(`isDirectorySkill=false`):只认「文件形态 + locator=该 .md 本身(skillPath)」。
 *
 * 绝不拿父目录 skillDir 去撞目录-skill 记录:对散文件 skill(`skills/foo.md`)跑 evolve 时,skillDir = `skills/`,
 * 若并集匹配会误命中一条 locator 恰为 `skills/` 的目录-skill 记录,把证据 / re-baseline 写到根本没被 evolve 的
 * 记录上。这里每条匹配目标(skillDir / skillPath)都唯一指向被 evolve 的 skill 自身,无此越权。
 */
function findRecordBySource(
  records: ManagedArtifactRecord[],
  skillPath: string,
  skillDir: string,
  isDirectorySkill: boolean,
): ManagedArtifactRecord | undefined {
  const fileTarget = resolve(skillPath);
  const dirTarget = resolve(skillDir);
  return records.find((r) => {
    if (r.source.sourceKind !== 'file') return false;
    const loc = resolve(r.source.locator);
    if (isDirectorySkill) {
      return (r.source.isDirectorySkill && loc === dirTarget) // 目录形态记录:locator = skill 根目录
        || (!r.source.isDirectorySkill && loc === fileTarget); // 文件形态记录(install <dir>/SKILL.md):locator = 该 SKILL.md
    }
    return !r.source.isDirectorySkill && loc === fileTarget; // 扁平文件-skill:只认该 .md 本身,绝不撞父目录
  });
}

async function loadEvolveReport(id: string): Promise<EvaluationReport | null> {
  // overlay get：项目 .omk/reports → 全局兜底，evolve 写到全局的合并报告仍命中，eval 新写项目的也能取到。
  const doc = await createOverlayReportStore(projectReportsDir(), globalReportsDir()).get(id);
  return doc && doc.kind === 'evaluation' ? (doc as EvaluationReport) : null;
}

/**
 * evolve 把胜出版本写回 source 后，为受管 skill 记一条带 verdict 的证据，并把记录 re-baseline 到新版本，
 * 让 `omk list` 显 measurable（而非永久 stale）。**不写 promote 决定** —— 升 promoted 仍由人 `omk promote`（A 方案：
 * 统计门 ≠ 人的生产接受）。未纳管 / 无改进 / 源不可达 / 报告缺失 → no-op 返回 null。
 *
 * 证据 contentHash 统一锚到 re-baseline 后的源哈（probeSourceState 与 install / list 同口径），规避「文件-skill 哈
 * vs 目录-skill 整树哈」可能与报告内 artifactHash 不在同空间的边角，保证证据判为「当前」。
 */
export async function recordEvolveOutcome(input: EvolveOutcomeInput): Promise<EvolveOutcomeResult | null> {
  if (input.bestRound <= 0 || !input.reportId) return null;
  const dir = input.dir ?? resolveManagedDir(managedDir());
  const record = findRecordBySource(loadAllManagedRecords(dir), input.skillPath, input.skillDir, input.isDirectorySkill);
  if (!record) return null; // 未纳管 → no-op（管理是 install 显式 opt-in）
  const probe = probeSourceState(record);
  if (!probe.reachable || probe.hash === undefined) return null; // 源不可达 → 不动
  const newHash = probe.hash;
  const report = input.loadReport ? await input.loadReport(input.reportId) : await loadEvolveReport(input.reportId);
  if (!report || report.kind !== 'evaluation') return null;
  const winnerVariant = `round-${input.bestRound}`;
  // 防御:正常 evolve 产物必含基线 round-0 与胜出轮的 summary(同一次 run 产出 bestRound 与合并报告),此守卫只挡
  // 报告损坏 / 被截断的边角 —— 缺任一则无可信 verdict 可算,直接 no-op,避免 winnerVerdict→computeVerdict 读 undefined。
  if (!report.summary?.['round-0'] || !report.summary?.[winnerVariant]) return null;
  const ref = buildEvidenceRef(report, winnerVariant, winnerVerdict(report, winnerVariant), new Date().toISOString());
  if (!ref) return null;
  const evidence: ManagedEvidenceRef = { ...ref, contentHash: newHash };
  // 用 store 写函数的返回值判定:记录在 find 与写之间被删/改(TOCTOU)→ 两次写 no-op 返回 null → 不回报成功,
  // 避免 CLI 打印「已记证据」而盘上其实没写。name/contentHash 取自 append 后的 merged 记录,不用旧 in-memory。
  if (!rebaselineManagedContentHash(dir, record.id, newHash)) return null;
  const merged = appendManagedEvidence(dir, record.id, evidence);
  if (!merged) return null;
  return { name: merged.name, contentHash: merged.contentHash, verdict: evidence.verdict ?? 'UNKNOWN' };
}

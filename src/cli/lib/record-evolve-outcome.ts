import { resolve } from 'node:path';
import { createFileStore } from '../../server/report-store.js';
import { DEFAULT_OUTPUT_DIR } from '../../eval-core/evaluation-reporting.js';
import { computeVerdict } from '../../eval-core/verdict.js';
import { bootstrapDiffCI, DEFAULT_BOOTSTRAP_ALPHA, DEFAULT_BOOTSTRAP_SAMPLES } from '../../eval-core/bootstrap.js';
import {
  resolveManagedDir,
  managedDir,
  loadAllManagedRecords,
  appendManagedEvidence,
  rebaselineManagedContentHash,
  buildEvidenceRef,
} from '../../managed/index.js';
import { probeSourceState } from './source-probe.js';
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
  /** 报告加载器覆盖（测试用）；默认从 DEFAULT_OUTPUT_DIR 的文件存储按 id 读。 */
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
  const scoresOf = (v: string): number[] => report.results
    .map((r) => r.variants[v])
    .filter((e): e is NonNullable<typeof e> => !!e && typeof e.compositeScore === 'number' && e.compositeScore > 0)
    .map((e) => e.compositeScore as number);
  const ctrl = scoresOf(baseline);
  const treat = scoresOf(winnerVariant);
  const pairComparisons = ctrl.length >= 2 && treat.length >= 2
    ? [{
      control: baseline,
      treatment: winnerVariant,
      diffBootstrapCI: bootstrapDiffCI(ctrl, treat, DEFAULT_BOOTSTRAP_ALPHA, DEFAULT_BOOTSTRAP_SAMPLES),
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
 * 受管目录里按源路径定位被 evolve 的那条记录。**形态感知**:按 evolve 目标自身的形态选唯一比较目标
 * （目录-skill 比 skillDir、文件-skill 比 skillPath），并要求记录形态一致。
 *
 * 不能用「skillPath ∪ skillDir」并集:对同目录下的散文件 skill 跑 evolve 时,skillDir = 父目录,会误命中
 * 一条 locator 恰为该父目录的「目录-skill」记录,把证据 / re-baseline 写到根本没被 evolve 的记录上（还会用
 * 文件哈 re-baseline 一条整树哈记录,把它永久标 stale）。
 */
function findRecordBySource(
  records: ManagedArtifactRecord[],
  skillPath: string,
  skillDir: string,
  isDirectorySkill: boolean,
): ManagedArtifactRecord | undefined {
  const target = resolve(isDirectorySkill ? skillDir : skillPath);
  return records.find((r) => r.source.sourceKind === 'file'
    && r.source.isDirectorySkill === isDirectorySkill
    && resolve(r.source.locator) === target);
}

async function loadEvolveReport(id: string): Promise<EvaluationReport | null> {
  const doc = await createFileStore(DEFAULT_OUTPUT_DIR).get(id);
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

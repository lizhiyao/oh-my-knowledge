/**
 * Skill-centric 聚合 — 顶级实体从"报告"翻成"skill",每个 skill 在 4 类报告
 * (doctor / eval-评分 / eval-功能 / observe)上各取最新一份做 status 摘要,
 * 给 studio 列表页用。
 *
 * 当前 v1 范围:
 *   - eval 报告(reportsDir):按 treatment variant 名分桶,跳过 baseline 保留字。
 *     评分视角(verdict / 综合分)和功能视角(pass/fail/tripwire 计数)挤一份 snapshot,
 *     因为同一份 EvaluationReport 同时驱动两个 view tab。
 *   - observe 报告(analysesDir, SkillHealthReport):data.bySkill[name] 每个键作为
 *     一个 skill 的 observe snapshot,取最新 generatedAt。
 *   - doctor:读取 `.omk/doctors/*.report.json`,按 skill 名聚合体检历史。
 *
 * 综合 band:eval / observe 任一红 → 红,任一黄 → 黄,全绿 → 绿,皆未跑 → gray。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute, basename, dirname } from 'node:path';
import { GRAPH_FILE_SUFFIX, graphFileName, isReportFileName, reportFileStem } from '../eval-core/artifact-file-names.js';
import { migrateLegacyReportFiles } from '../eval-core/report-file-migration.js';
import { doctorGraphDirForDoctorOutput } from '../artifact-graph/doctor.js';
import { evalGraphDirForReportOutput } from '../artifact-graph/eval.js';
import type {
  ReportDocument,
  EvaluationReport,
  AssertionDetail,
  DoctorReport,
  Diagnosis,
  SkillDoctorSnapshot,
  SkillEvalSnapshot,
  SkillObserveSnapshot,
  SkillGraphSnapshot,
  SkillGraphNodePreview,
  SkillIndexEntry,
  SkillIndexSummary,
  SkillIndex,
  Insight,
  ArtifactGraphDocument,
  ArtifactGraphNode,
} from '../types/index.js';
import type { SkillHealthReport } from '../observability/skill-health-analyzer.js';
import { confidenceOf } from '../observability/skill-health-analyzer.js';
import { computeVerdict } from '../eval-core/verdict.js';
import { artifactIndexDir, listLiveDoctorCards, cardToDoctorSnapshot, listLiveObserveCards, listLiveReportCards, cardTargetSentinel } from '../eval-core/artifact-index.js';
import { detectInsights } from './skill-insights.js';
import { DEFAULT_OBSERVATIONS_DIR, loadLatestObservationInboxReports } from '../observability/inbox.js';
import { buildStudioDiagnosisSummary, mergeDiagnosisBundles } from '../diagnosis/studio-projection.js';

// Re-export DTO 类型,保持既有 import 路径 backward-compat。新代码请直接从 ../types/index.js 导入。
export type {
  SkillDoctorSnapshot,
  SkillEvalSnapshot,
  SkillObserveSnapshot,
  SkillIndexEntry,
  SkillIndexSummary,
  SkillIndex,
};

// ── 模块级缓存:Studio 每次请求都跑 buildSkillIndex,扫盘成本随 skill 数线性,
// 数据量大后列表 / 详情页响应变慢(PR #95 review P2-4 — cache 引入本身那一条)。
//
// 缓存策略:对 reports id+timestamp 拼接 + `doctorsDir` 跟 `analysesDir` 各自
// 下"每个 .report.json 文件的 name:mtimeMs:size 三元组按 filename 排序拼接"的
// **content-aware** fingerprint key。三类变化都会让 fingerprint 字符串变让
// cache 失效:
//
//   (1) reports 数组改变(新 run id 进列表 / 现有 entry 的 meta.timestamp 变)
//   (2) doctorsDir / analysesDir 里 .report.json 文件**增删改名**(dir 本身 mtime
//       随 dirent 变化变,且排序后的 filename 序列变,fingerprint 字符串里那
//       两段都变)
//   (3) doctorsDir / analysesDir 里**同名 .report.json 文件被原地覆写内容**(Unix
//       目录 mtime 不变因为 dirent 表项没动,但被覆写的那个 file 自己的
//       mtimeMs 跟 byte size 都会变 — fingerprint 字符串里那一行
//       `<filename>:<mtimeMs>:<size>` 的后缀变,整体字符串变,cache miss
//       触发重新 build)
//
// (3) 是 PR #95 reviewer lizhiyao 2026-05-11 顶部 issue-comment 的 🟡 P2 第
// 一条 ship-blocker(P2-a) — pre-fix 时 fingerprint 只看 dir 本身的 mtime
// 跟 .report.json 文件数两个量,前面 (1) (2) 信号能命中,但 (3) 这种"外部 process
// 把同一个 analysis JSON 从 toolFailureRate=0 覆写成 0.9 这种 in-place 内容
// 更新"既不动目录 dirent 也不改文件名所以两个量都不变,fingerprint 命中老
// key,server 进程内 `_indexCache` 复用旧引用,Studio 端拿到的 SkillIndex
// 是 cache 那份 stale 的 failureRate=0。reviewer 本地复现过这一步。
//
// reviewer 给的 fix 是"仿 src/server/report-store.ts:80-90 那一侧已有的 per-
// file mtime+size hash pattern(那一段是 ReportStore.list 的 cache 失效信号
// computeListFingerprint 用的格式),fingerprint key 含 doctorsDir /
// analysesDir 下每个 JSON 文件的 mtimeMs+size"。本仓两侧 report store 索引
// 现在 fingerprint 失效信号统一为同一种 content-aware hash 字符串格式,
// `<dir-mtimeMs>|<file1>:<mtimeMs1>:<size1>,<file2>:<mtimeMs2>:<size2>,...`,
// report-store 那一侧是 async fs/promises 跑的,skill-index 这一侧是 sync
// (buildSkillIndex 是 sync caller),除了 fs API 同步异步差别字符串 schema
// 一致。
interface SkillIndexCache {
  fingerprint: string;
  result: SkillIndex;
}
let _indexCache: SkillIndexCache | null = null;

/**
 * Sync 版 dir-content fingerprint helper,仿 `src/server/report-store.ts:80-92`
 * 的 async `computeListFingerprint` — 把目录本身的 mtime 跟目录下每个 `.report.json`
 * 文件的 "filename:mtimeMs:size" 三元组排序拼接成 stable 字符串作为 dir-level
 * 的 content-aware fingerprint。
 *
 * - 目录下任何 .report.json 文件**新增 / 删除 / 重命名** → 目录 mtime 跟着变,且
 *   sorted-filenames 列表变,字符串变 → cache invalidate。
 * - 任何**已有同名 .report.json 文件被外部进程原地覆写内容** → 该文件自己的 mtimeMs
 *   跟通常情况下 size 都变(byte 长度跟内容相关),字符串里那一 entry 的后缀
 *   变,整体字符串变 → cache invalidate。这是 pre-fix 的 fingerprint(只看
 *   dir mtime+文件数)漏掉的信号(reviewer 2026-05-11 P2-a)。
 * - 单个文件 stat fail(临时权限错或 race condition 删除)用 `<filename>:?`
 *   占位字面,跟 report-store.ts 那一侧的 sentinel 字面对齐。整个 dir-stat
 *   fail(目录不存在 / 权限错)返回固定 sentinel "missing",这样"目录持续不存
 *   在"的多次连续调用 fingerprint 字符串稳定一致 cache 复用合理(行为跟旧
 *   helper 在两个 try 的 catch 分支都返 0 拼接出"0-0"的稳定 sentinel 等价)。
 */
function safeDirJsonContentFingerprint(dir: string): string {
  // 加入 dir 路径本身,确保不同路径即使 mtime/file-list 相同也会产生不同 fingerprint
  let dirMtimeMs: number;
  let jsonFiles: string[];
  try {
    dirMtimeMs = statSync(dir).mtimeMs;
    jsonFiles = readdirSync(dir).filter(isReportFileName).sort();
  } catch {
    return `missing:${dir}`;
  }
  const fileParts = jsonFiles.map((f) => {
    try {
      const fStat = statSync(join(dir, f));
      return `${f}:${fStat.mtimeMs}:${fStat.size}`;
    } catch {
      return `${f}:?`;
    }
  });
  return `${dir}|${dirMtimeMs}|${fileParts.join(',')}`;
}

function safeDirGraphContentFingerprint(dir: string): string {
  let dirMtimeMs: number;
  let graphFiles: string[];
  try {
    dirMtimeMs = statSync(dir).mtimeMs;
    graphFiles = readdirSync(dir).filter((f) => f.endsWith(GRAPH_FILE_SUFFIX)).sort();
  } catch {
    return `missing:${dir}`;
  }
  const fileParts = graphFiles.map((f) => {
    try {
      const fStat = statSync(join(dir, f));
      return `${f}:${fStat.mtimeMs}:${fStat.size}`;
    } catch {
      return `${f}:?`;
    }
  });
  return `${dir}|${dirMtimeMs}|${fileParts.join(',')}`;
}

function fileFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:missing`;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function graphSidecarPathForReportPath(reportPath: string, reportId: string): string {
  return join(evalGraphDirForReportOutput(dirname(reportPath)), graphFileName(reportId));
}

function graphSidecarPathForDoctorCard(cardPath: string, cardId: string): string {
  return join(doctorGraphDirForDoctorOutput(dirname(cardPath)), graphFileName(cardId));
}

function buildGraphFingerprint(
  evalGraphDirs: string[],
  doctorGraphDirs: string[],
  includeReportCards: boolean,
  includeDoctorCards: boolean,
): string {
  const dirPart = [
    ...uniqueStrings(evalGraphDirs).map((dir) => `eg:${safeDirGraphContentFingerprint(dir)}`),
    ...uniqueStrings(doctorGraphDirs).map((dir) => `dg:${safeDirGraphContentFingerprint(dir)}`),
  ].join('|');
  const reportCardPart = includeReportCards
    ? listLiveReportCards().map((card) => fileFingerprint(graphSidecarPathForReportPath(card.path, card.id))).sort().join('|')
    : '';
  const doctorCardPart = includeDoctorCards
    ? listLiveDoctorCards().map((card) => fileFingerprint(graphSidecarPathForDoctorCard(card.path, card.id))).sort().join('|')
    : '';
  return `${dirPart}|erc:${reportCardPart}|drc:${doctorCardPart}`;
}

function buildIndexFingerprint(
  reports: ReportDocument[],
  analysesDir: string,
  doctorsDir: string,
  observationsDir: string,
  includeObserveCards: boolean,
  includeDoctorCards: boolean,
  graphFingerprint: string,
): string {
  // `d:` 跟 `o:` 前缀("d for doctors / o for observability analyses")沿用 pre-fix
  // 字面格式,避免外部 logging / debug 时 grep fingerprint 字符串的格式漂移。
  // 每一段的 right-hand-side 从旧的 "{dir-mtime}-{file-count}" 双标量升级成
  // safeDirJsonContentFingerprint 返回的 "{dir-mtime}|{file1}:{m}:{s},..."
  // content-aware 字符串。
  const reportIds = reports.map((r) => `${r.id}:${r.meta?.timestamp ?? ''}:${r.kind === 'evaluation' ? r.meta.evolve?.skillName ?? '' : ''}`).join(',');
  migrateLegacyReportFiles(doctorsDir, 'doctor');
  migrateLegacyReportFiles(analysesDir, 'observe-health');
  migrateLegacyReportFiles(observationsDir, 'observe-inbox');
  const doctorsFp = safeDirJsonContentFingerprint(doctorsDir);
  const analysesFp = safeDirJsonContentFingerprint(analysesDir);
  const observationsFp = safeDirJsonContentFingerprint(observationsDir);
  // 别项目的 doctor / observe 卡片也进 fingerprint:否则别项目新跑一份后,本项目 studio 因缓存命中看不到更新。
  // 仅在对应域开启卡片合并(机器级模式)时才纳入 —— 固定目录 / --global 模式不合卡片,卡片变化不应触发重算;
  // 且 include 标志本身进 fingerprint,避免同目录在 include on/off 两种模式间命中错误缓存。
  // 卡片目录指纹 + 真身存在性 sentinel 都纳入:后者使「卡片真身被带外删」也能让缓存失效(否则悬空卡片继续展示)。
  const doctorCardsFp = includeDoctorCards ? `${safeDirJsonContentFingerprint(artifactIndexDir('doctor'))}|t:${cardTargetSentinel('doctor')}` : '';
  const observeCardsFp = includeObserveCards ? `${safeDirJsonContentFingerprint(artifactIndexDir('observe-health'))}|t:${cardTargetSentinel('observe-health')}` : '';
  return `${reportIds}|d:${doctorsFp}|o:${analysesFp}|obs:${observationsFp}|dc:${doctorCardsFp}|oc:${observeCardsFp}|g:${graphFingerprint}|inc:${includeObserveCards ? 'o' : ''}${includeDoctorCards ? 'd' : ''}`;
}

/** 测试 / 调试用:强制清掉 in-process skill-index 缓存。 */
export function _resetSkillIndexCache(): void {
  _indexCache = null;
}

function isEvolveRoundVariant(report: EvaluationReport, variant: string): boolean {
  return report.id.startsWith('evolve-') && /^round-\d+$/.test(variant);
}

function skillNameForEvalVariant(report: EvaluationReport, variant: string): string | null {
  if (isEvolveRoundVariant(report, variant)) return report.meta.evolve?.skillName ?? null;
  if (variant === 'baseline') return null;
  if (isAbsolute(variant) || variant.startsWith('~') || variant.includes('/')) {
    const base = basename(variant);
    return /^SKILL\.md$/i.test(base) ? basename(dirname(variant)) : base.replace(/\.md$/i, '');
  }
  return variant;
}

function sampleAllPassed(details: AssertionDetail[] | undefined): boolean {
  if (!details || details.length === 0) return true;
  return details.every((d) => d.passed);
}

function buildEvalSnapshot(report: EvaluationReport, variant: string): SkillEvalSnapshot | null {
  const summary = report.summary?.[variant];
  if (!summary) return null;
  let pass = 0;
  let fail = 0;
  let tripwire = 0;
  for (const r of report.results) {
    const vr = r.variants?.[variant];
    if (!vr) continue;
    const allPassed = sampleAllPassed(vr.assertions?.details);
    const isTripwire = report.sampleSnapshots?.[r.sample_id]?.tripwire === true
      || (vr.diagnostic?.rootCause || []).includes('tripwire_intentional');
    if (allPassed) pass += 1;
    else if (isTripwire) tripwire += 1;
    else fail += 1;
  }

  // verdict 是运行期计算的,不进 report,这里现算。
  // multi-treatment 报告:computeVerdict 顶层 level 是 worst-of perPair,headline 也是
  // worst pair 的描述;我们要的是"当前这个 variant 对应的 pair"。优先从 perPair 找,
  // 找不到再 fallback report-level(单 treatment 时 perPair 也只有一条,等价)。
  let verdictLevel = 'unknown';
  let verdictHeadline = '';
  try {
    const v = computeVerdict(report);
    const myPair = v.perPair?.find((p) => p.treatment === variant);
    if (myPair) {
      verdictLevel = myPair.level;
      verdictHeadline = myPair.headline;
    } else {
      verdictLevel = v.level;
      verdictHeadline = v.headline;
    }
  } catch { /* 单 variant 报告 / control 缺失等情况 — 留 unknown 默认 */ }

  return {
    reportId: report.id,
    timestamp: report.meta.timestamp || '',
    variantName: variant,
    verdictLevel,
    verdictHeadline,
    compositeScore: summary.avgCompositeScore ?? null,
    passCount: pass,
    failCount: fail,
    tripwireCount: tripwire,
    // 别项目以「索引卡片」进 studio 时 results 被剥掉(pass/fail 逐样本断言分布不可得,留 0);但 totalSamples
    // 用 summary 的真实样本数,避免显「0 样本」。卡片的可信信号是 compositeScore + verdict(均来自 summary/meta)。
    // 不把 summary.successCount(执行成功)当 pass(断言通过)回填 —— 两者语义不同,会让列表误读。
    totalSamples: report.results.length === 0 ? (summary.totalSamples ?? 0) : pass + fail + tripwire,
    // 标记卡片来源:渲染端据此不把 pass/fail=0 当真实通过率(否则 failCount===0 会误判绿带「全通过」+「0% pass」同屏自相矛盾)。
    ...(report.results.length === 0 ? { resultsStripped: true } : {}),
  };
}

/**
 * Per-skill 健康色带。**这跟 skill-health-analyzer 的 overall.healthBand 是两个视角**:
 *   - overall.healthBand(skill-health-analyzer.ts:healthBandOf):只看 weightedGapRate,
 *     回答"用户问题是否被知识库覆盖"(对外能力,跨 skill 平均)
 *   - PER_SKILL_BAND(本函数):综合 toolFailureRate + gap,回答"这个 skill 自身跑得稳不稳"
 *     (skill 内视角,失败工具调用 + 缺知识都算)
 * 不要把两边合并 — 语义不同,跨版本可比性也独立维护。
 *
 * 调整阈值会让历史 observe report 的 band 重新分类,UI 颜色变;
 * **不算 BREAKING-COMPARABILITY**(只影响 Studio 列表视觉,不动 grading/judge 输出)。
 */
const PER_SKILL_BAND_RED_FAILURE_RATE = 0.4;       // 工具失败率 ≥ 40% → red
const PER_SKILL_BAND_YELLOW_FAILURE_RATE = 0.2;    // ≥ 20% → yellow
const PER_SKILL_BAND_YELLOW_GAP_RATE = 0.3;        // 加权 gap ≥ 30% → yellow

function bandFromObserveHealth(h: { gap?: { weightedGapRate?: number }; toolFailureRate: number }): 'green' | 'yellow' | 'red' {
  if (h.toolFailureRate >= PER_SKILL_BAND_RED_FAILURE_RATE) return 'red';
  const gap = h.gap?.weightedGapRate ?? 0;
  if (gap >= PER_SKILL_BAND_YELLOW_GAP_RATE || h.toolFailureRate >= PER_SKILL_BAND_YELLOW_FAILURE_RATE) return 'yellow';
  return 'green';
}

function combineBand(
  doctor: SkillDoctorSnapshot | null,
  evalSnap: SkillEvalSnapshot | null,
  _observe: SkillObserveSnapshot | null,
): 'green' | 'yellow' | 'red' | 'gray' {
  if (!doctor && !evalSnap) return 'gray';
  // doctor band: status fail → red, warn → yellow, pass → green
  const doctorBand: 'green' | 'yellow' | 'red' | 'gray' = !doctor
    ? 'gray'
    : doctor.status === 'fail' ? 'red'
    : doctor.status === 'warn' ? 'yellow'
    : 'green';
  // eval band:按综合分估色,跟列表/详情页显示的 4.x/5 分数口径一致。
  const evalScore = evalSnap?.compositeScore ?? null;
  const evalBand: 'green' | 'yellow' | 'red' | 'gray' = !evalSnap || evalScore == null
    ? 'gray'
    : evalScore < 2.5 ? 'red'
    : evalScore < 3.5 ? 'yellow'
    : 'green';
  if (doctorBand === 'red' || evalBand === 'red') return 'red';
  if (doctorBand === 'yellow' || evalBand === 'yellow') return 'yellow';
  if (doctorBand === 'green' || evalBand === 'green') return 'green';
  return 'gray';
}

function latestActivityTs(e: SkillIndexEntry): string {
  const candidates = [e.doctor?.timestamp, e.eval?.timestamp, e.observe?.generatedAt]
    .filter((s): s is string => Boolean(s));
  return candidates.sort().pop() || '';
}

function evalSnapshotSortKey(s: SkillEvalSnapshot): string {
  const m = /^round-(\d+)$/.exec(s.variantName);
  const round = m ? Number(m[1]) : -1;
  return `${s.timestamp}#${String(round).padStart(8, '0')}`;
}

function latestEvalSnapshot(list: SkillEvalSnapshot[]): SkillEvalSnapshot | null {
  if (list.length === 0) return null;
  return list[list.length - 1];
}

interface LoadedArtifactGraph {
  graph: ArtifactGraphDocument;
  path: string;
}

function isArtifactGraphDocument(value: unknown): value is ArtifactGraphDocument {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<ArtifactGraphDocument>;
  return graph.documentKind === 'artifact-graph'
    && graph.schemaVersion === 1
    && typeof graph.graphId === 'string'
    && !!graph.source
    && (graph.source.sourceKind === 'doctor' || graph.source.sourceKind === 'eval' || graph.source.sourceKind === 'observe')
    && Array.isArray(graph.nodes)
    && Array.isArray(graph.edges);
}

function readArtifactGraph(path: string): LoadedArtifactGraph | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isArtifactGraphDocument(parsed)) return null;
    return { graph: parsed, path };
  } catch {
    return null;
  }
}

function scanGraphDir(dir: string): LoadedArtifactGraph[] {
  if (!existsSync(dir)) return [];
  const out: LoadedArtifactGraph[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(GRAPH_FILE_SUFFIX)) continue;
    const loaded = readArtifactGraph(join(dir, file));
    if (loaded) out.push(loaded);
  }
  return out;
}

function loadGraphsForSkillIndex(options: {
  evalGraphDirs: string[];
  doctorGraphDirs: string[];
  includeReportCards: boolean;
  includeDoctorCards: boolean;
}): LoadedArtifactGraph[] {
  const byPath = new Map<string, LoadedArtifactGraph>();
  const add = (loaded: LoadedArtifactGraph | null): void => {
    if (loaded) byPath.set(loaded.path, loaded);
  };
  for (const dir of uniqueStrings(options.evalGraphDirs)) {
    for (const graph of scanGraphDir(dir)) add(graph);
  }
  for (const dir of uniqueStrings(options.doctorGraphDirs)) {
    for (const graph of scanGraphDir(dir)) add(graph);
  }
  if (options.includeReportCards) {
    for (const card of listLiveReportCards()) {
      add(readArtifactGraph(graphSidecarPathForReportPath(card.path, card.id)));
    }
  }
  if (options.includeDoctorCards) {
    for (const card of listLiveDoctorCards()) {
      add(readArtifactGraph(graphSidecarPathForDoctorCard(card.path, card.id)));
    }
  }
  return [...byPath.values()];
}

function graphSkillNodes(graph: ArtifactGraphDocument): ArtifactGraphNode[] {
  return graph.nodes.filter((node) => node.nodeKind === 'skill');
}

function graphSkillNames(graph: ArtifactGraphDocument): string[] {
  return uniqueStrings([
    graph.scope.skillName ?? '',
    ...graphSkillNodes(graph).map((node) => node.label),
  ]);
}

function nodeArtifactHash(node: ArtifactGraphNode | undefined): string | undefined {
  const hash = node?.binding?.keys?.artifactHash;
  return hash && hash !== 'no-skill' ? hash : undefined;
}

function nodeSourceLocator(node: ArtifactGraphNode | undefined): string | undefined {
  const locator = node?.attrs?.display?.sourceLocator;
  return typeof locator === 'string' && locator.trim() ? locator : undefined;
}

function graphSourceLocator(graph: ArtifactGraphDocument, skillNode?: ArtifactGraphNode): string | undefined {
  if (graph.source.sourceKind === 'eval') {
    // Eval graph 的 scope.sourceLocator 是 samplesPath；skill 路径在 skill node 上。
    return nodeSourceLocator(skillNode);
  }
  return graph.scope.sourceLocator ?? nodeSourceLocator(skillNode);
}

function graphNodeMap(graph: ArtifactGraphDocument): Map<string, ArtifactGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function graphHasSkill(graph: ArtifactGraphDocument, entry: SkillIndexEntry): boolean {
  const names = graphSkillNames(graph);
  return names.includes(entry.skillName) || (entry.eval ? names.includes(entry.eval.variantName) : false);
}

function graphMatchesDoctorEntry(graph: ArtifactGraphDocument, entry: SkillIndexEntry): boolean {
  return graphHasSkill(graph, entry);
}

function evalVariantName(entry: SkillIndexEntry): string | null {
  return entry.eval?.variantName ?? null;
}

function evalVariantNode(graph: ArtifactGraphDocument, entry: SkillIndexEntry): ArtifactGraphNode | undefined {
  const variantName = evalVariantName(entry);
  if (!variantName) return undefined;
  return graph.nodes.find((node) => node.nodeKind === 'variant' && node.label === variantName);
}

function evalSkillNodeForVariant(graph: ArtifactGraphDocument, variantNode: ArtifactGraphNode): ArtifactGraphNode | undefined {
  const nodesById = graphNodeMap(graph);
  return graph.edges
    .filter((edge) => edge.fromNodeId === variantNode.id && edge.edgeKind === 'derived_from')
    .map((edge) => nodesById.get(edge.toNodeId))
    .find((node): node is ArtifactGraphNode => node?.nodeKind === 'skill');
}

function graphMatchesEvalEntry(graph: ArtifactGraphDocument, entry: SkillIndexEntry): boolean {
  return evalVariantNode(graph, entry) !== undefined;
}

function pickLatestGraph(graphs: LoadedArtifactGraph[]): LoadedArtifactGraph | null {
  if (graphs.length === 0) return null;
  return [...graphs].sort((a, b) => {
    const at = a.graph.generatedAt || '';
    const bt = b.graph.generatedAt || '';
    if (at !== bt) return at.localeCompare(bt);
    return a.graph.graphId.localeCompare(b.graph.graphId);
  })[graphs.length - 1];
}

function countGraphNodes(graph: ArtifactGraphDocument, nodeKind: ArtifactGraphNode['nodeKind']): number {
  return graph.nodes.filter((node) => node.nodeKind === nodeKind).length;
}

function graphNodePreview(node: ArtifactGraphNode): SkillGraphNodePreview {
  return {
    stableKey: node.stableKey,
    nodeKind: node.nodeKind,
    label: node.label,
    ...(node.status ? { status: node.status } : {}),
  };
}

function graphNodePreviews(
  graph: ArtifactGraphDocument,
  nodeKinds: readonly ArtifactGraphNode['nodeKind'][],
  nodeIds?: Set<string>,
): SkillGraphNodePreview[] {
  const kinds = new Set(nodeKinds);
  return graph.nodes
    .filter((node) => kinds.has(node.nodeKind) && (!nodeIds || nodeIds.has(node.id)))
    .map(graphNodePreview);
}

interface ProjectedGraphStage<T> {
  stage: T;
  artifactHash?: string;
  sourceLocator?: string;
}

function projectDoctorStage(graph: ArtifactGraphDocument, path: string): ProjectedGraphStage<NonNullable<SkillGraphSnapshot['doctor']>> | undefined {
  if (graph.source.sourceKind !== 'doctor') return undefined;
  const skillNode = graphSkillNodes(graph)[0];
  const sourceLocator = graphSourceLocator(graph, skillNode);
  const base = {
    sourceKind: 'doctor' as const,
    sourceId: graph.source.sourceId,
    graphId: graph.graphId,
    generatedAt: graph.generatedAt,
    graphPath: path,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
  return {
    stage: {
      ...base,
      references: countGraphNodes(graph, 'reference'),
      scripts: countGraphNodes(graph, 'script'),
      workflows: countGraphNodes(graph, 'workflow'),
      workflowNodes: countGraphNodes(graph, 'workflow_node'),
      hardRules: countGraphNodes(graph, 'hard_rule'),
      definitionNodes: graphNodePreviews(graph, [
        'skill_file',
        'frontmatter',
        'reference',
        'script',
        'preflight',
        'tool',
        'hard_rule',
        'workflow',
        'workflow_node',
        'doctor_rule_result',
      ]),
    },
    ...(graph.scope.artifactHash ? { artifactHash: graph.scope.artifactHash } : {}),
    ...(sourceLocator ? { sourceLocator } : {}),
  };
}

function projectEvalStage(graph: ArtifactGraphDocument, path: string, entry: SkillIndexEntry): ProjectedGraphStage<NonNullable<SkillGraphSnapshot['eval']>> | undefined {
  if (graph.source.sourceKind !== 'eval') return undefined;
  const variantNode = evalVariantNode(graph, entry);
  if (!variantNode) return undefined;
  const skillNode = evalSkillNodeForVariant(graph, variantNode);
  const artifactHash = nodeArtifactHash(variantNode) ?? nodeArtifactHash(skillNode);
  const sourceLocator = graphSourceLocator(graph, skillNode);
  const nodesById = graphNodeMap(graph);
  const projectedNodeIds = new Set<string>([variantNode.id]);
  const projectedEdgeIds = new Set<string>();
  if (skillNode) projectedNodeIds.add(skillNode.id);

  const addEdge = (edge: ArtifactGraphDocument['edges'][number]): void => {
    projectedEdgeIds.add(edge.id);
    projectedNodeIds.add(edge.fromNodeId);
    projectedNodeIds.add(edge.toNodeId);
  };

  for (const edge of graph.edges) {
    if (edge.fromNodeId === variantNode.id && (edge.edgeKind === 'evaluates' || edge.edgeKind === 'derived_from')) {
      addEdge(edge);
    }
  }

  const evalResultNodes = graph.edges
    .filter((edge) => edge.toNodeId === variantNode.id && edge.edgeKind === 'derived_from')
    .map((edge) => nodesById.get(edge.fromNodeId))
    .filter((node): node is ArtifactGraphNode => node?.nodeKind === 'eval_result');
  for (const node of evalResultNodes) projectedNodeIds.add(node.id);

  for (const edge of graph.edges) {
    if (!evalResultNodes.some((node) => node.id === edge.fromNodeId || node.id === edge.toNodeId)) continue;
    if (edge.edgeKind === 'derived_from' || edge.edgeKind === 'evaluates' || edge.edgeKind === 'passes' || edge.edgeKind === 'fails' || edge.edgeKind === 'diagnoses') {
      addEdge(edge);
    }
  }

  const declaredCoverageStableKeys = new Set<string>();
  let coverageEdges = 0;
  for (const edge of graph.edges) {
    if (edge.edgeKind !== 'covers') continue;
    const from = nodesById.get(edge.fromNodeId);
    const to = nodesById.get(edge.toNodeId);
    if (from?.nodeKind !== 'sample' || !to) continue;
    if (!projectedNodeIds.has(from.id)) continue;
    if (artifactHash && nodeArtifactHash(to) !== artifactHash) continue;
    addEdge(edge);
    coverageEdges += 1;
    if (to.stableKey) declaredCoverageStableKeys.add(to.stableKey);
  }

  const sampleIds = new Set<string>();
  const assertionIds = new Set<string>();
  const diagnosticIds = new Set<string>();
  let failedAssertionEdges = 0;
  for (const edge of graph.edges) {
    if (!projectedEdgeIds.has(edge.id)) continue;
    const from = nodesById.get(edge.fromNodeId);
    const to = nodesById.get(edge.toNodeId);
    if (from?.nodeKind === 'sample') sampleIds.add(from.id);
    if (to?.nodeKind === 'sample') sampleIds.add(to.id);
    if (from?.nodeKind === 'assertion') assertionIds.add(from.id);
    if (to?.nodeKind === 'assertion') assertionIds.add(to.id);
    if (from?.nodeKind === 'diagnostic') diagnosticIds.add(from.id);
    if (to?.nodeKind === 'diagnostic') diagnosticIds.add(to.id);
    if (edge.edgeKind === 'fails') failedAssertionEdges += 1;
  }
  const measurementNodes = graphNodePreviews(graph, [
    'sample',
    'assertion',
    'eval_result',
    'diagnostic',
  ], projectedNodeIds);

  return {
    stage: {
      sourceKind: 'eval',
      sourceId: graph.source.sourceId,
      graphId: graph.graphId,
      generatedAt: graph.generatedAt,
      graphPath: path,
      nodeCount: projectedNodeIds.size,
      edgeCount: projectedEdgeIds.size,
      variantName: variantNode.label,
      samples: sampleIds.size,
      assertions: assertionIds.size,
      failedAssertionEdges,
      diagnostics: diagnosticIds.size,
      measurementNodes,
      coverageEdges,
      declaredCoverageStableKeys: [...declaredCoverageStableKeys].sort(),
    },
    ...(artifactHash ? { artifactHash } : {}),
    ...(sourceLocator ? { sourceLocator } : {}),
  };
}

function graphSnapshotBinding(stages: ProjectedGraphStage<unknown>[]): Pick<SkillGraphSnapshot, 'artifactHash' | 'bindingStrength' | 'sourceLocator'> {
  const hashes = uniqueStrings(stages.map((stage) => stage.artifactHash ?? ''));
  const locators = uniqueStrings(stages.map((stage) => stage.sourceLocator ?? ''));
  if (stages.length > 0 && hashes.length === 1 && stages.every((stage) => stage.artifactHash === hashes[0])) {
    return { bindingStrength: 'content-hash', artifactHash: hashes[0], ...(locators[0] ? { sourceLocator: locators[0] } : {}) };
  }
  if (hashes.length > 0) {
    return { bindingStrength: 'mixed', ...(locators[0] ? { sourceLocator: locators[0] } : {}) };
  }
  if (locators.length > 0) {
    return { bindingStrength: 'source-locator', sourceLocator: locators[0] };
  }
  return { bindingStrength: 'name-only' };
}

function graphSnapshotForEntry(entry: SkillIndexEntry, graphs: LoadedArtifactGraph[]): SkillGraphSnapshot | undefined {
  const doctorCandidates = graphs.filter(({ graph }) =>
    graph.source.sourceKind === 'doctor'
      && (!entry.doctor || graph.source.sourceId === entry.doctor.reportId)
      && graphMatchesDoctorEntry(graph, entry),
  );
  const evalCandidates = graphs.filter(({ graph }) =>
    graph.source.sourceKind === 'eval'
      && (!entry.eval || graph.source.sourceId === entry.eval.reportId)
      && graphMatchesEvalEntry(graph, entry),
  );
  const doctor = pickLatestGraph(doctorCandidates);
  const evalGraph = pickLatestGraph(evalCandidates);
  if (!doctor && !evalGraph) return undefined;

  const doctorStage = doctor ? projectDoctorStage(doctor.graph, doctor.path) : undefined;
  const evalStage = evalGraph ? projectEvalStage(evalGraph.graph, evalGraph.path, entry) : undefined;
  const projectedStages: ProjectedGraphStage<unknown>[] = [];
  if (doctorStage) projectedStages.push(doctorStage);
  if (evalStage) projectedStages.push(evalStage);
  const binding = graphSnapshotBinding(projectedStages);

  return {
    ...binding,
    ...(doctorStage ? { doctor: doctorStage.stage } : {}),
    ...(evalStage ? { eval: evalStage.stage } : {}),
  };
}

/** 扫 doctorsDir/*.report.json,按 skill 名分桶,**返回该 skill 的所有历史 snapshot**(asc 时序)。
 *  renderer 用最后一项做"当前",前面项画 sparkline。 */
function scanDoctorReports(dir: string): Record<string, SkillDoctorSnapshot[]> {
  const out: Record<string, SkillDoctorSnapshot[]> = {};
  migrateLegacyReportFiles(dir, 'doctor');
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!isReportFileName(file)) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as DoctorReport;
      const kind = data?.kind === 'doctor' ? data.kind : null;
      if (!kind || !Array.isArray(data.skills)) continue;
      const ts = data.timestamp;
      for (const sr of data.skills) {
        const passN = sr.results.filter((r) => r.status === 'pass').length;
        const warnN = sr.results.filter((r) => r.status === 'warn').length;
        const failN = sr.results.filter((r) => r.status === 'fail').length;
        const snap: SkillDoctorSnapshot = {
          reportId: data.id, timestamp: ts, status: sr.status,
          passCount: passN, warnCount: warnN, failCount: failN, results: sr.results,
        };
        if (!out[sr.skillName]) out[sr.skillName] = [];
        out[sr.skillName].push(snap);
      }
    } catch { /* skip corrupt */ }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

/**
 * 扫 reports + analyses 目录,按 skill 名聚合。reports 通过 reportStore.list() 传入
 * (避免重复读盘 + 避免再写一份 list 逻辑);analysesDir 直接扫。
 *
 * 同 skill 多份报告时取 timestamp 最新的一份。
 */
export interface BuildSkillIndexOptions {
  /** 合并别项目 observe 卡片(机器级模式)。固定 --analyses-dir / --global 时为 false,只看该目录。 */
  includeObserveCards?: boolean;
  /** 合并别项目 doctor 卡片(机器级模式)。固定 --doctors-dir / --global 时为 false,只看该目录。 */
  includeDoctorCards?: boolean;
  /** 合并别项目 eval report 卡片对应的 graph sidecar。 */
  includeReportCards?: boolean;
  /** 当前可见 eval graph sidecar 目录。 */
  evalGraphDirs?: string[];
  /** 当前可见 doctor graph sidecar 目录。默认跟随 doctorsDir 推导。 */
  doctorGraphDirs?: string[];
}

export function buildSkillIndex(
  reports: ReportDocument[],
  analysesDir: string,
  doctorsDir: string,
  observationsDir: string = DEFAULT_OBSERVATIONS_DIR,
  opts: BuildSkillIndexOptions = {},
): SkillIndex {
  const includeObserveCards = opts.includeObserveCards ?? false;
  const includeDoctorCards = opts.includeDoctorCards ?? false;
  const includeReportCards = opts.includeReportCards ?? false;
  const evalGraphDirs = uniqueStrings(opts.evalGraphDirs ?? []);
  const doctorGraphDirs = uniqueStrings([
    doctorGraphDirForDoctorOutput(doctorsDir),
    ...(opts.doctorGraphDirs ?? []),
  ]);
  const graphFingerprint = buildGraphFingerprint(evalGraphDirs, doctorGraphDirs, includeReportCards, includeDoctorCards);
  // 命中缓存就直接返回(fingerprint 覆盖 reports + 两个 dir + 卡片 include 模式的变化信号)
  const fp = buildIndexFingerprint(reports, analysesDir, doctorsDir, observationsDir, includeObserveCards, includeDoctorCards, graphFingerprint);
  if (_indexCache && _indexCache.fingerprint === fp) {
    return _indexCache.result;
  }

  // ── eval 聚合(历史 list)─────────────────────────────────
  const evalBy: Record<string, SkillEvalSnapshot[]> = {};
  for (const r of reports) {
    if (r.kind !== 'evaluation') continue;
    const variants = r.meta.variants || [];
    for (const v of variants) {
      const skillName = skillNameForEvalVariant(r, v);
      if (!skillName) continue;
      const snap = buildEvalSnapshot(r, v);
      if (!snap) continue;
      if (!evalBy[skillName]) evalBy[skillName] = [];
      evalBy[skillName].push(snap);
    }
  }
  for (const list of Object.values(evalBy)) list.sort((a, b) => evalSnapshotSortKey(a).localeCompare(evalSnapshotSortKey(b)));

  // ── observe 聚合(历史 list)──────────────────────────────
  const observeBy: Record<string, SkillObserveSnapshot[]> = {};
  migrateLegacyReportFiles(analysesDir, 'observe-health');
  if (existsSync(analysesDir)) {
    for (const file of readdirSync(analysesDir)) {
      const id = reportFileStem(file);
      if (!id) continue;
      try {
        const data = JSON.parse(readFileSync(join(analysesDir, file), 'utf-8')) as SkillHealthReport;
        if (!data?.bySkill || !data.meta) continue;
        const generatedAt = data.meta.generatedAt;
        for (const [skill, h] of Object.entries(data.bySkill)) {
          const snap: SkillObserveSnapshot = {
            analysisId: id, generatedAt,
            healthBand: bandFromObserveHealth(h),
            failureRate: h.toolFailureRate,
            segmentCount: h.segmentCount,
            gapRate: h.gap?.weightedGapRate ?? 0,
            // Legacy reports (pre-confidence) fall back to deriving from segmentCount.
            confidence: h.confidence ?? confidenceOf(h.segmentCount),
          };
          if (!observeBy[skill]) observeBy[skill] = [];
          observeBy[skill].push(snap);
        }
      } catch { /* skip corrupt */ }
    }
  }
  // 别项目的 observe 卡片(当前 analysesDir live 扫不到的项目)→ per-skill snapshot,dedup by analysisId(live 盖卡片)。
  // 仅机器级模式合并;固定 --analyses-dir / --global 时 includeObserveCards=false,只看该目录(逃生舱语义)。
  if (includeObserveCards) {
    for (const card of listLiveObserveCards()) {
      for (const [skill, h] of Object.entries(card.bySkill)) {
        const list = (observeBy[skill] ??= []);
        if (list.some((s) => s.analysisId === card.id)) continue;
        list.push({
          analysisId: card.id, generatedAt: card.meta.generatedAt,
          healthBand: bandFromObserveHealth(h), failureRate: h.toolFailureRate, segmentCount: h.segmentCount,
          gapRate: h.gap?.weightedGapRate ?? 0, confidence: h.confidence ?? confidenceOf(h.segmentCount),
        });
      }
    }
  }
  for (const list of Object.values(observeBy)) list.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));

  // ── doctor 聚合(历史 list)──────────────────────────────
  const doctorBy = scanDoctorReports(doctorsDir);
  // 别项目的 doctor 卡片 → per-skill snapshot,dedup by reportId(live 盖卡片);prune 删正文时已连带删卡片,故无「复活」。
  // 仅机器级模式合并;固定 --doctors-dir / --global 时 includeDoctorCards=false,只看该目录(逃生舱语义)。
  if (includeDoctorCards) {
    for (const card of listLiveDoctorCards()) {
      const { skillName, snap } = cardToDoctorSnapshot(card);
      const list = (doctorBy[skillName] ??= []);
      if (!list.some((s) => s.reportId === snap.reportId)) list.push(snap);
    }
  }
  for (const list of Object.values(doctorBy)) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const diagnosisBundle = mergeDiagnosisBundles(
    loadLatestObservationInboxReports(observationsDir).flatMap((report) => report.diagnostics ? [report.diagnostics] : []),
    new Date().toISOString(),
  );

  // ── 合并 ──────────────────────────────────────────────────
  const allSkills = new Set<string>([
    ...Object.keys(evalBy), ...Object.keys(observeBy), ...Object.keys(doctorBy), ...Object.keys(diagnosisBundle.bySkill),
  ]);
  const entries: SkillIndexEntry[] = [];
  for (const name of allSkills) {
    const doctorHistory = doctorBy[name] ?? [];
    const evalHistory = evalBy[name] ?? [];
    const observeHistory = observeBy[name] ?? [];
    const doctor = doctorHistory.length > 0 ? doctorHistory[doctorHistory.length - 1] : null;
    const evalSnap = latestEvalSnapshot(evalHistory);
    const observe = observeHistory.length > 0 ? observeHistory[observeHistory.length - 1] : null;
    entries.push({
      skillName: name,
      doctor, eval: evalSnap, observe,
      doctorHistory, evalHistory, observeHistory,
      band: combineBand(doctor, evalSnap, observe),
    });
  }
  entries.sort((a, b) => latestActivityTs(b).localeCompare(latestActivityTs(a)));

  // ── summary ───────────────────────────────────────────────
  const summary: SkillIndexSummary = {
    totalSkills: entries.length,
    withEval: entries.filter((e) => e.eval).length,
    withObserve: entries.filter((e) => e.observe).length,
    withDoctor: entries.filter((e) => e.doctor).length,
    red: entries.filter((e) => e.band === 'red').length,
    yellow: entries.filter((e) => e.band === 'yellow').length,
    green: entries.filter((e) => e.band === 'green').length,
    gray: entries.filter((e) => e.band === 'gray').length,
  };

  // 跟 SkillIndex 一起算 insightsBySkill,享受同一份 fingerprint 缓存。
  // list 页对每个 entry 跑 detectInsights 的 CPU 开销迁移到这里,只 miss 时算一次。
  const insightsBySkill = new Map<string, Insight[]>();
  for (const ent of entries) {
    const evalReport = ent.eval ? reports.find((r) => r.id === ent.eval!.reportId && r.kind === 'evaluation') as EvaluationReport | undefined : undefined;
    insightsBySkill.set(ent.skillName, detectInsights(ent, evalReport ?? null, {
      diagnostics: diagnosisBundle.bySkill[ent.skillName] ?? [],
    }));
  }

  // 跨层口径统一:三大 snapshot(doctor / eval / observe)都空但 Diagnosis / Insight 投影出
  // high / medium 信号的 skill,把 entry.band 从 gray 升级。否则 HTML renderer(assessHealth)
  // 会把卡片标红、API(/api/skills)却返回 band='gray' summary.gray+=1,renderNextSteps 又会
  // 追加「完全没报告」建议 —— 用户视角看到的是「红卡 + 待优化 N + 完全没报告」矛盾态。
  for (const ent of entries) {
    if (ent.band !== 'gray') continue;
    const ins = insightsBySkill.get(ent.skillName) ?? [];
    const hasHigh = ins.some((i) => i.severity === 'high');
    const hasMed = ins.some((i) => i.severity === 'medium');
    if (hasHigh) ent.band = 'red';
    else if (hasMed) ent.band = 'yellow';
  }

  const graphs = loadGraphsForSkillIndex({
    evalGraphDirs,
    doctorGraphDirs,
    includeReportCards,
    includeDoctorCards,
  });
  for (const ent of entries) {
    const graph = graphSnapshotForEntry(ent, graphs);
    if (graph) ent.graph = graph;
  }
  summary.red = entries.filter((e) => e.band === 'red').length;
  summary.yellow = entries.filter((e) => e.band === 'yellow').length;
  summary.green = entries.filter((e) => e.band === 'green').length;
  summary.gray = entries.filter((e) => e.band === 'gray').length;

  const diagnosticsBySkill = new Map<string, Diagnosis[]>(
    Object.entries(diagnosisBundle.bySkill),
  );
  const diagnosisSummary = buildStudioDiagnosisSummary(diagnosisBundle);

  const result: SkillIndex = { entries, summary, insightsBySkill, diagnosticsBySkill, diagnosisSummary };
  _indexCache = { fingerprint: fp, result };
  return result;
}

/** 单 skill 详情查询(用于 /skills/&lt;name&gt; 详情页)— 复用 buildSkillIndex 的扫描结果。 */
export function getSkillEntry(idx: SkillIndex, skillName: string): SkillIndexEntry | null {
  return idx.entries.find((e) => e.skillName === skillName) ?? null;
}

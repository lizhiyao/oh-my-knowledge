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
 *   - doctor:暂无独立持久化路径(omk doctor --html 写指定路径,默认不存盘),
 *     该字段保留 null,渲染层显示"未独立运行 omk doctor"。后续 commit 加默认
 *     ~/.oh-my-knowledge/doctors/ 持久化路径再回填。
 *
 * 综合 band:eval / observe 任一红 → 红,任一黄 → 黄,全绿 → 绿,皆未跑 → gray。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportDocument, EvaluationReport, AssertionDetail } from '../types/index.js';
import type { SkillHealthReport } from '../observability/skill-health-analyzer.js';
import type { DoctorReport, DoctorRuleResult, DoctorSkillStatus } from '../types/doctor.js';
import { computeVerdict } from '../eval-core/verdict.js';
import { detectInsights, type Insight } from './skill-insights.js';
import { DEFAULT_OBSERVATIONS_DIR, loadLatestObservationInboxReports } from '../observability/inbox.js';
import { buildStudioDiagnosisSummary, mergeDiagnosisBundles, type StudioDiagnosisSummary } from '../diagnosis/studio-projection.js';
import type { Diagnosis } from '../diagnosis/types.js';

// ── 模块级缓存:Studio 每次请求都跑 buildSkillIndex,扫盘成本随 skill 数线性,
// 数据量大后列表 / 详情页响应变慢(PR #95 review P2-4 — cache 引入本身那一条)。
//
// 缓存策略:对 reports id+timestamp 拼接 + `doctorsDir` 跟 `analysesDir` 各自
// 下"每个 .json 文件的 name:mtimeMs:size 三元组按 filename 排序拼接"的
// **content-aware** fingerprint key。三类变化都会让 fingerprint 字符串变让
// cache 失效:
//
//   (1) reports 数组改变(新 run id 进列表 / 现有 entry 的 meta.timestamp 变)
//   (2) doctorsDir / analysesDir 里 .json 文件**增删改名**(dir 本身 mtime
//       随 dirent 变化变,且排序后的 filename 序列变,fingerprint 字符串里那
//       两段都变)
//   (3) doctorsDir / analysesDir 里**同名 .json 文件被原地覆写内容**(Unix
//       目录 mtime 不变因为 dirent 表项没动,但被覆写的那个 file 自己的
//       mtimeMs 跟 byte size 都会变 — fingerprint 字符串里那一行
//       `<filename>:<mtimeMs>:<size>` 的后缀变,整体字符串变,cache miss
//       触发重新 build)
//
// (3) 是 PR #95 reviewer lizhiyao 2026-05-11 顶部 issue-comment 的 🟡 P2 第
// 一条 ship-blocker(P2-a) — pre-fix 时 fingerprint 只看 dir 本身的 mtime
// 跟 .json 文件数两个量,前面 (1) (2) 信号能命中,但 (3) 这种"外部 process
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
 * 的 async `computeListFingerprint` — 把目录本身的 mtime 跟目录下每个 `.json`
 * 文件的 "filename:mtimeMs:size" 三元组排序拼接成 stable 字符串作为 dir-level
 * 的 content-aware fingerprint。
 *
 * - 目录下任何 .json 文件**新增 / 删除 / 重命名** → 目录 mtime 跟着变,且
 *   sorted-filenames 列表变,字符串变 → cache invalidate。
 * - 任何**已有同名 .json 文件被外部进程原地覆写内容** → 该文件自己的 mtimeMs
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
    jsonFiles = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
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

function buildIndexFingerprint(reports: ReportDocument[], analysesDir: string, doctorsDir: string, observationsDir: string): string {
  // `d:` 跟 `o:` 前缀("d for doctors / o for observability analyses")沿用 pre-fix
  // 字面格式,避免外部 logging / debug 时 grep fingerprint 字符串的格式漂移。
  // 每一段的 right-hand-side 从旧的 "{dir-mtime}-{file-count}" 双标量升级成
  // safeDirJsonContentFingerprint 返回的 "{dir-mtime}|{file1}:{m}:{s},..."
  // content-aware 字符串。
  const reportIds = reports.map((r) => `${r.id}:${r.meta?.timestamp ?? ''}`).join(',');
  const doctorsFp = safeDirJsonContentFingerprint(doctorsDir);
  const analysesFp = safeDirJsonContentFingerprint(analysesDir);
  const observationsFp = safeDirJsonContentFingerprint(observationsDir);
  return `${reportIds}|d:${doctorsFp}|o:${analysesFp}|obs:${observationsFp}`;
}

/** 测试 / 调试用:强制清掉 in-process skill-index 缓存。 */
export function _resetSkillIndexCache(): void {
  _indexCache = null;
}

export interface SkillDoctorSnapshot {
  reportId: string;
  timestamp: string;
  status: DoctorSkillStatus;
  passCount: number;
  warnCount: number;
  failCount: number;
  results: DoctorRuleResult[];
}

export interface SkillEvalSnapshot {
  reportId: string;
  timestamp: string;
  variantName: string;
  verdictLevel: string;
  verdictHeadline: string;
  compositeScore: number | null;
  passCount: number;
  failCount: number;
  tripwireCount: number;
  totalSamples: number;
}

export interface SkillObserveSnapshot {
  analysisId: string;
  generatedAt: string;
  healthBand: 'green' | 'yellow' | 'red';
  failureRate: number;
  segmentCount: number;
  gapRate: number;
}

export interface SkillIndexEntry {
  skillName: string;
  /** 当前(最新)snapshot — 等价于对应 history 的最后一项,空时为 null。renderer
   *  老路径直接读这个,不必动 history。 */
  doctor: SkillDoctorSnapshot | null;
  eval: SkillEvalSnapshot | null;
  observe: SkillObserveSnapshot | null;
  /** 历史 snapshot,chronological 升序(最早 → 最近)。renderer 用它画 sparkline 趋势。 */
  doctorHistory: SkillDoctorSnapshot[];
  evalHistory: SkillEvalSnapshot[];
  observeHistory: SkillObserveSnapshot[];
  /** 综合健康灯。doctor / eval / observe 任一红 → red;任一黄 → yellow;
   *  全绿 → green;皆未跑 → gray。 */
  band: 'green' | 'yellow' | 'red' | 'gray';
}

export interface SkillIndexSummary {
  totalSkills: number;
  withEval: number;
  withObserve: number;
  withDoctor: number;
  red: number;
  yellow: number;
  green: number;
  gray: number;
}

export interface SkillIndex {
  entries: SkillIndexEntry[];
  summary: SkillIndexSummary;
  /** detectInsights 结果按 skillName 索引。在 buildSkillIndex 时同步算好,跟 SkillIndex
   *  本身共享同一 fingerprint 缓存(reports 数组 + dir mtime 任一变就 invalidate)。
   *  list 页 N×detectInsights 重算的 CPU 开销由此消除。 */
  insightsBySkill: Map<string, Insight[]>;
  diagnosticsBySkill: Map<string, Diagnosis[]>;
  diagnosisSummary: StudioDiagnosisSummary;
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
    totalSamples: pass + fail + tripwire,
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
  observe: SkillObserveSnapshot | null,
): 'green' | 'yellow' | 'red' | 'gray' {
  if (!doctor && !evalSnap && !observe) return 'gray';
  // doctor band: status fail → red, warn → yellow, pass → green
  const doctorBand: 'green' | 'yellow' | 'red' | 'gray' = !doctor
    ? 'gray'
    : doctor.status === 'fail' ? 'red'
    : doctor.status === 'warn' ? 'yellow'
    : 'green';
  // eval band:按真实 fail 占比(诱错不算,total 不含)估色。
  const evalDenom = evalSnap ? evalSnap.passCount + evalSnap.failCount : 0;
  const failRatio = evalDenom > 0 ? (evalSnap!.failCount / evalDenom) : 0;
  const evalBand: 'green' | 'yellow' | 'red' | 'gray' = !evalSnap
    ? 'gray'
    : failRatio >= 0.5 ? 'red'
    : failRatio >= 0.2 ? 'yellow'
    : 'green';
  const obsBand: 'green' | 'yellow' | 'red' | 'gray' = observe?.healthBand ?? 'gray';
  if (doctorBand === 'red' || evalBand === 'red' || obsBand === 'red') return 'red';
  if (doctorBand === 'yellow' || evalBand === 'yellow' || obsBand === 'yellow') return 'yellow';
  if (doctorBand === 'green' || evalBand === 'green' || obsBand === 'green') return 'green';
  return 'gray';
}

function latestActivityTs(e: SkillIndexEntry): string {
  const candidates = [e.doctor?.timestamp, e.eval?.timestamp, e.observe?.generatedAt]
    .filter((s): s is string => Boolean(s));
  return candidates.sort().pop() || '';
}

/** 扫 doctorsDir/*.json,按 skill 名分桶,**返回该 skill 的所有历史 snapshot**(asc 时序)。
 *  renderer 用最后一项做"当前",前面项画 sparkline。 */
function scanDoctorReports(dir: string): Record<string, SkillDoctorSnapshot[]> {
  const out: Record<string, SkillDoctorSnapshot[]> = {};
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as DoctorReport;
      if (data?.kind !== 'doctor' || !Array.isArray(data.skills)) continue;
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
export function buildSkillIndex(
  reports: ReportDocument[],
  analysesDir: string,
  doctorsDir: string,
  observationsDir: string = DEFAULT_OBSERVATIONS_DIR,
): SkillIndex {
  // 命中缓存就直接返回(fingerprint 覆盖 reports + 两个 dir 的变化信号)
  const fp = buildIndexFingerprint(reports, analysesDir, doctorsDir, observationsDir);
  if (_indexCache && _indexCache.fingerprint === fp) {
    return _indexCache.result;
  }

  // ── eval 聚合(历史 list)─────────────────────────────────
  const evalBy: Record<string, SkillEvalSnapshot[]> = {};
  for (const r of reports) {
    if (r.kind !== 'evaluation') continue;
    const variants = r.meta.variants || [];
    for (const v of variants) {
      if (v === 'baseline') continue;
      const snap = buildEvalSnapshot(r, v);
      if (!snap) continue;
      if (!evalBy[v]) evalBy[v] = [];
      evalBy[v].push(snap);
    }
  }
  for (const list of Object.values(evalBy)) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // ── observe 聚合(历史 list)──────────────────────────────
  const observeBy: Record<string, SkillObserveSnapshot[]> = {};
  if (existsSync(analysesDir)) {
    for (const file of readdirSync(analysesDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(analysesDir, file), 'utf-8')) as SkillHealthReport;
        if (!data?.bySkill || !data.meta) continue;
        const generatedAt = data.meta.generatedAt;
        const id = file.replace(/\.json$/, '');
        for (const [skill, h] of Object.entries(data.bySkill)) {
          const snap: SkillObserveSnapshot = {
            analysisId: id, generatedAt,
            healthBand: bandFromObserveHealth(h),
            failureRate: h.toolFailureRate,
            segmentCount: h.segmentCount,
            gapRate: h.gap?.weightedGapRate ?? 0,
          };
          if (!observeBy[skill]) observeBy[skill] = [];
          observeBy[skill].push(snap);
        }
      } catch { /* skip corrupt */ }
    }
  }
  for (const list of Object.values(observeBy)) list.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));

  // ── doctor 聚合(历史 list)──────────────────────────────
  const doctorBy = scanDoctorReports(doctorsDir);
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
    const evalSnap = evalHistory.length > 0 ? evalHistory[evalHistory.length - 1] : null;
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

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPORTS_DIR } from './default-dirs.js';
import { indexReportWrite } from './artifact-index.js';
import { parseReportDocument } from './report-document.js';
import { randomRunToken, reportFilePath, runTimestamp } from './artifact-file-names.js';
import { persistEvalGraphSidecar } from '../artifact-graph/eval.js';
import { buildVariantSummary } from './schema.js';
import { buildVariantConfig, resolveExecutionStrategy } from './execution-strategy.js';
import { getJudgePromptHash } from '../grading/judge.js';
import {
  getDiagnosticPromptHash,
  resolveDiagnosticTarget,
} from '../grading/diagnostic.js';
import {
  bootstrapMeanCI,
  bootstrapPairedDiffCI,
  DEFAULT_BOOTSTRAP_ALPHA,
  DEFAULT_BOOTSTRAP_SAMPLES,
} from './bootstrap.js';
import { getExecutorRuntimeFingerprint } from '../executors/runtime-fingerprint.js';
import {
  ownRecordValue,
  setOwnRecordValue,
} from '../shared/record-count.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { hashSample } from './sample-fingerprint.js';
import type {
  Artifact,
  Report,
  Sample,
  Task,
  VariantResult,
  VariantSummary,
  VariantPairComparison,
  GitInfo,
  EvaluationReport,
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
  ReportDocument,
} from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(startDir, '..', 'package.json');
}

const PKG: { version: string } = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8')) as { version: string };

// 写报告的默认目录 = reports 单一来源(default-dirs)。保留 DEFAULT_OUTPUT_DIR 名给既有 16 处 import,值统一,杜绝写/读两端漂移。
export const DEFAULT_OUTPUT_DIR: string = DEFAULT_REPORTS_DIR;
export const EVALUATION_REPORT_SCHEMA_VERSION = 5;

export function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

export { hashSample } from './sample-fingerprint.js';

export function getCliVersion(): string {
  return PKG.version;
}

export function getGitInfo(): GitInfo | null {
  // stdio 静默 stderr:在非 git 目录(如 omk init 出来的 demo)里 rev-parse 会打印
  // `fatal: not a git repository` 到终端。catch 已把失败兜成 null(报告省略 git 信息),
  // 这条 fatal 对用户是纯噪声,吞掉它。与 skill-loader 的 GIT_PROBE_STDIO 同口径。
  const gitProbeStdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: gitProbeStdio }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', stdio: gitProbeStdio }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8', stdio: gitProbeStdio }).trim().length > 0;
    return { commit, commitShort: commit.slice(0, 7), branch, dirty };
  } catch {
    return null;
  }
}

function commonRuntime(runtimes: Record<string, ReturnType<typeof getExecutorRuntimeFingerprint>>): ReturnType<typeof getExecutorRuntimeFingerprint> | undefined {
  const values = Object.values(runtimes);
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((runtime) => runtime.fingerprint === first.fingerprint) ? first : undefined;
}

function representativeRuntime(runtimes: Record<string, ReturnType<typeof getExecutorRuntimeFingerprint>>): ReturnType<typeof getExecutorRuntimeFingerprint> | undefined {
  return Object.values(runtimes)[0];
}

export function buildExecutorRuntimesByVariant({
  variants,
  model,
  executorName,
  tasks,
  artifacts,
  request,
}: {
  variants: string[];
  model: string;
  executorName: string;
  tasks: Task[];
  artifacts: Artifact[];
  request?: Pick<EvaluationRequest, 'skillDir' | 'timeoutMs'>;
}): Record<string, ReturnType<typeof getExecutorRuntimeFingerprint>> {
  const runtimes: Record<string, ReturnType<typeof getExecutorRuntimeFingerprint>> = {};
  for (const task of tasks) {
    if (ownRecordValue(runtimes, task.variant)) continue;
    const executionPlan = resolveExecutionStrategy(task, model, request?.timeoutMs, false);
    setOwnRecordValue(runtimes, task.variant, getExecutorRuntimeFingerprint(executorName, model, {
      skillDir: executionPlan.input.skillDir,
    }));
  }

  for (const variant of variants) {
    if (ownRecordValue(runtimes, variant)) continue;
    const artifact = artifacts.find((a) => a.name === variant);
    // 与主路径 extractSkillDir 一致:dir-skill 优先隔离副本 execRoot(副本无 node_modules、PATH 不污染);
    // 否则 baseline / git 文件-skill 取 null,本地文件-skill 取 .md 所在目录。
    const fallbackSkillDir = artifact?.execRoot
      ?? (artifact?.kind === 'baseline' || artifact?.source === 'git'
        ? null
        : artifact?.locator
          ? dirname(artifact.locator)
          : request?.skillDir);
    setOwnRecordValue(runtimes, variant, getExecutorRuntimeFingerprint(executorName, model, {
      skillDir: fallbackSkillDir,
    }));
  }

  return runtimes;
}

interface AggregateReportOptions {
  runId: string;
  variants: string[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  samples: Sample[];
  samplesBaseDir?: string;
  tasks: Task[];
  results: Record<string, Record<string, VariantResult>>;
  totalCostUSD: number;
  artifacts: Artifact[];
  request?: EvaluationRequest;
  run?: EvaluationRun;
  job?: EvaluationJob;
  layeredStats?: boolean;
}

export function aggregateReport({
  runId,
  variants,
  model,
  judgeModel,
  noJudge,
  executorName,
  samples,
  samplesBaseDir,
  tasks,
  results,
  totalCostUSD,
  artifacts,
  request,
  run,
  job,
  layeredStats,
}: AggregateReportOptions): Report {
  const summary: Record<string, VariantSummary> = {};
  for (const variant of variants) {
    const entries = Object.values(results)
      .map((result) => ownRecordValue(result, variant))
      .filter((entry): entry is VariantResult => Boolean(entry));
    setOwnRecordValue(summary, variant, buildVariantSummary(entries));
  }

  // Bootstrap CI (per-variant mean) when --bootstrap requested. Adds bootstrapCI to
  // each VariantSummary; legacy t-interval (in summary's other fields) is preserved.
  const bootstrapEnabled = request?.bootstrap === true;
  const bootstrapSamples = request?.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  let pairComparisons: VariantPairComparison[] | undefined;
  if (bootstrapEnabled) {
    // 不变量(见 grading/layered-scores.ts):composite 在至少一层可测时恒 ≥ 1,`compositeScore === 0`
    // 当且仅当该样本**无任何可测层**(真·缺测,如纯评委样本且评委失败)。故 `> 0` 过滤精确剔除非测量、
    // 绝不丢"低分内容"(评委失败已在上游当缺测,不会以 0 进 composite)。下同(control / treatment)。
    for (const variant of variants) {
      const entries = Object.values(results)
        .map((r) => ownRecordValue(r, variant))
        .filter((entry): entry is VariantResult => Boolean(entry));
      const compositeScores = entries
        .filter((e) => typeof e.compositeScore === 'number' && e.compositeScore! > 0)
        .map((e) => e.compositeScore!);
      if (compositeScores.length >= 2) {
        summary[variant].bootstrapCI = bootstrapMeanCI(compositeScores, DEFAULT_BOOTSTRAP_ALPHA, bootstrapSamples);
      }
    }

    // Pairwise treatment-vs-control comparisons. Convention: variants[0] is control;
    // each variants[i>0] is a treatment compared against control.
    if (variants.length >= 2) {
      pairComparisons = [];
      const controlName = variants[0];
      const sampleRecords = Object.values(results);
      // **配对** diff CI:A/B 是同一批 sample 分别过 control / treatment(配对设计),按 sample 对齐 ——
      // 同一 sample 上 control 与 treatment 都可测(composite > 0,见上不变量)才入对。同一 sample 两 variant
      // 的分数正相关,配对 bootstrap 据此抵消共有方差、收紧 diff CI、更有功效;旧的独立(非配对)重采样高估
      // 方差、CI 偏宽、保守失功效(见 bootstrapPairedDiffCI)。点估计不变,只收紧 CI。
      // 先收齐每个 treatment 的配对数据;只有 ≥2 对(否则无 CI 可算)才算一个真正被检验的比较。
      const eligible: Array<{ treatment: string; pairs: Array<{ a: number; b: number }> }> = [];
      for (let i = 1; i < variants.length; i++) {
        const treatmentName = variants[i];
        const pairs: Array<{ a: number; b: number }> = [];
        for (const r of sampleRecords) {
          const c = ownRecordValue(r, controlName);
          const t = ownRecordValue(r, treatmentName);
          const a = c && typeof c.compositeScore === 'number' && c.compositeScore > 0 ? c.compositeScore : undefined;
          const b = t && typeof t.compositeScore === 'number' && t.compositeScore > 0 ? t.compositeScore : undefined;
          if (a !== undefined && b !== undefined) pairs.push({ a, b });
        }
        if (pairs.length >= 2) eligible.push({ treatment: treatmentName, pairs });
      }
      // 多重比较(Bonferroni)校正:同时检验 K 个 treatment-vs-control 假设时,family-wise 假阳性随 K 膨胀
      // (computeVerdict 的 worst-case roll-up 取最差 —— 任一对假阳即拉高总判定)。每对 CI 用 α/K(K = 实际
      // 产出 CI 的比较数)把 family-wise error 压回名义 α。K=1(单 treatment / 经典 A-B)即 α 不变、与历史单对
      // 口径逐字节一致,此时不写 alpha 字段(渲染按名义 95% CI,既有报告 / 快照不动)。CI 与 significant 同在 α/K
      // 下算,二者自洽(绝不出现 CI 含 0 却 significant 的矛盾)。注:K 很大时 α/K 落到极端分位,1000 重采样的
      // 尾部分位偏粗,大 K 慎读 —— 不在本 PR 提采样数。
      const familySize = eligible.length;
      const perComparisonAlpha = familySize >= 1 ? DEFAULT_BOOTSTRAP_ALPHA / familySize : DEFAULT_BOOTSTRAP_ALPHA;
      for (const { treatment, pairs } of eligible) {
        pairComparisons.push({
          control: controlName,
          treatment,
          diffBootstrapCI: bootstrapPairedDiffCI(pairs, perComparisonAlpha, bootstrapSamples),
          ...(familySize >= 2 ? { alpha: perComparisonAlpha } : {}),
        });
      }
    }
  }

  // 整树内容指纹:解析期已由 resolveArtifacts 用 hashArtifactSource 算好挂在 artifact.contentHash 上
  // (目录-skill 覆盖整棵可分发树含 references/ 资产、文件-skill 为单文件字节),与 install 受管记录的
  // contentHash 落在同一空间——证据可绑定的前提,也修掉「只哈 SKILL.md 正文、改资产指纹不变」的资产瞎。
  // baseline / 无 skill 记 'no-skill'。
  const artifactHashes = Object.fromEntries(
    artifacts.map((artifact) => [artifact.name, artifact.contentHash ?? 'no-skill']),
  );

  const sampleHashes = Object.fromEntries(
    samples.map((sample) => [sample.sample_id, hashSample(sample, samplesBaseDir)]),
  );
  const judgeRepeat = request?.judgeRepeat && request.judgeRepeat > 1 ? request.judgeRepeat : undefined;
  const runtimeOptions = { skillDir: request?.skillDir };
  const executorRuntimes = buildExecutorRuntimesByVariant({ variants, model, executorName, tasks, artifacts, request });
  const executorRuntime = commonRuntime(executorRuntimes)
    ?? representativeRuntime(executorRuntimes)
    ?? getExecutorRuntimeFingerprint(executorName, model, runtimeOptions);
  // request.judgeModels is the authoritative source (always non-empty in new schema).
  // Fallback synthesizes a 1-entry from positional judgeModel/executorName for any
  // legacy caller not yet migrated to the array. noJudge ⇒ runtime undefined per entry.
  const requestJudges = request?.judgeModels ?? [{ executor: executorName, model: judgeModel }];
  const judgeModelsMeta: import('../types/index.js').JudgeRuntimeEntry[] = requestJudges.map((jc) => ({
    executor: jc.executor,
    model: jc.model,
    ...(noJudge ? {} : { runtime: getExecutorRuntimeFingerprint(jc.executor, jc.model, runtimeOptions) }),
  }));
  const diagnosticEnabled = request?.noDiagnostic !== true;
  const diagnosticTarget = resolveDiagnosticTarget(
    requestJudges,
    executorName,
    model,
  );
  const diagnostic = diagnosticEnabled
    ? {
      enabled: true as const,
      executor: diagnosticTarget.executor,
      model: diagnosticTarget.model,
      runtime: getExecutorRuntimeFingerprint(
        diagnosticTarget.executor,
        diagnosticTarget.model,
      ),
      promptHash: getDiagnosticPromptHash(),
    }
    : { enabled: false as const };
  // length-debias is on by default; the request only sets it
  // false when the user passed --no-debias-length. The judgePromptHash differs between
  // the length-debias-on and -off prompt variants so readers can detect the divergence.
  const lengthDebiasOn = request?.lengthDebias !== false;
  const debiasModeList: Array<'length' | 'position'> = [];
  if (lengthDebiasOn) debiasModeList.push('length');
  const totalCostReported = Object.values(summary).every((variant) =>
    variant.execCostReported !== false && variant.judgeCostReported !== false);

  return {
    kind: 'evaluation',
    id: runId,
    meta: {
      variants,
      model,
      executor: executorName,
      ...(request?.effort ? { effort: request.effort } : {}),
      sampleCount: samples.length,
      taskCount: tasks.length,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      ...(totalCostReported ? {} : { totalCostReported: false }),
      timestamp: new Date().toISOString(),
      cliVersion: getCliVersion(),
      nodeVersion: process.version,
      // schemaVersion 3 起,所有 dir-skill(本地 + git)都经隔离副本物化、整棵可分发树哈,与 install
      // 受管记录 contentHash 同空间(evidence 全绑)。4 延续 v3 的哈/绑定义,并作为当前 canonical
      // 顶层判别字段纪元,方便外部消费方按版本识别 JSON 形状。2 是过渡纪元(本地 dir-skill 树哈、
      // git dir-skill 仅 SKILL.md 字节、不绑);git dir-skill 的 v2 与 v3+ 不可比。
      schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
      artifactHashes,
      sampleHashes,
      ...(noJudge ? {} : { judgePromptHash: getJudgePromptHash(lengthDebiasOn) }),
      diagnostic,
      executorRuntime,
      executorRuntimes,
      judgeModels: judgeModelsMeta,
      ...(noJudge ? { noJudge: true } : {}),
      ...(judgeRepeat ? { judgeRepeat } : {}),
      ...(debiasModeList.length > 0 ? { debiasMode: debiasModeList } : {}),
      ...(bootstrapEnabled ? { evaluationFramework: 'both' as const } : {}),
      ...(pairComparisons ? { pairComparisons } : {}),
      variantConfigs: artifacts.map((artifact) => buildVariantConfig(artifact)),
      //  — Skill isolation snapshot per variant. variantName → allowedSkills (null
      // 表示该 variant 没声明 = SDK 默认全发现)。跨报告对比 verdict / Δ 时,isolation
      // 不一致(一个报告有 [],另一个没字段)即不可比。renderer 可据此打提示。
      skillIsolation: Object.fromEntries(
        artifacts.map((a) => [a.name, a.allowedSkills ?? null]),
      ),
      request,
      run,
      job,
      gitInfo: getGitInfo(),
      ...(layeredStats ? { layeredStats: true } : {}),
    },
    summary,
    results: Object.entries(results).map(([sample_id, variantData]) => ({
      sample_id,
      variants: variantData,
    })),
    // 用例设计快照,供单测视角与证据审计使用。执行/评分语义字段必须保留:
    // cwd / environment / mocksStrict / allowedTools 等会改变真实构造，不能只留一个
    // 不可解释的 sampleHash。纯扩展字段仍不盲目全选，控制报告体积。
    sampleSnapshots: Object.fromEntries(samples.map((s) => [s.sample_id, {
      sample_id: s.sample_id,
      prompt: s.prompt,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.rubric ? { rubric: s.rubric } : {}),
      ...(s.context ? { context: s.context } : {}),
      ...(s.dimensions && Object.keys(s.dimensions).length > 0 ? { dimensions: s.dimensions } : {}),
      ...(s.assertions && s.assertions.length > 0 ? { assertions: s.assertions } : {}),
      ...(s.mocks && s.mocks.length > 0 ? { mocks: s.mocks } : {}),
      ...(s.mocksStrict !== undefined ? { mocksStrict: s.mocksStrict } : {}),
      ...(s.environment ? { environment: s.environment } : {}),
      ...(s.allowedTools && s.allowedTools.length > 0 ? { allowedTools: s.allowedTools } : {}),
      ...(s.expectedTools && s.expectedTools.length > 0 ? { expectedTools: s.expectedTools } : {}),
      ...(s.capability && s.capability.length > 0 ? { capability: s.capability } : {}),
      ...(s.difficulty ? { difficulty: s.difficulty } : {}),
      ...(s.construct ? { construct: s.construct } : {}),
      ...(s.provenance ? { provenance: s.provenance } : {}),
      ...(s.sourceRefs && s.sourceRefs.length > 0 ? { sourceRefs: s.sourceRefs } : {}),
      ...(s.covers && s.covers.length > 0 ? { covers: s.covers } : {}),
      ...(s.tripwire ? { tripwire: true } : {}),
    }])),
  };
}

export type PersistableReport = ReportDocument;

function isEvaluationReport(report: PersistableReport): report is EvaluationReport {
  return report.kind === 'evaluation';
}

function persistEvalGraphSidecarSafely(report: PersistableReport, outputDir: string, sourcePath: string): void {
  if (!isEvaluationReport(report)) return;
  try {
    persistEvalGraphSidecar({ report, outputDir, sourcePath, fileStem: report.id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[omk] 写入 eval 图谱失败：${message}\n`);
  }
}

export function persistReport(report: PersistableReport, outputDir: string | null): string | null {
  if (!outputDir) return null;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const filePath = reportFilePath(outputDir, report.id);
  const parsed = parseReportDocument(report, report.id, report.id);
  if (!parsed) throw new Error('invalid report');
  writeJsonFileAtomic(filePath, parsed);
  persistEvalGraphSidecarSafely(parsed, outputDir, filePath);
  // 产物发现索引:报告落项目本地后,best-effort 追加全局轻卡片,让 omk studio 跨项目聚合成机器级总览。
  // 永不抛、永不阻断报告落盘(正文是 source of truth)。
  indexReportWrite(parsed, filePath, outputDir);
  return filePath;
}

/**
 * run id 的时间戳后缀 `YYYYMMDDTHHmmss-rand4`。
 * 含秒 + 4 位随机:id 是 run 标签(非测量数),但被 studio 机器级 dedup 与 managed 证据 (reportId,
 * contentHash) 去重当唯一键用。分钟级会让跨项目 / 同分钟重跑撞同 id → 索引静默顶掉一份、managed 错并一条。
 * 秒+随机根治撞名,保证每次 run 全局唯一。供 generateRunId 与 evolve 合并 id 共用,避免靠 split 反解格式。
 */
export function runIdSuffix(): string {
  return `${runTimestamp()}-${randomRunToken()}`;
}

function safeRunSubject(subject: string): string {
  const sanitized = subject
    .replaceAll(/[\\/:]/g, '-')
    .replaceAll(/[^a-zA-Z0-9._@-]/g, '_')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'run';
}

function primaryRunSubject(variants: string[]): string {
  const nonBaseline = variants.filter((variant) => variant !== 'baseline');
  return nonBaseline.at(-1) ?? variants.at(-1) ?? 'run';
}

export function generateRunId(variants: string[]): string {
  return `${safeRunSubject(primaryRunSubject(variants))}-${runIdSuffix()}`;
}

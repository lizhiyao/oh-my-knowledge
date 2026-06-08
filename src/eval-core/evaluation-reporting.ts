import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildVariantSummary } from './schema.js';
import { buildVariantConfig, resolveExecutionStrategy } from './execution-strategy.js';
import { getJudgePromptHash } from '../grading/judge.js';
import {
  bootstrapMeanCI,
  bootstrapDiffCI,
  DEFAULT_BOOTSTRAP_ALPHA,
  DEFAULT_BOOTSTRAP_SAMPLES,
} from './bootstrap.js';
import { getExecutorRuntimeFingerprint } from '../executors/runtime-fingerprint.js';
import type {
  Artifact,
  Report,
  Sample,
  Task,
  VariantResult,
  VariantSummary,
  VariantPairComparison,
  GitInfo,
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
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

export const DEFAULT_OUTPUT_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

export function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

/**
 * Canonical (key-sorted, recursive) JSON serialization. Required for cross-run hash
 * stability — JS object key iteration order is implementation-defined for objects
 * built by spread / Object.assign / yaml.parse, so naive JSON.stringify can produce
 * different bytes for the "same" sample on different runs.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return '{' + entries.map((k) => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Stable content hash of a sample. Hashes the prompt + assertions + dimensions/rubric
 * (the parts that determine what's being measured). Two samples with the same hash
 * across runs measure the same thing; mismatched hashes mean the sample changed.
 */
export function hashSample(sample: Sample): string {
  const stableForm = canonicalStringify({
    prompt: sample.prompt,
    rubric: sample.rubric ?? null,
    dimensions: sample.dimensions ?? null,
    assertions: sample.assertions ?? null,
    schema: sample.schema ?? null,
  });
  return hashString(stableForm);
}

export function getCliVersion(): string {
  return PKG.version;
}

export function getGitInfo(): GitInfo | null {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim().length > 0;
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

function buildExecutorRuntimesByVariant({
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
  request?: EvaluationRequest;
}): Record<string, ReturnType<typeof getExecutorRuntimeFingerprint>> {
  const runtimes: Record<string, ReturnType<typeof getExecutorRuntimeFingerprint>> = {};
  for (const task of tasks) {
    if (runtimes[task.variant]) continue;
    const executionPlan = resolveExecutionStrategy(task, model, request?.timeoutMs, false);
    runtimes[task.variant] = getExecutorRuntimeFingerprint(executorName, model, {
      skillDir: executionPlan.input.skillDir,
    });
  }

  for (const variant of variants) {
    if (runtimes[variant]) continue;
    const artifact = artifacts.find((a) => a.name === variant);
    // git artifact 无在盘 skillDir(content 经 SDK 注入),与 baseline 一样取 null —— 与主路径
    // extractSkillDir 的判定一致,避免 git variant 的 runtime fingerprint 被 cwd 的 node_modules 污染。
    const fallbackSkillDir = artifact?.kind === 'baseline' || artifact?.source === 'git'
      ? null
      : artifact?.locator
        ? dirname(artifact.locator)
        : request?.skillDir;
    runtimes[variant] = getExecutorRuntimeFingerprint(executorName, model, {
      skillDir: fallbackSkillDir,
    });
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
    const entries = Object.values(results).map((result) => result[variant]).filter(Boolean);
    summary[variant] = buildVariantSummary(entries);
  }

  // Bootstrap CI (per-variant mean) when --bootstrap requested. Adds bootstrapCI to
  // each VariantSummary; legacy t-interval (in summary's other fields) is preserved.
  const bootstrapEnabled = request?.bootstrap === true;
  const bootstrapSamples = request?.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  let pairComparisons: VariantPairComparison[] | undefined;
  if (bootstrapEnabled) {
    for (const variant of variants) {
      const entries = Object.values(results).map((r) => r[variant]).filter(Boolean);
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
      const controlEntries = Object.values(results).map((r) => r[controlName]).filter(Boolean);
      const controlScores = controlEntries
        .filter((e) => typeof e.compositeScore === 'number' && e.compositeScore! > 0)
        .map((e) => e.compositeScore!);
      for (let i = 1; i < variants.length; i++) {
        const treatmentName = variants[i];
        const treatmentEntries = Object.values(results).map((r) => r[treatmentName]).filter(Boolean);
        const treatmentScores = treatmentEntries
          .filter((e) => typeof e.compositeScore === 'number' && e.compositeScore! > 0)
          .map((e) => e.compositeScore!);
        if (controlScores.length >= 2 && treatmentScores.length >= 2) {
          pairComparisons.push({
            control: controlName,
            treatment: treatmentName,
            diffBootstrapCI: bootstrapDiffCI(controlScores, treatmentScores, DEFAULT_BOOTSTRAP_ALPHA, bootstrapSamples),
          });
        }
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

  const sampleHashes = Object.fromEntries(samples.map((s) => [s.sample_id, hashSample(s)]));
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
  // length-debias is on by default; the request only sets it
  // false when the user passed --no-debias-length. The hash differs between
  // v3-cot-length (on) and v2-cot (off) so readers can detect the divergence.
  const lengthDebiasOn = request?.lengthDebias !== false;
  const debiasModeList: Array<'length' | 'position'> = [];
  if (lengthDebiasOn) debiasModeList.push('length');
  const totalCostReported = Object.values(summary).every((variant) =>
    variant.execCostReported !== false && variant.judgeCostReported !== false);

  return {
    reportKind: 'evaluation',
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
      // schemaVersion 2 起,artifactHashes 语义为整棵可分发树哈(之前是仅 SKILL.md 正文文本哈)。
      // 作判别位:消费方(sample --fix 漂移 / evolve lineage)对缺位/旧报告不拿旧文本哈与当前树哈错配比对。
      schemaVersion: 2,
      artifactHashes,
      sampleHashes,
      ...(noJudge ? {} : { judgePromptHash: getJudgePromptHash(lengthDebiasOn) }),
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
    // 用例设计快照,供单测视角渲染。只挑渲染需要的字段,跳过 cwd / allowedTools /
    // expectedTools / dimensions / environment(对单测视图无附加价值)。Sample 字段
    // 全选会让 report 体积接近翻倍,选子集 size 增长 ~10-20%。
    sampleSnapshots: Object.fromEntries(samples.map((s) => [s.sample_id, {
      sample_id: s.sample_id,
      prompt: s.prompt,
      ...(s.rubric ? { rubric: s.rubric } : {}),
      ...(s.context ? { context: s.context } : {}),
      ...(s.assertions && s.assertions.length > 0 ? { assertions: s.assertions } : {}),
      ...(s.mocks && s.mocks.length > 0 ? { mocks: s.mocks } : {}),
      ...(s.capability && s.capability.length > 0 ? { capability: s.capability } : {}),
      ...(s.difficulty ? { difficulty: s.difficulty } : {}),
      ...(s.construct ? { construct: s.construct } : {}),
      ...(s.provenance ? { provenance: s.provenance } : {}),
      ...(s.tripwire ? { tripwire: true } : {}),
    }])),
  };
}

export function applyBlindMode(report: Report, variants: string[], blindSeed: string): void {
  const labels = variants.map((_, i) => String.fromCharCode(65 + i));
  let seed = parseInt(hashString(blindSeed).slice(0, 8), 16) | 0;
  const seededRandom = (): number => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const shuffled = [...variants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const blindMap: Record<string, string> = Object.fromEntries(shuffled.map((variant, i) => [labels[i], variant]));
  const reverseMap: Record<string, string> = Object.fromEntries(Object.entries(blindMap).map(([label, variant]) => [variant, label]));

  report.meta.blind = true;
  report.meta.blindMap = blindMap;
  report.meta.variants = labels;
  if (report.meta.executorRuntimes) {
    report.meta.executorRuntimes = Object.fromEntries(
      Object.entries(report.meta.executorRuntimes).map(([variant, runtime]) => [reverseMap[variant] ?? variant, runtime]),
    );
  }

  const newSummary: Record<string, VariantSummary> = {};
  for (const [variant, stats] of Object.entries(report.summary)) {
    newSummary[reverseMap[variant]] = stats;
  }
  report.summary = newSummary;

  for (const result of report.results) {
    const newVariants: Record<string, VariantResult> = {};
    for (const [variant, data] of Object.entries(result.variants)) {
      newVariants[reverseMap[variant]] = data;
    }
    result.variants = newVariants;
  }
}

export interface PersistableReport {
  id: string;
}

export function persistReport(report: PersistableReport, outputDir: string | null): string | null {
  if (!outputDir) return null;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const filePath = join(outputDir, `${report.id}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

export function generateRunId(variants: string[]): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const variantPart = variants
    .map((variant) => variant.replaceAll(/[\\/:]/g, '-').replaceAll(/[^a-zA-Z0-9._@-]/g, '_'))
    .join('-vs-');
  return `${variantPart}-${date}-${time}`;
}

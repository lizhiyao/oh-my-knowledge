import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildVariantSummary } from './schema.js';
import { buildVariantConfig } from './execution-strategy.js';
import { getJudgePromptHash } from '../grading/judge.js';
import { bootstrapMeanCI, bootstrapDiffCI } from './bootstrap.js';
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
} from '../types.js';

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

function hashString(str: string): string {
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
function hashSample(sample: Sample): string {
  const stableForm = canonicalStringify({
    prompt: sample.prompt,
    rubric: sample.rubric ?? null,
    dimensions: sample.dimensions ?? null,
    assertions: sample.assertions ?? null,
    schema: sample.schema ?? null,
  });
  return hashString(stableForm);
}

function getGitInfo(): GitInfo | null {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim().length > 0;
    return { commit, commitShort: commit.slice(0, 7), branch, dirty };
  } catch {
    return null;
  }
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
  const bootstrapSamples = request?.bootstrapSamples ?? 1000;
  let pairComparisons: VariantPairComparison[] | undefined;
  if (bootstrapEnabled) {
    for (const variant of variants) {
      const entries = Object.values(results).map((r) => r[variant]).filter(Boolean);
      const compositeScores = entries
        .filter((e) => typeof e.compositeScore === 'number' && e.compositeScore! > 0)
        .map((e) => e.compositeScore!);
      if (compositeScores.length >= 2) {
        summary[variant].bootstrapCI = bootstrapMeanCI(compositeScores, 0.05, bootstrapSamples);
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
            diffBootstrapCI: bootstrapDiffCI(controlScores, treatmentScores, 0.05, bootstrapSamples),
          });
        }
      }
    }
  }

  const artifactHashes = Object.fromEntries(
    artifacts.map((artifact) => [artifact.name, artifact.content ? hashString(artifact.content) : 'no-skill']),
  );

  const sampleHashes = Object.fromEntries(samples.map((s) => [s.sample_id, hashSample(s)]));
  const judgeRepeat = request?.judgeRepeat && request.judgeRepeat > 1 ? request.judgeRepeat : undefined;
  const judgeModelsList = request?.judgeModels && request.judgeModels.length >= 2
    ? request.judgeModels.map((jc) => `${jc.executor}:${jc.model}`)
    : undefined;
  // v0.21 Phase 3a: length-debias is on by default; the request only sets it
  // false when the user passed --no-debias-length. The hash differs between
  // v3-cot-length (on) and v2-cot (off) so readers can detect the divergence.
  const lengthDebiasOn = request?.lengthDebias !== false;
  const debiasModeList: Array<'length' | 'position'> = [];
  if (lengthDebiasOn) debiasModeList.push('length');

  return {
    id: runId,
    meta: {
      variants,
      model,
      judgeModel: noJudge ? null : judgeModel,
      executor: executorName,
      sampleCount: samples.length,
      taskCount: tasks.length,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
      cliVersion: PKG.version,
      nodeVersion: process.version,
      artifactHashes,
      sampleHashes,
      ...(noJudge ? {} : { judgePromptHash: getJudgePromptHash(lengthDebiasOn) }),
      ...(judgeRepeat ? { judgeRepeat } : {}),
      ...(judgeModelsList ? { judgeModels: judgeModelsList } : {}),
      ...(debiasModeList.length > 0 ? { debiasMode: debiasModeList } : {}),
      ...(bootstrapEnabled ? { evaluationFramework: 'both' as const } : {}),
      ...(pairComparisons ? { pairComparisons } : {}),
      variantConfigs: artifacts.map((artifact) => buildVariantConfig(artifact)),
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

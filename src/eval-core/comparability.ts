import type { Lang, Report, ExecutorRuntimeFingerprint } from '../types/index.js';

export interface ComparabilityWarning {
  code: string;
  severity: 'warning';
  zh: string;
  en: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return '{' + entries.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

function runtimeLabel(runtime: ExecutorRuntimeFingerprint | null | undefined): string {
  if (!runtime) return 'missing';
  const bits = [`${runtime.executor}:${runtime.model}`, `fp=${runtime.fingerprint}`];
  if (runtime.binary?.version) bits.push(`binary=${runtime.binary.version}`);
  if (runtime.sdk?.version) bits.push(`sdk=${runtime.sdk.version}`);
  return bits.join(' ');
}

function push(warnings: ComparabilityWarning[], code: string, zh: string, en: string): void {
  warnings.push({ code, severity: 'warning', zh, en });
}

function countSampleHashMismatches(a: Report, b: Report): { mismatched: number; missing: number; common: number } | null {
  const ah = a.meta.sampleHashes;
  const bh = b.meta.sampleHashes;
  if (!ah || !bh) return null;
  let mismatched = 0;
  let missing = 0;
  let common = 0;
  const ids = new Set([...Object.keys(ah), ...Object.keys(bh)]);
  for (const id of ids) {
    if (ah[id] == null || bh[id] == null) {
      missing++;
      continue;
    }
    common++;
    if (ah[id] !== bh[id]) mismatched++;
  }
  return { mismatched, missing, common };
}

export function reportComparabilityWarnings(report: Report): ComparabilityWarning[] {
  const warnings: ComparabilityWarning[] = [];
  if (!report.meta.executorRuntime) {
    push(
      warnings,
      'executor_runtime_missing',
      '报告缺少 executor runtime 指纹；无法审计 binary / SDK 版本，跨报告严格比较需谨慎。',
      'Report is missing executor runtime fingerprint; binary / SDK versions cannot be audited for strict cross-report comparison.',
    );
  }
  if (report.meta.judgeModel && !report.meta.judgeRuntime) {
    push(
      warnings,
      'judge_runtime_missing',
      '报告缺少评委 runtime 指纹；无法审计评委 executor 的 binary / SDK 版本。',
      'Report is missing judge runtime fingerprint; judge executor binary / SDK versions cannot be audited.',
    );
  }
  if (!report.meta.sampleHashes) {
    push(
      warnings,
      'sample_hashes_missing',
      '报告缺少用例指纹；无法确认不同 run 是否测的是同一组用例。',
      'Report is missing sample fingerprints; runs cannot be verified to use the same test cases.',
    );
  }
  if (!report.meta.skillIsolation) {
    push(
      warnings,
      'skill_isolation_missing',
      '报告缺少 skill isolation 快照；baseline 是否被 skill 污染不可审计。',
      'Report is missing skill-isolation snapshot; baseline contamination cannot be audited.',
    );
  }
  return warnings;
}

export function crossReportComparabilityWarnings(before: Report, after: Report): ComparabilityWarning[] {
  const warnings: ComparabilityWarning[] = [];
  const b = before.meta;
  const a = after.meta;

  if (b.model !== a.model) {
    push(warnings, 'model_mismatch', `执行模型不同: ${b.model} → ${a.model}。`, `Execution model changed: ${b.model} → ${a.model}.`);
  }
  if (b.executor !== a.executor) {
    push(warnings, 'executor_mismatch', `executor 不同: ${b.executor} → ${a.executor}。`, `Executor changed: ${b.executor} → ${a.executor}.`);
  }
  if (b.executorRuntime?.fingerprint && a.executorRuntime?.fingerprint) {
    if (b.executorRuntime.fingerprint !== a.executorRuntime.fingerprint) {
      push(
        warnings,
        'executor_runtime_mismatch',
        `executor runtime 指纹不同: ${runtimeLabel(b.executorRuntime)} → ${runtimeLabel(a.executorRuntime)}。`,
        `Executor runtime fingerprint changed: ${runtimeLabel(b.executorRuntime)} → ${runtimeLabel(a.executorRuntime)}.`,
      );
    }
  } else {
    push(
      warnings,
      'executor_runtime_missing',
      '至少一份报告缺少 executor runtime 指纹；无法确认 binary / SDK 版本一致。',
      'At least one report is missing executor runtime fingerprint; binary / SDK version parity cannot be verified.',
    );
  }

  if ((b.judgeModel || a.judgeModel) && b.judgeModel !== a.judgeModel) {
    push(warnings, 'judge_model_mismatch', `评委模型不同: ${b.judgeModel ?? 'none'} → ${a.judgeModel ?? 'none'}。`, `Judge model changed: ${b.judgeModel ?? 'none'} → ${a.judgeModel ?? 'none'}.`);
  }
  if (b.judgeRuntime?.fingerprint && a.judgeRuntime?.fingerprint) {
    if (b.judgeRuntime.fingerprint !== a.judgeRuntime.fingerprint) {
      push(
        warnings,
        'judge_runtime_mismatch',
        `评委 runtime 指纹不同: ${runtimeLabel(b.judgeRuntime)} → ${runtimeLabel(a.judgeRuntime)}。`,
        `Judge runtime fingerprint changed: ${runtimeLabel(b.judgeRuntime)} → ${runtimeLabel(a.judgeRuntime)}.`,
      );
    }
  } else if (b.judgeModel || a.judgeModel) {
    push(
      warnings,
      'judge_runtime_missing',
      '至少一份报告缺少评委 runtime 指纹；无法确认评委 binary / SDK 版本一致。',
      'At least one report is missing judge runtime fingerprint; judge binary / SDK version parity cannot be verified.',
    );
  }

  if ((b.judgePromptHash || a.judgePromptHash) && b.judgePromptHash !== a.judgePromptHash) {
    push(warnings, 'judge_prompt_hash_mismatch', `评委提示词指纹不同: ${b.judgePromptHash ?? 'missing'} → ${a.judgePromptHash ?? 'missing'}。`, `Judge prompt hash changed: ${b.judgePromptHash ?? 'missing'} → ${a.judgePromptHash ?? 'missing'}.`);
  }
  if ((b.evaluationFramework || a.evaluationFramework) && b.evaluationFramework !== a.evaluationFramework) {
    push(warnings, 'evaluation_framework_mismatch', `统计框架不同: ${b.evaluationFramework ?? 'legacy'} → ${a.evaluationFramework ?? 'legacy'}。`, `Evaluation framework changed: ${b.evaluationFramework ?? 'legacy'} → ${a.evaluationFramework ?? 'legacy'}.`);
  }
  if (stableStringify(b.skillIsolation ?? null) !== stableStringify(a.skillIsolation ?? null)) {
    push(
      warnings,
      'skill_isolation_mismatch',
      'skill isolation 快照不同；baseline 污染边界不一致，严格比较需谨慎。',
      'Skill-isolation snapshots differ; baseline contamination boundaries are not equivalent.',
    );
  }

  const sampleHashDiff = countSampleHashMismatches(before, after);
  if (!sampleHashDiff) {
    push(
      warnings,
      'sample_hashes_missing',
      '至少一份报告缺少用例指纹；无法确认两次 run 使用同一组用例。',
      'At least one report is missing sample fingerprints; test-case parity cannot be verified.',
    );
  } else if (sampleHashDiff.mismatched > 0 || sampleHashDiff.missing > 0) {
    push(
      warnings,
      'sample_hashes_mismatch',
      `用例指纹不一致: ${sampleHashDiff.mismatched} 条内容变化，${sampleHashDiff.missing} 条只出现在其中一份报告。`,
      `Sample fingerprints differ: ${sampleHashDiff.mismatched} content mismatches, ${sampleHashDiff.missing} samples only appear in one report.`,
    );
  }

  return warnings;
}

export function formatComparabilityWarnings(warnings: ComparabilityWarning[], lang: Lang = 'zh'): string {
  if (warnings.length === 0) return '';
  const header = lang === 'zh'
    ? '可比性提示: 以下差异会影响 strict comparison / construct validity'
    : 'Comparability warnings: the following differences affect strict comparison / construct validity';
  return [header, ...warnings.map((warning) => `  - ${lang === 'zh' ? warning.zh : warning.en}`)].join('\n');
}

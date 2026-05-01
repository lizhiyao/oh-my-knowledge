import type { Lang, Report, ReportMeta, ExecutorRuntimeFingerprint, ExecutorRuntimePackage } from '../types/index.js';

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

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function hasJudge(meta: ReportMeta): boolean {
  return Boolean(meta.judgeModel || (meta.judgeModels && meta.judgeModels.length > 0));
}

function effectiveJudgeRepeat(meta: ReportMeta): number {
  return meta.judgeRepeat ?? 1;
}

function packageReasons(pkg: ExecutorRuntimePackage | undefined, label: string): string[] {
  if (!pkg) return [`${label} missing`];
  const reasons: string[] = [];
  if (pkg.error) reasons.push(`${label} probe failed`);
  if (!pkg.version) reasons.push(`${label} version missing`);
  return reasons;
}

function runtimeUnverifiableReasons(runtime: ExecutorRuntimeFingerprint): string[] {
  const reasons: string[] = [];
  if (runtime.kind === 'api') return reasons;

  if (runtime.kind === 'agent-sdk') {
    reasons.push(...packageReasons(runtime.sdk, 'sdk'));
  }

  const binary = runtime.binary;
  if (!binary) {
    reasons.push('binary missing');
    return reasons;
  }
  if (binary.error) reasons.push('binary probe failed');

  if (binary.source === 'path') {
    if (!binary.path) reasons.push('binary path missing');
    if (!binary.version) reasons.push('binary version missing');
  } else if (binary.source === 'bundled') {
    if (!binary.version && !binary.package?.version) reasons.push('bundled binary version missing');
    if (binary.package) reasons.push(...packageReasons(binary.package, 'bundled package').filter((r) => r !== 'bundled package missing'));
  } else if (binary.source === 'unknown') {
    reasons.push('binary source unknown');
  }

  if (runtime.kind === 'unknown') reasons.push('runtime kind unknown');
  return [...new Set(reasons)];
}

function pushRuntimeUnverifiable(
  warnings: ComparabilityWarning[],
  code: string,
  zhSubject: string,
  enSubject: string,
  runtime: ExecutorRuntimeFingerprint | null | undefined,
): void {
  if (!runtime) return;
  const reasons = runtimeUnverifiableReasons(runtime);
  if (reasons.length === 0) return;
  push(
    warnings,
    code,
    `${zhSubject} runtime 指纹不可完全审计: ${runtimeLabel(runtime)} (${reasons.join('; ')})。`,
    `${enSubject} runtime fingerprint is not fully verifiable: ${runtimeLabel(runtime)} (${reasons.join('; ')}).`,
  );
}

function runtimeMapKeys(meta: ReportMeta): string[] {
  return sorted(meta.executorRuntimes ? Object.keys(meta.executorRuntimes) : undefined);
}

function reportExecutorRuntimeWarnings(report: Report, warnings: ComparabilityWarning[]): void {
  const runtimes = report.meta.executorRuntimes;
  if (runtimes && Object.keys(runtimes).length > 0) {
    const missing = report.meta.variants.filter((variant) => !runtimes[variant]);
    if (missing.length > 0) {
      push(
        warnings,
        'executor_runtime_missing',
        `报告缺少部分 variant 的 executor runtime 指纹: ${missing.join(', ')}。`,
        `Report is missing executor runtime fingerprints for variants: ${missing.join(', ')}.`,
      );
    }
    for (const [variant, runtime] of Object.entries(runtimes)) {
      pushRuntimeUnverifiable(warnings, 'executor_runtime_unverifiable', `variant ${variant} executor`, `Variant ${variant} executor`, runtime);
    }
    return;
  }

  if (!report.meta.executorRuntime) {
    push(
      warnings,
      'executor_runtime_missing',
      '报告缺少 executor runtime 指纹；无法审计 binary / SDK 版本，跨报告严格比较需谨慎。',
      'Report is missing executor runtime fingerprint; binary / SDK versions cannot be audited for strict cross-report comparison.',
    );
    return;
  }

  if (report.meta.variants.length > 1) {
    push(
      warnings,
      'executor_runtimes_missing',
      '报告缺少 per-variant executor runtime 指纹；多 variant run 无法审计每个分组实际使用的 binary / SDK 版本。',
      'Report is missing per-variant executor runtime fingerprints; multi-variant runs cannot audit each group’s actual binary / SDK version.',
    );
  }
  pushRuntimeUnverifiable(warnings, 'executor_runtime_unverifiable', 'executor', 'Executor', report.meta.executorRuntime);
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
  reportExecutorRuntimeWarnings(report, warnings);
  if (hasJudge(report.meta) && !report.meta.judgePromptHash) {
    push(
      warnings,
      'judge_prompt_hash_missing',
      '报告缺少评委提示词指纹；无法确认 LLM 评分语义是否一致。',
      'Report is missing judge prompt fingerprint; LLM scoring semantics cannot be verified.',
    );
  }
  if (report.meta.judgeModel && !report.meta.judgeRuntime) {
    push(
      warnings,
      'judge_runtime_missing',
      '报告缺少评委 runtime 指纹；无法审计评委 executor 的 binary / SDK 版本。',
      'Report is missing judge runtime fingerprint; judge executor binary / SDK versions cannot be audited.',
    );
  } else if (report.meta.judgeRuntime) {
    pushRuntimeUnverifiable(warnings, 'judge_runtime_unverifiable', '评委', 'Judge', report.meta.judgeRuntime);
  }
  const judgeModels = sorted(report.meta.judgeModels);
  if (judgeModels.length >= 2) {
    if (!report.meta.judgeRuntimes) {
      push(
        warnings,
        'judge_runtime_missing',
        '报告缺少多评委 ensemble 的 runtime 指纹；无法审计每个评委 executor 的 binary / SDK 版本。',
        'Report is missing multi-judge ensemble runtime fingerprints; each judge executor binary / SDK version cannot be audited.',
      );
    } else {
      const missing = judgeModels.filter((model) => !report.meta.judgeRuntimes?.[model]);
      if (missing.length > 0) {
        push(
          warnings,
          'judge_runtime_missing',
          `多评委 ensemble 缺少 runtime 指纹: ${missing.join(', ')}。`,
          `Multi-judge ensemble is missing runtime fingerprints: ${missing.join(', ')}.`,
        );
      }
      for (const key of judgeModels) {
        pushRuntimeUnverifiable(warnings, 'judge_runtime_unverifiable', `评委 ${key}`, `Judge ${key}`, report.meta.judgeRuntimes[key]);
      }
    }
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
  const bExecutorRuntimeKeys = runtimeMapKeys(b);
  const aExecutorRuntimeKeys = runtimeMapKeys(a);
  const hasExecutorRuntimeMap = bExecutorRuntimeKeys.length > 0 || aExecutorRuntimeKeys.length > 0;
  if (hasExecutorRuntimeMap) {
    const keys = sorted([...new Set([...b.variants, ...a.variants, ...bExecutorRuntimeKeys, ...aExecutorRuntimeKeys])]);
    const missing = keys.filter((key) => !b.executorRuntimes?.[key] || !a.executorRuntimes?.[key]);
    if (missing.length > 0) {
      push(
        warnings,
        'executor_runtime_missing',
        `至少一份报告缺少 per-variant executor runtime 指纹: ${missing.join(', ')}。`,
        `At least one report is missing per-variant executor runtime fingerprints: ${missing.join(', ')}.`,
      );
    }
    for (const key of keys) {
      const beforeRuntime = b.executorRuntimes?.[key];
      const afterRuntime = a.executorRuntimes?.[key];
      if (beforeRuntime?.fingerprint && afterRuntime?.fingerprint && beforeRuntime.fingerprint !== afterRuntime.fingerprint) {
        push(
          warnings,
          'executor_runtime_mismatch',
          `variant ${key} executor runtime 指纹不同: ${runtimeLabel(beforeRuntime)} → ${runtimeLabel(afterRuntime)}。`,
          `Variant ${key} executor runtime fingerprint changed: ${runtimeLabel(beforeRuntime)} → ${runtimeLabel(afterRuntime)}.`,
        );
      }
      pushRuntimeUnverifiable(warnings, 'executor_runtime_unverifiable', `before variant ${key} executor`, `Before variant ${key} executor`, beforeRuntime);
      pushRuntimeUnverifiable(warnings, 'executor_runtime_unverifiable', `after variant ${key} executor`, `After variant ${key} executor`, afterRuntime);
    }
  } else if (b.executorRuntime?.fingerprint && a.executorRuntime?.fingerprint) {
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
  if (!hasExecutorRuntimeMap) {
    pushRuntimeUnverifiable(warnings, 'executor_runtime_unverifiable', 'before executor', 'Before executor', b.executorRuntime);
    pushRuntimeUnverifiable(warnings, 'executor_runtime_unverifiable', 'after executor', 'After executor', a.executorRuntime);
  }

  if ((b.judgeModel || a.judgeModel) && b.judgeModel !== a.judgeModel) {
    push(warnings, 'judge_model_mismatch', `评委模型不同: ${b.judgeModel ?? 'none'} → ${a.judgeModel ?? 'none'}。`, `Judge model changed: ${b.judgeModel ?? 'none'} → ${a.judgeModel ?? 'none'}.`);
  }
  const bJudgeModels = sorted(b.judgeModels);
  const aJudgeModels = sorted(a.judgeModels);
  const ensembleInEither = bJudgeModels.length > 0 || aJudgeModels.length > 0;
  if (ensembleInEither && stableStringify(bJudgeModels) !== stableStringify(aJudgeModels)) {
    push(
      warnings,
      'judge_models_mismatch',
      `多评委 ensemble 配置不同: ${bJudgeModels.join(', ') || 'none'} → ${aJudgeModels.join(', ') || 'none'}。`,
      `Multi-judge ensemble changed: ${bJudgeModels.join(', ') || 'none'} → ${aJudgeModels.join(', ') || 'none'}.`,
    );
  }
  if (effectiveJudgeRepeat(b) !== effectiveJudgeRepeat(a)) {
    push(
      warnings,
      'judge_repeat_mismatch',
      `每条用例评委评价次数不同: ${effectiveJudgeRepeat(b)} → ${effectiveJudgeRepeat(a)}。`,
      `Judge repeat count changed: ${effectiveJudgeRepeat(b)} → ${effectiveJudgeRepeat(a)}.`,
    );
  }

  if (ensembleInEither) {
    const keys = sorted([...new Set([...bJudgeModels, ...aJudgeModels])]);
    const missing = keys.filter((key) => !b.judgeRuntimes?.[key] || !a.judgeRuntimes?.[key]);
    if (missing.length > 0) {
      push(
        warnings,
        'judge_runtime_missing',
        `至少一份报告缺少多评委 runtime 指纹: ${missing.join(', ')}。`,
        `At least one report is missing multi-judge runtime fingerprints: ${missing.join(', ')}.`,
      );
    }
    for (const key of keys) {
      const beforeRuntime = b.judgeRuntimes?.[key];
      const afterRuntime = a.judgeRuntimes?.[key];
      if (beforeRuntime?.fingerprint && afterRuntime?.fingerprint && beforeRuntime.fingerprint !== afterRuntime.fingerprint) {
        push(
          warnings,
          'judge_runtime_mismatch',
          `评委 ${key} runtime 指纹不同: ${runtimeLabel(beforeRuntime)} → ${runtimeLabel(afterRuntime)}。`,
          `Judge ${key} runtime fingerprint changed: ${runtimeLabel(beforeRuntime)} → ${runtimeLabel(afterRuntime)}.`,
        );
      }
      pushRuntimeUnverifiable(warnings, 'judge_runtime_unverifiable', `before 评委 ${key}`, `Before judge ${key}`, beforeRuntime);
      pushRuntimeUnverifiable(warnings, 'judge_runtime_unverifiable', `after 评委 ${key}`, `After judge ${key}`, afterRuntime);
    }
  } else if (b.judgeRuntime?.fingerprint && a.judgeRuntime?.fingerprint) {
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
  if (!ensembleInEither) {
    pushRuntimeUnverifiable(warnings, 'judge_runtime_unverifiable', 'before 评委', 'Before judge', b.judgeRuntime);
    pushRuntimeUnverifiable(warnings, 'judge_runtime_unverifiable', 'after 评委', 'After judge', a.judgeRuntime);
  }

  if ((hasJudge(b) || hasJudge(a)) && (!b.judgePromptHash || !a.judgePromptHash)) {
    push(warnings, 'judge_prompt_hash_missing', `至少一份报告缺少评委提示词指纹: ${b.judgePromptHash ?? 'missing'} → ${a.judgePromptHash ?? 'missing'}。`, `At least one report is missing judge prompt hash: ${b.judgePromptHash ?? 'missing'} → ${a.judgePromptHash ?? 'missing'}.`);
  } else if ((b.judgePromptHash || a.judgePromptHash) && b.judgePromptHash !== a.judgePromptHash) {
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

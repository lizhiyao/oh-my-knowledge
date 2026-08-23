/**
 * preflight 阶段的结构性 / 隔离性警告。
 *
 * 两组互不相关的 warning,共用「执行前 stderr 提示,不是 verdict gate」的语义:
 *   - power: 基于 sample 数 / repeat 的硬底线(n<5 不可靠, n<20 仅能测大效应,
 *     repeat<2 无法测稳定性)。**不是 MDE / power analysis 预测** —— run 之前
 *     还没有 σ,预测「CI 半宽 ~ ±0.4」是手挥;真正的 power 判定在 post-hoc
 *     verdict(UNDERPOWERED state + saturation curve)
 *   - isolation: 用户显式 `--no-strict-baseline` 且存在没有显式隔离声明的
 *     baseline-kind variant，并且当前 executor 可发现的全局 / 项目 skill 根里有内容
 *     —— baseline 可能被外部 skill 污染，verdict / Δ 不可信。默认 strict 时不出 warn
 *
 * `buildXxxWarnings` 是纯函数,export 给单测断言文案语义;`emitXxxWarnings` 是
 * 写 stderr 的薄包装,只给 orchestrator 用。
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { Artifact } from '../../types/index.js';
import type { Lang } from '../../types/shared.js';
import { executorFamily } from '../../executors/registry.js';
import { tEvalWorkflowMessage } from '../messages.js';

export function buildPowerWarnings(sampleCount: number, repeat: number, lang: Lang = 'zh'): string[] {
  const warnings: string[] = [];
  if (sampleCount < 5) {
    warnings.push(tEvalWorkflowMessage('power_warning_tiny_n', lang, { n: sampleCount }));
  } else if (sampleCount < 20) {
    warnings.push(tEvalWorkflowMessage('power_warning_small_n', lang, { n: sampleCount }));
  }
  if (repeat < 2) {
    warnings.push(tEvalWorkflowMessage('power_warning_repeat_one', lang));
  }
  return warnings;
}

export function emitPowerWarnings(sampleCount: number, repeat: number, lang: Lang): void {
  for (const w of buildPowerWarnings(sampleCount, repeat, lang)) {
    process.stderr.write(`${w}\n`);
  }
}

export function buildIsolationWarnings(
  artifacts: Artifact[],
  strictBaseline: boolean | undefined,
  options: {
    executorName: string;
    lang?: Lang;
    homeDir?: string;
    cwd?: string;
  },
): string[] {
  // Only warn when user explicitly disabled isolation.
  if (strictBaseline !== false) return [];

  const hasUnisolatedBaseline = artifacts.some(
    (artifact) => artifact.kind === 'baseline' && artifact.allowedSkills === undefined,
  );
  if (!hasUnisolatedBaseline) return [];

  const executorName = options.executorName;
  const family = executorFamily(executorName);
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const roots = family === 'claude'
    ? [join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')]
    : family === 'codex'
      ? [
        join(home, '.agents', 'skills'),
        join(home, '.codex', 'skills'),
        join(cwd, '.agents', 'skills'),
        join(cwd, '.codex', 'skills'),
      ]
      : [
        join(home, '.agents', 'skills'),
        join(home, '.claude', 'skills'),
        join(home, '.codex', 'skills'),
        join(cwd, '.agents', 'skills'),
        join(cwd, '.claude', 'skills'),
        join(cwd, '.codex', 'skills'),
      ];
  const findings: Array<{ path: string; count: number }> = [];
  for (const skillsDir of [...new Set(roots)]) {
    if (!existsSync(skillsDir)) continue;
    try {
      const count = readdirSync(skillsDir)
        .filter((entry) => !entry.startsWith('.'))
        .length;
      if (count > 0) findings.push({ path: skillsDir, count });
    } catch {
      // An unreadable optional discovery root is not evidence of contamination.
    }
  }
  if (findings.length === 0) return [];
  const displayPath = (path: string): string => {
    const fromHome = relative(home, path);
    if (fromHome && !fromHome.startsWith('..')) return `~/${fromHome}`;
    const fromCwd = relative(cwd, path);
    return fromCwd && !fromCwd.startsWith('..') ? `./${fromCwd}` : path;
  };
  const locations = findings
    .map((finding) => `${displayPath(finding.path)} (${finding.count})`)
    .join(', ');
  const lang = options.lang ?? 'zh';

  return [
    lang === 'zh'
      ? `⚠ baseline 隔离已关闭（--no-strict-baseline）。检测到当前 ${executorName} 可发现的 skill：${locations}。baseline variant 可能被 auto-discovery 污染；除非你确认要这种比较，建议恢复默认 strict 模式。`
      : `⚠ Baseline isolation is disabled (--no-strict-baseline). Found skills discoverable by ${executorName}: ${locations}. The baseline variant may be contaminated by auto-discovery; restore strict mode unless this comparison is intentional.`,
  ];
}

export function emitIsolationWarnings(
  artifacts: Artifact[],
  strictBaseline: boolean | undefined,
  executorName: string,
  lang: Lang,
): void {
  for (const w of buildIsolationWarnings(artifacts, strictBaseline, { executorName, lang })) {
    process.stderr.write(`${w}\n`);
  }
}

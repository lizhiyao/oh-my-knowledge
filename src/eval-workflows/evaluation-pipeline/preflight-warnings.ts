/**
 * preflight 阶段的结构性 / 隔离性警告。
 *
 * 两组互不相关的 warning,共用「执行前 stderr 提示,不是 verdict gate」的语义:
 *   - power: 基于 sample 数 / repeat 的硬底线(n<5 不可靠, n<20 仅能测大效应,
 *     repeat<2 无法测稳定性)。**不是 MDE / power analysis 预测** —— run 之前
 *     还没有 σ,预测「CI 半宽 ~ ±0.4」是手挥;真正的 power 判定在 post-hoc
 *     verdict(UNDERPOWERED state + saturation curve)
 *   - isolation: 用户显式 `--no-strict-baseline` 且存在 baseline-kind variant 且
 *     `~/.claude/skills/` 里有内容 —— baseline 会被 SDK 全发现污染,verdict / Δ
 *     不可信。默认 strict 时不出 warn
 *
 * `buildXxxWarnings` 是纯函数,export 给单测断言文案语义;`emitXxxWarnings` 是
 * 写 stderr 的薄包装,只给 orchestrator 用。
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '../../types/index.js';
import type { Lang } from '../../types/shared.js';
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
): string[] {
  // Only warn when user explicitly disabled isolation.
  if (strictBaseline !== false) return [];

  const hasBaselineKind = artifacts.some((a) => a.kind === 'baseline');
  if (!hasBaselineKind) return [];

  // Check ~/.claude/skills/ for content (avoid hard-coding home — read at runtime).
  const skillsDir = join(homedir(), '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];

  let skillCount = 0;
  try {
    skillCount = readdirSync(skillsDir).filter((entry) => !entry.startsWith('.')).length;
  } catch {
    return [];
  }
  if (skillCount === 0) return [];

  return [
    `⚠ baseline 隔离已关闭(--no-strict-baseline)。检测到 ~/.claude/skills/ 内有 ${skillCount} 个 skill, baseline variant 可能被 auto-discovery 污染。除非你确认要这种比较,建议恢复默认 strict 模式。`,
  ];
}

export function emitIsolationWarnings(artifacts: Artifact[], strictBaseline: boolean | undefined): void {
  for (const w of buildIsolationWarnings(artifacts, strictBaseline)) {
    process.stderr.write(`${w}\n`);
  }
}

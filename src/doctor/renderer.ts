/**
 * omk doctor 输出渲染器。
 *
 * 双形态:
 *   - renderDoctorReportText: 终端友好,符号 + 标签 + 消息 + hint。stream 写到给定
 *     write 函数(默认 stderr,因为 doctor 用 --json 模式时 stdout 应该是结构化 JSON)。
 *   - renderDoctorReportJson: 直接 JSON.stringify。CI 消费。
 */

import { tCli, type CliLang } from '../cli/i18n.js';
import { CLI_DICT, type CliMessageKey } from './../cli/i18n-dict.js';
import type {
  DoctorReport,
  DoctorRuleResult,
  DoctorRuleStatus,
} from '../types/index.js';

const STATUS_SYMBOL: Record<DoctorRuleStatus, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  skipped: '⊙',
};

function statusLabel(status: DoctorRuleStatus, lang: CliLang): string {
  if (lang === 'zh') {
    return { pass: '通过', warn: '警告', fail: '失败', skipped: '跳过' }[status];
  }
  return { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' }[status];
}

function renderRuleLine(result: DoctorRuleResult, ruleLabel: string, lang: CliLang): string {
  const sym = STATUS_SYMBOL[result.status];
  const sLabel = statusLabel(result.status, lang);
  // 主行: ✓ [PASS] skill 文件可读 — skill 内容长度 28 字符
  let line = `  ${sym} [${sLabel}] ${ruleLabel} — ${result.message}`;
  if (result.hint) {
    line += `\n    💡 ${result.hint}`;
  }
  return line;
}

export function renderDoctorReportText(
  report: DoctorReport,
  lang: CliLang,
  write: (s: string) => void = (s) => process.stderr.write(s),
): void {
  const header = lang === 'zh'
    ? `omk doctor 健康检查 — ${report.cwd}`
    : `omk doctor health check — ${report.cwd}`;
  write(`\n${header}\n`);
  write('─'.repeat(Math.min(70, header.length + 10)) + '\n');

  if (report.skills.length === 0) {
    write(lang === 'zh' ? '\n未发现 skill。\n' : '\nNo skills found.\n');
    return;
  }

  for (const skill of report.skills) {
    write(`\n[${skill.skillName}] ${skill.skillPath}\n`);
    for (const result of skill.results) {
      const ruleLabel = renderRuleLabel(result, lang);
      write(renderRuleLine(result, ruleLabel, lang) + '\n');
    }
  }

  // 总览
  const summary = lang === 'zh'
    ? `\n总览: ${report.totals.pass} 通过 / ${report.totals.warn} 警告 / ${report.totals.fail} 失败\n`
    : `\nSummary: ${report.totals.pass} pass / ${report.totals.warn} warn / ${report.totals.fail} fail\n`;
  write(summary);
}

/** 用 result.labelKey 翻译 rule 标题。已知 i18n key 走 tCli; 自定义 rule 用未注册的
 *  key 时直接显示 ruleId 作为 fallback (而不是错挂到 skill_readable 的标题)。 */
function renderRuleLabel(result: DoctorRuleResult, lang: CliLang): string {
  const key = result.labelKey;
  // labelKey 是已注册的 CliMessageKey 时走 i18n; 否则 fallback 用 ruleId
  if (key in CLI_DICT) {
    return tCli(key as CliMessageKey, lang);
  }
  return result.ruleId;
}

export function renderDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

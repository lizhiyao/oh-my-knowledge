/**
 * omk doctor 输出渲染器。
 *
 * 双形态:
 *   - renderDoctorReportText: 终端友好,符号 + 标签 + 消息 + hint。stream 写到给定
 *     write 函数(默认 stderr,因为 doctor 用 --json 模式时 stdout 应该是结构化 JSON)。
 *   - renderDoctorReportJson: 直接 JSON.stringify。CI 消费。
 *
 * groupId 分组:由 ComposerRule 产出的多条 result 共享同一 groupId(= composer.id)。
 * renderer 按 groupId 把它们渲染成一个段落:先打 group header,再缩进打子项。
 * 普通 rule 不带 groupId,逐行渲染。
 */

import { DOCTOR_MESSAGES, tDoctorMessage, type DoctorMessageKey } from './messages.js';
import type { Lang } from '../types/shared.js';
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

/** 维度子项排序权重:fail 最先,warn 次,pass,skipped 最后。
 *  groupId 内部用,体现"问题严重的排前面"。 */
const STATUS_RANK: Record<DoctorRuleStatus, number> = {
  fail: 0, warn: 1, pass: 2, skipped: 3,
};

function statusLabel(status: DoctorRuleStatus, lang: Lang): string {
  if (lang === 'zh') {
    return { pass: '通过', warn: '警告', fail: '失败', skipped: '跳过' }[status];
  }
  return { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' }[status];
}

function renderRuleLabel(result: DoctorRuleResult, lang: Lang): string {
  const key = result.labelKey;
  if (key in DOCTOR_MESSAGES) return tDoctorMessage(key as DoctorMessageKey, lang);
  return result.ruleId;
}

function renderRuleLine(result: DoctorRuleResult, ruleLabel: string, lang: Lang, indent: string = '  '): string {
  const sym = STATUS_SYMBOL[result.status];
  const sLabel = statusLabel(result.status, lang);
  let line = `${indent}${sym} [${sLabel}] ${ruleLabel} — ${result.message}`;
  if (result.hint) {
    line += `\n${indent}  💡 ${result.hint}`;
  }
  return line;
}

/** 把 result 列表按 groupId 拆成段(普通 rule 段长度 1, composer 段长度 N+1)。
 *  保留原顺序:每个 group 在它第一条 result 出现的位置占位。 */
interface ResultSegment {
  groupId: string | null;
  results: DoctorRuleResult[];
}

function segmentResults(results: DoctorRuleResult[]): ResultSegment[] {
  const segs: ResultSegment[] = [];
  const groupSegMap = new Map<string, ResultSegment>();
  for (const r of results) {
    const gid = r.groupId ?? null;
    if (gid === null) {
      segs.push({ groupId: null, results: [r] });
      continue;
    }
    let seg = groupSegMap.get(gid);
    if (!seg) {
      seg = { groupId: gid, results: [] };
      groupSegMap.set(gid, seg);
      segs.push(seg);
    }
    seg.results.push(r);
  }
  return segs;
}

function renderGroupHeader(groupId: string, results: DoctorRuleResult[], lang: Lang): string {
  // group label 取首条 result 的 labelKey 翻译;但若有 _summary 子项,优先用它
  // 的 labelKey(eg. composer 主标题"健康度体检",而不是某维度名)。
  // 注意:第一条 result 通常是 7 个维度之一,labelKey 是维度名;summary 在末尾。
  const summaryRow = results.find((r) => r.ruleId.endsWith(':_summary'));
  const headerLabelResult = summaryRow ?? results[0];
  const label = renderRuleLabel(headerLabelResult, lang);
  // Group 整体 status 取最坏(fail > warn > pass > skipped)
  const worstStatus = results.reduce<DoctorRuleStatus>((acc, r) => {
    return STATUS_RANK[r.status] < STATUS_RANK[acc] ? r.status : acc;
  }, 'pass' as DoctorRuleStatus);
  const sym = STATUS_SYMBOL[worstStatus];
  const sLabel = statusLabel(worstStatus, lang);
  return `  ${sym} [${sLabel}] ━━ ${label} ━━ (${groupId})`;
}

function sortGroupResults(results: DoctorRuleResult[]): DoctorRuleResult[] {
  // _summary 永远放最后(信息性);其它按 status 严重度排序,fail 最先
  const summaryRows = results.filter((r) => r.ruleId.endsWith(':_summary'));
  const dimRows = results.filter((r) => !r.ruleId.endsWith(':_summary'));
  dimRows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  return [...dimRows, ...summaryRows];
}

export function renderDoctorReportText(
  report: DoctorReport,
  lang: Lang,
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
    const segments = segmentResults(skill.results);
    for (const seg of segments) {
      if (seg.groupId === null) {
        const r = seg.results[0];
        write(renderRuleLine(r, renderRuleLabel(r, lang), lang) + '\n');
        continue;
      }
      // ComposerRule group: header + 子项缩进展示
      write(renderGroupHeader(seg.groupId, seg.results, lang) + '\n');
      const sorted = sortGroupResults(seg.results);
      for (const r of sorted) {
        write(renderRuleLine(r, renderRuleLabel(r, lang), lang, '      ') + '\n');
      }
    }
  }

  const summary = lang === 'zh'
    ? `\n总览: ${report.totals.pass} 通过 / ${report.totals.warn} 警告 / ${report.totals.fail} 失败\n`
    : `\nSummary: ${report.totals.pass} pass / ${report.totals.warn} warn / ${report.totals.fail} fail\n`;
  write(summary);
}

export function renderDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

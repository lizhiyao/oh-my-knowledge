import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderReportDocumentDetail, renderTrendsPage } from '../renderer/html-renderer.js';
import { renderSkillHealthReport } from '../renderer/skill-health-renderer.js';
import { DEFAULT_LANG, t, layout, e } from '../renderer/layout.js';
import type { Lang } from '../types/index.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from './job-store.js';
import { createFileStore, queryJob, queryJobList, queryRun, queryRunList, queryTrend } from './report-store.js';
import type { JobStore, ReportStore } from '../types/index.js';
import type { SkillHealthReport } from '../observability/skill-health-analyzer.js';
import { DEFAULT_OBSERVATIONS_DIR, loadObservationInboxReports, queryObservationInbox, severityReasonFor } from '../observability/inbox.js';
import type { ObservationInboxItem } from '../observability/inbox.js';
import type { AddressInfo } from 'node:net';

const DEFAULT_PORT = 7799;
const PORT_HINT = `OMK_REPORT_PORT=${DEFAULT_PORT} omk eval ...`;
const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');
const DEFAULT_ANALYSES_DIR = join(homedir(), '.oh-my-knowledge', 'analyses');

interface ReportServerOptions {
  port?: number;
  reportsDir?: string;
  analysesDir?: string;
  observationsDir?: string;
  jobsDir?: string;
  store?: ReportStore;
  jobStore?: JobStore;
}

function renderObservationInboxPage(observationsDir: string, lang: Lang = DEFAULT_LANG): string {
  const allItems = queryObservationInbox(observationsDir);
  const items = allItems.slice(0, 100);
  const reports = loadObservationInboxReports(observationsDir);
  const skillInvocationCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillInvocationCounts ?? {})) {
      acc[skill] = (acc[skill] ?? 0) + count;
    }
    return acc;
  }, {} as Record<string, number>);
  const skillSessionCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillSessionCounts ?? {})) {
      acc[skill] = (acc[skill] ?? 0) + count;
    }
    return acc;
  }, {} as Record<string, number>);
  const totalSkillInvocations = Object.values(skillInvocationCounts).reduce((sum, count) => sum + count, 0);
  const countSkillsBySeverity = (...severities: ObservationInboxItem['severity'][]): number =>
    new Set(allItems.filter((item) => severities.includes(item.severity)).map((item) => item.skillName)).size;
  const severitySkillCounts = {
    high: countSkillsBySeverity('high'),
    medium: countSkillsBySeverity('medium'),
    low: countSkillsBySeverity('low'),
    noise: countSkillsBySeverity('noise'),
  };
  const skillCount = new Set(allItems.map((item) => item.skillName)).size;
  const latestSeen = allItems.reduce((latest, item) => item.lastSeen > latest ? item.lastSeen : latest, '');
  const reportCount = reports.length;
  const latestSeenLabel = latestSeen ? latestSeen.slice(0, 19).replace('T', ' ') : '—';
  const renderJson = (value: unknown): string =>
    `<pre style="margin:8px 0 0;padding:10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;max-height:520px;overflow:auto;text-align:left">${e(JSON.stringify(value, null, 2))}</pre>`;
  const renderField = (label: string, value: unknown): string => {
    if (value == null || value === '') return '';
    return `<div style="margin:4px 0;text-align:left"><span style="color:var(--text-muted);font-size:11px">${e(label)}</span><div style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;text-align:left;color:var(--text-secondary)">${e(String(value))}</div></div>`;
  };
  const renderArtifactVersion = (value: string): string => {
    if (value === 'unknown') {
      return `<div style="margin:4px 0;text-align:left"><span style="color:var(--text-muted);font-size:11px">artifactVersion</span><div style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;color:var(--yellow);font-weight:600;text-align:left">⚠ unknown</div></div>`;
    }
    return renderField('artifactVersion', value);
  };
  const reviewSeverityMeta = (item: ObservationInboxItem): { label: string; decision: string; color: string; bg: string } => {
    if (item.severity === 'high') {
      return { label: '可能要改 skill', decision: '优先看，可能要补 SKILL.md 或改 skill 说明', color: 'var(--red)', bg: 'rgba(220,38,38,.08)' };
    }
    if (item.severity === 'medium') {
      return { label: '一般不用改 skill', decision: '通常是 agent 在试目录或路径，确认不是 skill 漏写即可', color: 'var(--yellow)', bg: 'rgba(202,138,4,.10)' };
    }
    if (item.severity === 'low') {
      return { label: '先低优先级确认', decision: '模型只是说不确定，不一定需要改 skill', color: 'var(--accent)', bg: 'rgba(37,99,235,.08)' };
    }
    return { label: '一般不用改 skill', decision: '更像路径、权限、文件太大或工具限制；先不当成 skill 内容缺失', color: 'var(--text-muted)', bg: 'var(--bg-muted)' };
  };
  const renderSeverityBadge = (item: ObservationInboxItem): string => {
    const meta = reviewSeverityMeta(item);
    return `<div style="display:flex;flex-direction:column;gap:3px">
      <span style="display:inline-flex;align-items:center;width:max-content;max-width:190px;padding:3px 7px;border-radius:999px;background:${meta.bg};color:${meta.color};font-weight:650;white-space:normal">${e(meta.label)}</span>
      <span style="color:var(--text-muted);font-size:11px">${e(meta.decision)}</span>
    </div>`;
  };
  const semanticEvidence = (item: ObservationInboxItem): string => {
    const tool = item.evidence.tool || 'Tool';
    const target = item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || '';
    if (item.signalSubtype === 'tool_limit') return `${tool} 触发工具限制：${item.evidence.outputSnippet || target}`;
    if (item.signalSubtype === 'not_found') return `${tool} 访问了不存在的路径：${item.evidence.path || target}`;
    if (item.signalSubtype === 'permission_denied') return `${tool} 被权限拒绝：${item.evidence.path || target}`;
    if (item.signalSubtype === 'bash_probe') return `skill 运行过程中，agent 调用了一条 Bash 命令：${item.evidence.query || target}`;
    if (item.signalSubtype === 'hard_miss') return `${tool} 未命中且后续未找到同主题成功证据：${target}`;
    if (item.signalSubtype === 'exploratory_miss') return `${tool} 前序未命中，但后续有成功搜索证据：${target}`;
    return target || item.evidence.outputSnippet || '';
  };
  const evidenceConclusion = (item: ObservationInboxItem): string => {
    if (item.signalSubtype === 'bash_probe') return 'skill 运行过程中，agent 调用了一条 Bash 命令。';
    if (item.signalSubtype === 'tool_limit') return `${item.evidence.tool || '工具'} 触发了文件太长、token 或超时限制。`;
    if (item.signalSubtype === 'not_found') return `${item.evidence.tool || '工具'} 访问了不存在的路径。`;
    if (item.signalSubtype === 'permission_denied') return `${item.evidence.tool || '工具'} 被权限拒绝。`;
    if (item.signalSubtype === 'hard_miss') return `${item.evidence.tool || '工具'} 没有拿到有效结果，后续也没有看到同主题成功证据。`;
    if (item.signalSubtype === 'exploratory_miss') return `${item.evidence.tool || '工具'} 前面没有拿到结果，但后续找到了相关内容。`;
    if (item.signalType === 'hedging') return '模型文本里出现了不确定表达。';
    if (item.signalType === 'explicit_marker') return '模型文本里出现了显式标记。';
    return semanticEvidence(item);
  };
  const evidenceQuote = (item: ObservationInboxItem): string => {
    return item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || item.evidence.outputSnippet || '';
  };
  const quoteFromEvidence = (evidence: ObservationInboxItem['evidence']): string =>
    evidence.query || evidence.path || evidence.assistantSnippet || evidence.outputSnippet || '';
  const renderEvidenceDetailList = (item: ObservationInboxItem): string => {
    const entries = item.representativeEvidence.length > 0 ? item.representativeEvidence : [item.evidence];
    return `<div style="display:flex;flex-direction:column;gap:8px">
      ${entries.map((ev, i) => {
        const quote = quoteFromEvidence(ev);
        const output = ev.outputSnippet && ev.outputSnippet !== quote ? ev.outputSnippet : '';
        return `<div style="padding:9px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);text-align:left">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:5px">
            <span style="font-size:12px;color:var(--text-primary);font-weight:650">Evidence ${i + 1}</span>
            <span style="font-size:11px;color:var(--text-muted);font-family:ui-monospace,monospace">${e(ev.tool || item.signalType)}${ev.markerToken ? ` · ${e(ev.markerToken)}` : ''}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.45;margin-bottom:5px">${e(evidenceConclusion({ ...item, evidence: ev }))}</div>
          ${quote ? `<pre style="margin:0;padding:8px;background:var(--bg-muted);border-radius:5px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45;color:var(--text-primary);max-height:180px;overflow:auto">${e(quote)}</pre>` : ''}
          ${output ? `<div style="margin-top:6px;color:var(--text-muted);font-size:11px">输出片段</div><pre style="margin:3px 0 0;padding:8px;background:var(--bg-muted);border-radius:5px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45;color:var(--text-secondary);max-height:140px;overflow:auto">${e(output)}</pre>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  };
  const renderEvidenceCell = (item: ObservationInboxItem, max = 220): string => {
    const quote = evidenceQuote(item);
    return `<div style="max-width:360px">
      <div style="font-size:12px;line-height:1.45;color:var(--text-primary)">${e(evidenceConclusion(item))}</div>
      ${quote ? `<code style="display:block;margin-top:5px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--bg-muted);padding:4px 6px;border-radius:4px">${e(quote.slice(0, max))}</code>` : ''}
    </div>`;
  };
  const signalRuleDescription = (item: ObservationInboxItem): string => {
    const reason = item.severityReason ?? severityReasonFor(item);
    const meta = reviewSeverityMeta(item);
    const prefix = `${meta.label}: ${item.signalType}/${item.signalSubtype}, confidence=${item.confidence.toFixed(2)}.`;
    return `${prefix} ${reason}`;
  };
  const renderSignalLabel = (item: ObservationInboxItem): string => {
    const desc = signalRuleDescription(item);
    return `<span style="position:relative;display:inline-flex;align-items:center;gap:4px;overflow:visible">
      <span>${e(item.signalType)}</span>
      <span class="signal-help" tabindex="0" data-signal-title="${e(`${item.signalType}/${item.signalSubtype}`)}" data-signal-description="${e(desc)}" aria-label="${e(desc)}" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:1px solid var(--border);border-radius:50%;font-size:10px;line-height:15px;color:var(--text-muted);cursor:help;vertical-align:top">?</span>
    </span><br><span style="color:var(--text-muted);font-size:11px">OMK subtype: ${e(item.signalSubtype)}</span>`;
  };
  const renderOccurrences = (item: ObservationInboxItem): string => {
    const text = `出现次数=${item.occurrences}。这是按 skill + cwd + signal + subtype + query/path 归一化去重后的聚合次数，不是样本量。`;
    return `<div style="text-align:right">
      <div style="font-weight:700">${item.occurrences}</div>
      <div title="${e(text)}" style="color:var(--text-muted);font-size:11px;line-height:1.35;max-width:92px;margin-left:auto">同类事件次数</div>
    </div>`;
  };
  const renderSourceBadge = (item: ObservationInboxItem): string => {
    const label = item.sourceKind === 'openclaw' ? 'OpenClaw' : item.sourceKind === 'claude' ? 'Claude' : 'Unknown';
    const color = item.sourceKind === 'openclaw' ? 'var(--green)' : item.sourceKind === 'claude' ? 'var(--accent)' : 'var(--text-muted)';
    return `<span title="调用日志来源：${e(label)}" style="display:inline-flex;width:max-content;margin-top:4px;padding:2px 6px;border-radius:999px;background:var(--bg-muted);color:${color};font-size:11px;font-weight:650">${e(label)}</span>`;
  };
  const confidenceHeaderHelp = '判断把握：OMK 对“这条 observation 是否需要处理/是否可能要改 skill”的规则判断有多确定。归属把握：OMK 把这条 observation 归到当前 skill 名下有多确定，例如明确调用 skill 通常更高。';
  const renderConfidenceHeader = (padding = '8px 10px', border = '1px solid var(--border)'): string =>
    `<th style="text-align:right;padding:${padding};border-bottom:${border}">
      判断把握 / 归属把握
      <span class="signal-help" tabindex="0" data-signal-title="判断把握 / 归属把握" data-signal-description="${e(confidenceHeaderHelp)}" aria-label="${e(confidenceHeaderHelp)}" style="display:inline-flex;align-items:center;justify-content:center;margin-left:4px;width:15px;height:15px;border:1px solid var(--border);border-radius:50%;font-size:10px;line-height:15px;color:var(--text-muted);cursor:help;vertical-align:middle">?</span>
    </th>`;
  const renderReviewRows = (groupItems: ObservationInboxItem[], idPrefix: string): string => groupItems.map((item, index) => {
    const evidence = semanticEvidence(item);
    const detailsId = `${idPrefix}-detail-${index}`;
    const searchText = [item.severity, item.sourceKind, item.skillName, item.signalType, item.signalSubtype, evidence, item.cwd, item.sourceTrace].join(' ').toLowerCase();
    return `<tr data-observe-row="review" data-severity="${e(item.severity)}" data-search="${e(searchText)}" data-detail-id="${detailsId}">
      <td style="padding:8px 10px;min-width:180px">${renderSeverityBadge(item)}${renderSourceBadge(item)}</td>
      <td style="padding:8px 10px">${renderSignalLabel(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${renderOccurrences(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${item.confidence.toFixed(2)} / ${item.attributionConfidence.toFixed(2)}</td>
      <td style="padding:8px 10px;color:var(--text-muted);font-size:12px">${item.lastSeen.slice(0, 19).replace('T', ' ')}</td>
      <td style="padding:8px 10px">${renderEvidenceCell(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right"><button type="button" onclick="toggleObservationDetail('${detailsId}', this)" style="font-size:12px;padding:4px 8px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer">${lang === 'zh' ? '展开' : 'Details'}</button></td>
    </tr>
    <tr id="${detailsId}" data-observe-detail-for="${detailsId}" style="display:none;background:var(--bg-muted)">
      <td colspan="7" style="padding:14px 18px;border-bottom:1px solid var(--border);text-align:left">
        <div style="display:grid;grid-template-columns:minmax(0,0.75fr) minmax(0,1.55fr);gap:18px;align-items:start;max-width:100%;overflow:hidden">
          <section style="text-align:left;font-size:11px;color:var(--text-muted);min-width:0">
            <h3 style="font-size:12px;margin:0 0 8px;color:var(--text-secondary)">这条记录的来源和判断依据</h3>
            ${renderField('id', item.id)}
            ${renderField('sourceTrace', item.sourceTrace)}
            ${renderField('sourceKind', item.sourceKind)}
            ${renderField('sessionId', item.sessionId)}
            ${renderField('cwd', item.cwd)}
            ${renderArtifactVersion(item.artifactVersion)}
            ${renderField('signalRule', signalRuleDescription(item))}
            ${renderField('signalMeaning', `原始信号=${item.signalType}；OMK 判断出的失败原因=${item.signalSubtype}。例如 failed_search 表示工具搜索/读取失败，bash_probe/not_found/tool_limit 是 OMK 根据命令和输出内容进一步判断出来的原因。`)}
            ${renderField('occurrencesMeaning', `出现次数=${item.occurrences}；按 skill/cwd/signal/subtype/query/path 聚合去重后的同类事件数量。`)}
            ${renderField('reviewDecision', reviewSeverityMeta(item).decision)}
            ${renderField('firstSeen', item.firstSeen)}
            ${renderField('lastSeen', item.lastSeen)}
            ${renderField('recentSessionIds', item.recentSessionIds.join(', '))}
          </section>
          <section style="text-align:left;min-width:0">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">Evidence 明细</h3>
            <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">这里展示这条聚合记录下面的原始明细。列表里每一条都是一次真实命中的证据；上方表格只展示第一条摘要。</div>
            ${renderEvidenceDetailList(item)}
            <details style="margin-top:10px">
              <summary style="cursor:pointer;color:var(--text-muted);font-size:12px">查看原始 JSON</summary>
              ${renderJson({ evidence: item.evidence, representativeEvidence: item.representativeEvidence })}
            </details>
          </section>
        </div>
      </td>
    </tr>`;
  }).join('');
  const skillGroups = Array.from(items.reduce((map, item) => {
    const existing = map.get(item.skillName) ?? [];
    existing.push(item);
    map.set(item.skillName, existing);
    return map;
  }, new Map<string, ObservationInboxItem[]>()).entries())
    .sort((a, b) => {
      const aHigh = a[1].filter((item) => item.severity === 'high').length;
      const bHigh = b[1].filter((item) => item.severity === 'high').length;
      if (bHigh !== aHigh) return bHigh - aHigh;
      return b[1].length - a[1].length;
    });
  const severityOrder: Array<ObservationInboxItem['severity']> = ['high', 'medium', 'low', 'noise'];
  const severityHeading: Record<ObservationInboxItem['severity'], string> = {
    high: '可能要改 skill',
    medium: '一般不用改 skill',
    low: '先低优先级确认',
    noise: '一般不用改 skill',
  };
  const severityHeadingZh: Record<ObservationInboxItem['severity'], string> = {
    high: '需要优先看',
    medium: '多半只是试路径',
    low: '模型说不确定',
    noise: '路径/权限/工具限制',
  };
  const skillSections = skillGroups.map(([skillName, groupItems], groupIndex) => {
    const counts = {
      high: groupItems.filter((item) => item.severity === 'high').length,
      medium: groupItems.filter((item) => item.severity === 'medium').length,
      low: groupItems.filter((item) => item.severity === 'low').length,
      noise: groupItems.filter((item) => item.severity === 'noise').length,
    };
    const latest = groupItems.reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
    const invocationCount = skillInvocationCounts[skillName] ?? groupItems.reduce((sum, item) => sum + item.occurrences, 0);
    const sessionCount = skillSessionCounts[skillName] ?? new Set(groupItems.flatMap((item) => item.recentSessionIds)).size;
    const sourceKinds = Array.from(new Set(groupItems.map((item) => item.sourceKind))).sort();
    const searchText = groupItems.map((item) => [item.sourceKind, item.skillName, item.signalType, item.signalSubtype, semanticEvidence(item), item.cwd, item.sourceTrace].join(' ')).join(' ').toLowerCase();
    const buckets = severityOrder.map((severity) => {
      const bucketItems = groupItems.filter((item) => item.severity === severity);
      if (bucketItems.length === 0) return '';
      return `<section data-observe-skill-bucket="${e(severity)}" style="margin-top:12px">
        <h3 style="font-size:13px;margin:0 0 6px;color:var(--text-primary)">${e(severityHeading[severity])} <span style="color:var(--text-muted);font-weight:400">/ ${e(severityHeadingZh[severity])} (${bucketItems.length})</span></h3>
        <div style="width:100%;overflow-x:auto;overflow-y:visible">
        <table style="border-collapse:collapse;width:100%;min-width:940px;font-size:13px;table-layout:fixed">
          <colgroup>
            <col style="width:190px">
            <col style="width:160px">
            <col style="width:96px">
            <col style="width:126px">
            <col style="width:132px">
            <col style="width:auto">
            <col style="width:82px">
          </colgroup>
          <thead><tr>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Severity</th>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Signal</th>
            <th style="text-align:right;padding:8px 10px;border-bottom:1px solid var(--border)">出现次数<br><span style="color:var(--text-muted);font-weight:400;font-size:11px">dedup 后同类事件</span></th>
            ${renderConfidenceHeader()}
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Last seen</th>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Evidence</th>
            <th style="text-align:right;padding:8px 10px;border-bottom:1px solid var(--border)">Review</th>
          </tr></thead>
          <tbody>${renderReviewRows(bucketItems, `obs-skill-${groupIndex}-${severity}`)}</tbody>
        </table>
        </div>
      </section>`;
    }).join('');
    return `<details data-observe-skill-group data-search="${e(searchText)}" open style="margin-top:14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:visible">
      <summary style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;cursor:pointer;list-style:none">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-family:ui-monospace,monospace;font-size:14px;font-weight:700">${e(skillName)}</span>
            <span title="这个 skill 在当前 trace 里被归因/触发的次数" style="padding:2px 7px;border-radius:999px;background:var(--info-bg);color:var(--accent);font-size:12px;font-weight:650">调用 ${invocationCount} 次</span>
          </div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:3px">${groupItems.length} observations · ${sessionCount} sessions · source ${e(sourceKinds.join(', '))} · latest ${e(latest.slice(0, 19).replace('T', ' '))}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <span title="可能要改 skill：优先看，可能需要补 SKILL.md 或改 skill 说明" style="padding:3px 7px;border-radius:999px;background:rgba(220,38,38,.08);color:var(--red);font-size:12px">可能要改 skill ${counts.high}</span>
          <span title="一般不用改 skill：一般是 agent 在试目录或路径，确认不是 skill 漏写即可" style="padding:3px 7px;border-radius:999px;background:rgba(202,138,4,.10);color:var(--yellow);font-size:12px">试路径失败 ${counts.medium}</span>
          <span title="先低优先级确认：模型只是说不确定，不一定需要改 skill" style="padding:3px 7px;border-radius:999px;background:rgba(37,99,235,.08);color:var(--accent);font-size:12px">说不确定 ${counts.low}</span>
          <span title="一般不用改 skill：更像文件不存在、文件太大、权限或工具限制" style="padding:3px 7px;border-radius:999px;background:var(--bg-muted);color:var(--text-muted);font-size:12px">路径/工具问题 ${counts.noise}</span>
        </div>
      </summary>
      <div style="padding:0 14px 14px">${buckets}</div>
    </details>`;
  }).join('');
  const rawRows = reports.flatMap((report, reportIndex) => report.items.map((item, itemIndex) => {
    const rawId = `obs-raw-${reportIndex}-${itemIndex}`;
    const color = item.severity === 'high' ? 'var(--red)' : item.severity === 'medium' ? 'var(--yellow)' : item.severity === 'noise' ? 'var(--text-muted)' : 'var(--accent)';
    return `<tr>
      <td style="padding:8px 10px;color:${color};font-weight:600">${item.severity}</td>
      <td style="padding:8px 10px">${renderSignalLabel(item)}</td>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${item.skillName}</td>
      <td style="padding:8px 10px">${renderSourceBadge(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${item.confidence.toFixed(2)} / ${item.attributionConfidence.toFixed(2)}</td>
      <td style="padding:8px 10px">${renderEvidenceCell(item, 180)}</td>
      <td class="num" style="padding:8px 10px;text-align:right"><button type="button" onclick="toggleObservationDetail('${rawId}', this)" style="font-size:12px;padding:4px 8px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer">${lang === 'zh' ? '原始 JSON' : 'Raw JSON'}</button></td>
    </tr>
    <tr id="${rawId}" style="display:none;background:var(--bg-muted)">
      <td colspan="7" style="padding:14px 18px;border-bottom:1px solid var(--border);text-align:left">
        ${renderJson(item)}
      </td>
    </tr>`;
  })).join('');
  const rawReportBlocks = reports.map((report, index) => `
    <section style="margin-top:18px">
      <h3 style="font-size:14px;margin:0 0 8px;color:var(--text-primary)">Observation JSON ${index + 1}</h3>
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
        tracePath=${e(report.meta.tracePath)} · generatedAt=${e(report.meta.generatedAt)} · segments=${report.meta.segmentCount} · items=${report.meta.itemCount}
      </div>
      ${renderJson(report)}
    </section>
  `).join('');
  const empty = items.length === 0
    ? `<p style="color:var(--text-muted);margin-top:24px">${lang === 'zh' ? '暂无 inbox item。运行 omk observe ingest <sessions-dir> 生成。' : 'No inbox items. Run omk observe ingest <sessions-dir> first.'}</p>`
    : '';
  return layout('Observe Inbox', `
    <main style="max-width:1120px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/analyses" style="color:var(--accent);text-decoration:none">${lang === 'zh' ? 'Skill 健康度日报' : 'Skill health reports'}</a></nav>
      <h1 style="font-size:22px;margin:8px 0">Observe Inbox</h1>
      <p style="color:var(--text-muted);font-size:13px">真实 session trace 中聚合出的待 review 问题。判断把握表示这条 observation 的规则判断有多确定；归属把握表示它归到当前 skill 名下有多确定。</p>
      <style>
        #signal-global-tooltip {
          position: fixed;
          z-index: 9999;
          display: none;
          width: min(360px, calc(100vw - 32px));
          padding: 10px 12px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          box-shadow: 0 8px 24px rgba(0,0,0,.18);
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.5;
          white-space: normal;
          pointer-events: none;
          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
        }
        #observe-tab-review table td,
        #observe-tab-review table th,
        #observe-tab-raw table td,
        #observe-tab-raw table th {
          vertical-align: top;
        }
        #observe-tab-review table td,
        #observe-tab-raw table td {
          text-align: left;
        }
        #observe-tab-review table td.num,
        #observe-tab-raw table td.num {
          text-align: right;
        }
      </style>
      <div id="signal-global-tooltip" role="tooltip"></div>
      ${empty}
      <section style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px">
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">需要优先 review</div>
          <div style="font-size:24px;font-weight:700;color:var(--red);margin-top:4px">${severitySkillCounts.high}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 可能要改</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">一般不用改 skill</div>
          <div style="font-size:24px;font-weight:700;color:var(--yellow);margin-top:4px">${countSkillsBySeverity('medium', 'low')}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 只有试路径失败 / 说不确定</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">一般不用改 skill</div>
          <div style="font-size:24px;font-weight:700;color:var(--text-muted);margin-top:4px">${severitySkillCounts.noise}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 有路径/权限/工具问题</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">数据范围</div>
          <div style="font-size:18px;font-weight:700;margin-top:6px">${skillCount} skills</div>
          <div style="color:var(--text-muted);font-size:12px">${totalSkillInvocations} skill 调用 · ${allItems.length} observations</div>
          <div style="color:var(--text-muted);font-size:12px">${reportCount} reports · latest ${e(latestSeenLabel)}</div>
        </div>
      </section>
      <section style="margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);font-size:13px;line-height:1.6">
        <strong>Reviewer path:</strong>
        先看 <span style="color:var(--red);font-weight:650">可能要改 skill</span>；
        “试路径失败”一般只是 agent 在试目录或路径；
        “路径/工具问题”一般先不用改 skill。
        展开行看判断原因和原始 evidence，必要时到 Observation JSON / 打标 tab 查完整结构。
        <div style="margin-top:6px;color:var(--text-muted)">
          Signal 列第一行是原始信号类型，例如 failed_search；第二行是 OMK 判断出的失败原因，例如 bash_probe 表示 Bash 命令看起来只是在试目录或路径。
          “出现次数”表示这类问题 dedup 后累计出现了几次。
        </div>
        <button type="button" onclick="toggleScoringGuide(this)" style="margin-top:10px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer;font-size:12px">查看判断标准</button>
        <div id="observe-scoring-guide" style="display:none;margin-top:10px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);text-align:left">
          <div style="font-weight:700;margin-bottom:8px">判断漏斗</div>
          <ol style="margin:0 0 10px 18px;padding:0">
            <li>先看发生了什么：工具查找、读取、Bash 命令、模型文本里是否出现失败或不确定。</li>
            <li>再看为什么失败：文件太长、路径不存在、Bash 只是试目录、后续是否又找到了结果。</li>
            <li>最后看要不要改 skill：只有像 skill 没写清楚、没覆盖路径/流程时，才进入“可能要改 skill”。</li>
          </ol>
          <table style="border-collapse:collapse;width:100%;font-size:12px">
            <thead><tr>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">页面判断</th>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">规则来源</th>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">怎么处理</th>
            </tr></thead>
            <tbody>
              <tr>
                <td style="padding:7px 8px;color:var(--red);font-weight:650">可能要改 skill</td>
                <td style="padding:7px 8px">hard_miss、repeated_failure、明确标了未知/缺口。通常表示查找失败后，没有看到后续找到同主题结果。</td>
                <td style="padding:7px 8px">优先看。确认 skill 是否漏了入口、路径、流程、约束或常见问题。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--yellow);font-weight:650">一般不用改 skill：试路径失败</td>
                <td style="padding:7px 8px">Bash 里有 ls/find、2&gt;/dev/null、|| true 等试目录/试路径写法，或前面没找到但后面又找到了。</td>
                <td style="padding:7px 8px">通常略过。只有反复发生且明显浪费时间时，再考虑给 skill 补“推荐查找路径”。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--accent);font-weight:650">先低优先级确认</td>
                <td style="padding:7px 8px">模型文本里说“不确定/需要确认”等，但没有强工具证据。</td>
                <td style="padding:7px 8px">低优先级看。只有它影响最终答案时，才考虑改 skill。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--text-muted);font-weight:650">一般不用改 skill：路径/工具问题</td>
                <td style="padding:7px 8px">文件不存在、文件太长、权限失败、工具调用失败或超时。</td>
                <td style="padding:7px 8px">通常不是 skill 内容缺失。先看环境、路径、权限、文件大小或工具调用方式。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px">
        <input id="observe-filter-input" type="search" placeholder="Filter skill / signal / evidence / path" style="flex:1;min-width:260px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text-primary);font-size:13px">
        <button type="button" data-severity-filter="all" onclick="setObserveSeverityFilter('all')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);cursor:pointer">All</button>
        <button type="button" data-severity-filter="high" onclick="setObserveSeverityFilter('high')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">可能要改 skill</button>
        <button type="button" data-severity-filter="medium" onclick="setObserveSeverityFilter('medium')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">试路径失败</button>
        <button type="button" data-severity-filter="noise" onclick="setObserveSeverityFilter('noise')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">路径/工具问题</button>
      </section>
      <div style="display:flex;gap:8px;margin-top:18px;border-bottom:1px solid var(--border)">
        <button type="button" data-observe-tab-button="review" onclick="showObservationTab('review')" style="font-size:13px;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background:var(--bg-surface);border-radius:6px 6px 0 0;cursor:pointer">${lang === 'zh' ? 'Inbox Review' : 'Inbox Review'}</button>
        <button type="button" data-observe-tab-button="raw" onclick="showObservationTab('raw')" style="font-size:13px;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background:var(--bg);border-radius:6px 6px 0 0;cursor:pointer">${lang === 'zh' ? 'Observation JSON / 打标' : 'Observation JSON / Tags'}</button>
      </div>
      <section id="observe-tab-review" style="margin-top:4px">
        ${items.length > 0 ? skillSections : ''}
      </section>
      <section id="observe-tab-raw" style="display:none">
        <p style="color:var(--text-muted);font-size:13px;margin:16px 0 8px">这里展示 observation JSON 文件里的原始结构，以及已经计算出的 severity / signal / subtype / confidence / attributionConfidence 等分类打标。</p>
        ${reports.length > 0 ? `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
          <thead><tr>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Severity</th>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Signal</th>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Skill</th>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Source</th>
            ${renderConfidenceHeader('10px', '2px solid var(--border)')}
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Evidence</th>
            <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border)">JSON</th>
          </tr></thead>
          <tbody>${rawRows}</tbody>
        </table>${rawReportBlocks}` : `<p style="color:var(--text-muted);margin-top:24px">${lang === 'zh' ? '暂无 observation JSON。' : 'No observation JSON yet.'}</p>`}
      </section>
      <script>
        var observeSeverityFilter = 'all';
        function showObservationTab(name) {
          var review = document.getElementById('observe-tab-review');
          var raw = document.getElementById('observe-tab-raw');
          if (review) review.style.display = name === 'review' ? '' : 'none';
          if (raw) raw.style.display = name === 'raw' ? '' : 'none';
          var buttons = document.querySelectorAll('[data-observe-tab-button]');
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-observe-tab-button') === name;
            buttons[i].style.background = active ? 'var(--bg-surface)' : 'var(--bg)';
            buttons[i].style.fontWeight = active ? '600' : '400';
          }
        }
        function toggleObservationDetail(id, btn) {
          var row = document.getElementById(id);
          if (!row) return;
          var open = row.style.display !== 'none';
          row.style.display = open ? 'none' : 'table-row';
          if (btn) btn.textContent = open ? '${lang === 'zh' ? '展开' : 'Details'}' : '${lang === 'zh' ? '收起' : 'Hide'}';
        }
        function toggleScoringGuide(btn) {
          var guide = document.getElementById('observe-scoring-guide');
          if (!guide) return;
          var open = guide.style.display !== 'none';
          guide.style.display = open ? 'none' : 'block';
          if (btn) btn.textContent = open ? '查看判断标准' : '收起判断标准';
        }
        function setObserveSeverityFilter(value) {
          observeSeverityFilter = value;
          var buttons = document.querySelectorAll('[data-severity-filter]');
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-severity-filter') === value;
            buttons[i].style.background = active ? 'var(--bg-surface)' : 'var(--bg)';
            buttons[i].style.fontWeight = active ? '650' : '400';
          }
          applyObserveFilters();
        }
        function applyObserveFilters() {
          var input = document.getElementById('observe-filter-input');
          var query = input ? String(input.value || '').toLowerCase().trim() : '';
          var rows = document.querySelectorAll('[data-observe-row="review"]');
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var severity = row.getAttribute('data-severity') || '';
            var search = row.getAttribute('data-search') || '';
            var detailId = row.getAttribute('data-detail-id');
            var detail = detailId ? document.querySelector('[data-observe-detail-for="' + detailId + '"]') : null;
            var visible = (observeSeverityFilter === 'all' || severity === observeSeverityFilter) && (!query || search.indexOf(query) >= 0);
            row.style.display = visible ? '' : 'none';
            if (!visible && detail) detail.style.display = 'none';
          }
          var groups = document.querySelectorAll('[data-observe-skill-group]');
          for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            var groupRows = group.querySelectorAll('[data-observe-row="review"]');
            var anyVisible = false;
            for (var r = 0; r < groupRows.length; r++) {
              if (groupRows[r].style.display !== 'none') {
                anyVisible = true;
                break;
              }
            }
            group.style.display = anyVisible ? '' : 'none';
            if (query && anyVisible) group.open = true;
          }
        }
        (function setupObserveFilters() {
          var input = document.getElementById('observe-filter-input');
          if (input) input.addEventListener('input', applyObserveFilters);
        })();
        (function setupSignalTooltips() {
          var tooltip = document.getElementById('signal-global-tooltip');
          if (!tooltip) return;
          function show(el) {
            var title = el.getAttribute('data-signal-title') || '';
            var description = el.getAttribute('data-signal-description') || '';
            tooltip.innerHTML = '<strong style="display:block;margin-bottom:4px"></strong><div></div>';
            tooltip.querySelector('strong').textContent = title;
            tooltip.querySelector('div').textContent = description;
            tooltip.style.display = 'block';
            var rect = el.getBoundingClientRect();
            var top = rect.bottom + 8;
            var left = rect.left;
            var width = Math.min(360, window.innerWidth - 32);
            if (left + width > window.innerWidth - 16) left = window.innerWidth - width - 16;
            if (left < 16) left = 16;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
            var tipRect = tooltip.getBoundingClientRect();
            if (tipRect.bottom > window.innerHeight - 16) {
              tooltip.style.top = Math.max(16, rect.top - tipRect.height - 8) + 'px';
            }
          }
          function hide() {
            tooltip.style.display = 'none';
          }
          var helps = document.querySelectorAll('.signal-help');
          for (var i = 0; i < helps.length; i++) {
            helps[i].addEventListener('mouseenter', function () { show(this); });
            helps[i].addEventListener('focus', function () { show(this); });
            helps[i].addEventListener('mouseleave', hide);
            helps[i].addEventListener('blur', hide);
          }
        })();
      </script>
    </main>
  `, lang);
}

interface AnalysisListItem {
  id: string;
  generatedAt: string;
  sessionCount: number;
  segmentCount: number;
  skillCount: number;
  healthBand: 'green' | 'yellow' | 'red';
}

function listAnalyses(dir: string): AnalysisListItem[] {
  if (!existsSync(dir)) return [];
  const items: AnalysisListItem[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SkillHealthReport;
      if (!data.meta || !data.overall) continue;
      items.push({
        id: file.replace(/\.json$/, ''),
        generatedAt: data.meta.generatedAt,
        sessionCount: data.meta.sessionCount,
        segmentCount: data.meta.segmentCount,
        skillCount: Object.keys(data.bySkill || {}).length,
        healthBand: data.overall.healthBand,
      });
    } catch { /* skip corrupt */ }
  }
  // 最新在前
  items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  return items;
}

function loadAnalysis(dir: string, id: string): SkillHealthReport | null {
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SkillHealthReport;
  } catch {
    return null;
  }
}

interface SkillTrendPoint {
  analysisId: string;
  generatedAt: string;
  gapRate: number;
  weightedGapRate: number;
  failureRate: number;
  coverageRate: number | null;
  /** input + output only, 计费主成本 */
  billableTokens: number;
  /** cache_read + cache_creation, 通常远大于 billable 但计费权重低 */
  cachedTokens: number;
  totalTokens: number;
  avgTokensPerSegment: number;
  durationMs: number;
  segmentCount: number;
  stability: 'stable' | 'unstable' | 'very-unstable';
}

interface SkillTrendResult {
  skillName: string;
  points: SkillTrendPoint[];
}

/**
 * 扫 analyses/ 所有 JSON,按 skillName 过滤,按时间排序成 trend points。
 */
function querySkillTrend(dir: string, skillName: string): SkillTrendResult {
  const items = listAnalyses(dir);
  const points: SkillTrendPoint[] = [];
  for (const it of items) {
    const report = loadAnalysis(dir, it.id);
    if (!report) continue;
    const h = report.bySkill[skillName];
    if (!h) continue;
    // 旧格式 (加 usage 字段前的 analysis) 用 safe access,缺字段降级为 0/undefined
    const u = h.usage;
    const billable = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
    const cached = (u?.cacheReadTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
    points.push({
      analysisId: it.id,
      generatedAt: report.meta.generatedAt,
      gapRate: h.gap?.gapRate ?? 0,
      weightedGapRate: h.gap?.weightedGapRate ?? 0,
      failureRate: h.toolFailureRate ?? 0,
      coverageRate: h.coverage?.fileCoverageRate ?? null,
      billableTokens: billable,
      cachedTokens: cached,
      totalTokens: u?.totalTokens ?? 0,
      avgTokensPerSegment: u?.avgTokensPerSegment ?? 0,
      durationMs: u?.durationMs ?? 0,
      segmentCount: h.segmentCount ?? 0,
      stability: h.stability ?? 'stable',
    });
  }
  // 最旧在前,便于折线图从左到右展示时间序列
  points.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return { skillName, points };
}

interface SkillDiffRow {
  skillName: string;
  presence: 'both' | 'only-from' | 'only-to';
  fromGap?: number;
  toGap?: number;
  deltaGap?: number;
  fromFailure?: number;
  toFailure?: number;
  deltaFailure?: number;
  fromCoverage?: number | null;
  toCoverage?: number | null;
  deltaCoverage?: number | null;
  fromSegments?: number;
  toSegments?: number;
  deltaSegments?: number;
}

interface SkillDiffResult {
  fromId: string;
  toId: string;
  fromAt: string;
  toAt: string;
  rows: SkillDiffRow[];
}

/**
 * 比较两份 skill health report. `from` 通常是较早的,`to` 是较晚的;
 * 对于每个 skill, 显示前后值和 delta. 缺失一侧时 presence 标记。
 */
function querySkillDiff(dir: string, fromId: string, toId: string): SkillDiffResult | null {
  const from = loadAnalysis(dir, fromId);
  const to = loadAnalysis(dir, toId);
  if (!from || !to) return null;
  const allSkills = new Set<string>([...Object.keys(from.bySkill), ...Object.keys(to.bySkill)]);
  const rows: SkillDiffRow[] = [];
  for (const skill of allSkills) {
    const f = from.bySkill[skill];
    const t = to.bySkill[skill];
    if (f && t) {
      rows.push({
        skillName: skill,
        presence: 'both',
        fromGap: f.gap.weightedGapRate,
        toGap: t.gap.weightedGapRate,
        deltaGap: t.gap.weightedGapRate - f.gap.weightedGapRate,
        fromFailure: f.toolFailureRate,
        toFailure: t.toolFailureRate,
        deltaFailure: t.toolFailureRate - f.toolFailureRate,
        fromCoverage: f.coverage?.fileCoverageRate ?? null,
        toCoverage: t.coverage?.fileCoverageRate ?? null,
        deltaCoverage: (f.coverage?.fileCoverageRate != null && t.coverage?.fileCoverageRate != null)
          ? t.coverage.fileCoverageRate - f.coverage.fileCoverageRate
          : null,
        fromSegments: f.segmentCount,
        toSegments: t.segmentCount,
        deltaSegments: t.segmentCount - f.segmentCount,
      });
    } else if (f) {
      rows.push({ skillName: skill, presence: 'only-from', fromGap: f.gap.weightedGapRate, fromFailure: f.toolFailureRate, fromCoverage: f.coverage?.fileCoverageRate ?? null, fromSegments: f.segmentCount });
    } else if (t) {
      rows.push({ skillName: skill, presence: 'only-to', toGap: t.gap.weightedGapRate, toFailure: t.toolFailureRate, toCoverage: t.coverage?.fileCoverageRate ?? null, toSegments: t.segmentCount });
    }
  }
  // 按 deltaGap 绝对值倒序 (变化大的在前,缺失的放最后)
  rows.sort((a, b) => {
    const aDelta = a.presence === 'both' ? Math.abs(a.deltaGap!) : -1;
    const bDelta = b.presence === 'both' ? Math.abs(b.deltaGap!) : -1;
    return bDelta - aDelta;
  });
  return { fromId, toId, fromAt: from.meta.generatedAt, toAt: to.meta.generatedAt, rows };
}

function fmtDelta(d: number | null | undefined, isPercent = true): string {
  if (d == null) return '—';
  const pct = isPercent ? d * 100 : d;
  const sign = pct > 0 ? '+' : '';
  const color = Math.abs(pct) < 1 ? '#888' : pct > 0 ? '#dc2626' : '#16a34a';
  return `<span style="color:${color}">${sign}${pct.toFixed(isPercent ? 1 : 0)}${isPercent ? '%' : ''}</span>`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

function renderSkillDiffPage(diff: SkillDiffResult, lang: Lang = DEFAULT_LANG): string {
  const { fromId, toId, fromAt, toAt, rows } = diff;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const rowHtml = rows.map((r) => {
    const tag = r.presence === 'only-from' ? `<span style="color:var(--green);font-size:10px;padding:1px 6px;background:var(--green-bg);border-radius:3px" data-i18n="diffTagRemoved">${t('diffTagRemoved', lang)}</span>`
      : r.presence === 'only-to' ? `<span style="color:var(--accent);font-size:10px;padding:1px 6px;background:var(--info-bg);border-radius:3px" data-i18n="diffTagNew">${t('diffTagNew', lang)}</span>`
      : '';
    return `<tr>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${r.skillName} ${tag}</td>
      <td style="padding:8px 10px;text-align:right">${r.fromSegments ?? '—'} → ${r.toSegments ?? '—'} ${r.presence === 'both' ? `(${fmtDelta(r.deltaSegments, false)})` : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromGap)} → ${fmtPct(r.toGap)} ${r.presence === 'both' ? fmtDelta(r.deltaGap) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromFailure)} → ${fmtPct(r.toFailure)} ${r.presence === 'both' ? fmtDelta(r.deltaFailure) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromCoverage)} → ${fmtPct(r.toCoverage)} ${r.presence === 'both' && r.deltaCoverage != null ? fmtDelta(r.deltaCoverage) : ''}</td>
    </tr>`;
  }).join('');
  const body = `
    <main style="max-width:1000px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px">
        <a href="/analyses${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('backToAnalyses', lang)}</a>
        <a href="/analyses/${encodeURIComponent(fromId)}${langQ}" data-i18n="diffNavFrom" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('diffNavFrom', lang)}</a>
        <a href="/analyses/${encodeURIComponent(toId)}${langQ}" data-i18n="diffNavTo" style="color:var(--accent);text-decoration:none">${t('diffNavTo', lang)}</a>
      </nav>
      <h1 data-i18n="skillDiffHeading" style="font-size:20px;margin:8px 0">${t('skillDiffHeading', lang)}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        <span data-i18n="diffNavFrom">${t('diffNavFrom', lang)}</span> <code>${fromId}</code> (${fromAt.slice(0, 19).replace('T', ' ')}) → <span data-i18n="diffNavTo">${t('diffNavTo', lang)}</span> <code>${toId}</code> (${toAt.slice(0, 19).replace('T', ' ')})<br/>
        <span data-i18n="diffSortHint">${t('diffSortHint', lang)}</span>
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSkill">${t('diffColSkill', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSegments">${t('diffColSegments', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColWeightedGap">${t('diffColWeightedGap', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColFailureRate">${t('diffColFailureRate', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColCoverage">${t('diffColCoverage', lang)}</th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </main>`;
  return layout(t('skillDiffHeading', lang), body, lang);
}

function renderSkillTrendPage(trend: SkillTrendResult, lang: Lang = DEFAULT_LANG): string {
  const { skillName, points } = trend;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  if (points.length === 0) {
    const emptyBody = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/analyses${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${skillName}</h1>
      <p style="color:var(--text-muted)" data-i18n="noTrendData">${t('noTrendData', lang)}</p>
    </main>`;
    return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, emptyBody, lang);
  }
  // SVG 折线图: gapRate 主线 + failureRate 辅线, X 轴时间序
  const W = 760, H = 200, PAD = 40;
  const toX = (i: number) => points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const toY = (v: number) => H - PAD - v * (H - 2 * PAD);
  const pathOf = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate') => {
    const usable = points.map((p, i) => ({ x: toX(i), y: p[key] ?? null }));
    let d = '';
    for (const pt of usable) {
      if (pt.y == null) continue;
      d += d ? ` L ${pt.x} ${toY(pt.y as number)}` : `M ${pt.x} ${toY(pt.y as number)}`;
    }
    return d;
  };
  const dots = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate', color: string) =>
    points.map((p, i) => p[key] == null ? '' : `<circle cx="${toX(i)}" cy="${toY(p[key] as number)}" r="3" fill="${color}"/>`).join('');
  const yTicks = [0, 0.5, 1.0].map((v) => `<g><line x1="${PAD}" y1="${toY(v)}" x2="${W - PAD}" y2="${toY(v)}" stroke="var(--border)"/><text x="${PAD - 6}" y="${toY(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${Math.round(v * 100)}%</text></g>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
    ${yTicks}
    <path d="${pathOf('gapRate')}" stroke="#f87171" stroke-width="2" fill="none"/>
    <path d="${pathOf('weightedGapRate')}" stroke="#fbbf24" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
    <path d="${pathOf('failureRate')}" stroke="#a78bfa" stroke-width="2" fill="none"/>
    <path d="${pathOf('coverageRate')}" stroke="#4ade80" stroke-width="2" fill="none"/>
    ${dots('gapRate', '#f87171')}${dots('weightedGapRate', '#fbbf24')}${dots('failureRate', '#a78bfa')}${dots('coverageRate', '#4ade80')}
  </svg>`;
  const legend = `<div style="margin:12px 0;font-size:12px;color:var(--text-secondary)">
    <span style="color:#f87171">● <span data-i18n="trendLegendGap">${t('trendLegendGap', lang)}</span></span> ·
    <span style="color:#fbbf24">◆ <span data-i18n="trendLegendWeighted">${t('trendLegendWeighted', lang)}</span></span> ·
    <span style="color:#a78bfa">● <span data-i18n="trendLegendFailure">${t('trendLegendFailure', lang)}</span></span> ·
    <span style="color:#4ade80">● <span data-i18n="trendLegendCoverage">${t('trendLegendCoverage', lang)}</span></span>
  </div>`;
  const rows = points.map((p) => `<tr>
    <td style="padding:6px 10px;font-family:ui-monospace,monospace;font-size:12px"><a href="/analyses/${encodeURIComponent(p.analysisId)}${langQ}" style="color:var(--accent);text-decoration:none">${p.generatedAt.slice(0, 19).replace('T', ' ')}</a></td>
    <td style="padding:6px 10px;text-align:right">${p.segmentCount}</td>
    <td style="padding:6px 10px;text-align:right;color:#f87171">${Math.round(p.gapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#fbbf24">${Math.round(p.weightedGapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#a78bfa">${Math.round(p.failureRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#4ade80">${p.coverageRate == null ? '—' : Math.round(p.coverageRate * 100) + '%'}</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px" title="input+output only; cache 分开计">${(p.billableTokens / 1000).toFixed(1)}k</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${(p.durationMs / 1000).toFixed(1)}s</td>
  </tr>`).join('');
  const subtitle = `${points.length} <span data-i18n="trendNPoints">${t('trendNPoints', lang)}</span> · <span data-i18n="trendEarliest">${t('trendEarliest', lang)}</span> ${points[0].generatedAt.slice(0, 10)} · <span data-i18n="trendLatest">${t('trendLatest', lang)}</span> ${points[points.length - 1].generatedAt.slice(0, 10)}`;
  const body = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px"><a href="/analyses${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${skillName}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${subtitle}</div>
      ${svg}
      ${legend}
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTimestamp">${t('trendColTimestamp', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColSegs">${t('trendColSegs', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColGap">${t('trendColGap', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColWeighted">${t('trendColWeighted', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColFailure">${t('trendColFailure', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColCoverage">${t('trendColCoverage', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTokens">${t('trendColTokens', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColDuration">${t('trendColDuration', lang)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>`;
  return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, body, lang);
}

function renderAnalysisList(items: AnalysisListItem[], lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const body = items.length === 0
    ? `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/${langQ}" data-i18n="backToEvalReports" style="color:var(--accent);text-decoration:none">${t('backToEvalReports', lang)}</a></nav>
      <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
      <div style="color:var(--text-muted);padding:16px" data-i18n="noAnalyses">${t('noAnalyses', lang)}</div>
    </main>`
    : (() => {
      const rows = items.map((it) => {
        const badgeColor = it.healthBand === 'red' ? 'var(--red)' : it.healthBand === 'yellow' ? 'var(--yellow)' : 'var(--green)';
        const enc = encodeURIComponent(it.id);
        return `<li style="padding:10px 14px;border-bottom:1px solid var(--border);list-style:none;display:flex;align-items:center;gap:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="from" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesFromLabel">${t('analysesFromLabel', lang)}</span></label>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="to" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesToLabel">${t('analysesToLabel', lang)}</span></label>
          <a href="/analyses/${enc}${langQ}" style="color:var(--accent);text-decoration:none;flex:1;font-family:ui-monospace,monospace">${it.id}</a>
          <span style="color:var(--text-muted);font-size:12px">${it.sessionCount} <span data-i18n="analysesSessions">${t('analysesSessions', lang)}</span> · ${it.segmentCount} <span data-i18n="analysesSegs">${t('analysesSegs', lang)}</span> · ${it.skillCount} <span data-i18n="analysesSkills">${t('analysesSkills', lang)}</span></span>
        </li>`;
      }).join('');
      return `
      <main style="max-width:900px;margin:0 auto;padding:24px">
        <nav style="margin-bottom:12px"><a href="/${langQ}" data-i18n="backToEvalReports" style="color:var(--accent);text-decoration:none">${t('backToEvalReports', lang)}</a></nav>
        <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
        <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-surface);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
          <span data-i18n="analysesCompareHint">${t('analysesCompareHint', lang)}</span>
          <a id="compare-btn" style="margin-left:8px;padding:4px 10px;background:var(--accent);color:white;text-decoration:none;border-radius:3px;opacity:0.4;pointer-events:none" data-i18n="analysesCompareBtn">${t('analysesCompareBtn', lang)}</a>
        </div>
        <ul style="padding:0;margin:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">${rows}</ul>
      </main>
      <script>
        function updateCompare() {
          var f = document.querySelector('input[name=from]:checked');
          var t2 = document.querySelector('input[name=to]:checked');
          var btn = document.getElementById('compare-btn');
          if (f && t2 && f.value !== t2.value) {
            btn.href = '/analyses-diff?from=' + f.value + '&to=' + t2.value + '&lang=' + (document.documentElement.dataset.lang || '${DEFAULT_LANG}');
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
          } else {
            btn.removeAttribute('href');
            btn.style.opacity = '0.4';
            btn.style.pointerEvents = 'none';
          }
        }
      </script>`;
    })();
  return layout(t('skillHealthTitle', lang), body, lang);
}

interface ReportServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Returns Error to throw, or null when caller should fall through to the
// EADDRINUSE / omk-takeover flow. Splits "occupancy" from "permission" /
// "ephemeral-bind-rejected" so users see a fix path that matches the cause.
export function formatListenError(p: number, err: unknown): Error | null {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;

  // p === 0 asks the OS to pick an ephemeral port; "already in use" is
  // semantically wrong here. Failures are almost always sandbox / restricted
  // network environments rather than occupancy.
  if (p === 0) {
    return new Error(
      `cannot bind ephemeral port (--port 0): ${errno ?? 'unknown error'}.\n` +
      `  likely cause: sandboxed / restricted network environment ` +
      `(Docker without --net=host, container without bind permission).\n` +
      `  try a fixed port: ${PORT_HINT}`
    );
  }

  // EACCES / EPERM: permission, not occupancy. Common on privileged ports
  // (<1024 without root) or sandbox / container restrictions.
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new Error(
      `cannot bind port ${p}: permission denied (${errno}).\n` +
      `  ports < 1024 require root on Unix; sandboxed environments may block all binds.\n` +
      `  pick another unblocked port: ${PORT_HINT}`
    );
  }

  // Any other syscall errno that isn't EADDRINUSE: surface it directly,
  // don't try the omk-takeover flow.
  if (errno && errno !== 'EADDRINUSE') {
    return new Error(
      `cannot bind port ${p}: ${errno} (${getErrorMessage(err)}).\n` +
      `  pick another port: ${PORT_HINT}`
    );
  }

  // EADDRINUSE or unknown — let caller try the omk-takeover flow.
  return null;
}

export function createReportServer({ port, reportsDir = DEFAULT_REPORTS_DIR, analysesDir = DEFAULT_ANALYSES_DIR, observationsDir = DEFAULT_OBSERVATIONS_DIR, jobsDir = DEFAULT_JOBS_DIR, store, jobStore }: ReportServerOptions = {}): ReportServer {
  let server: Server | null = null;
  let serverUrl: string | null = null;

  // Use provided store or default to file store
  const reportStore: ReportStore = store || createFileStore(reportsDir);
  const resolvedJobStore: JobStore = jobStore || createFileJobStore(jobsDir);

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const path = parsed.pathname;
      const langParam = parsed.searchParams.get('lang');
      const lang: Lang = langParam === 'en' ? 'en' : langParam === 'zh' ? 'zh' : DEFAULT_LANG;

      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'omk' }));
        return;
      }

      if (path === '/api/shutdown' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Graceful shutdown after response sent
        setTimeout(() => { if (server) server.close(); }, 100);
        return;
      }

      if (path === '/api/reports') {
        const runs = await queryRunList(reportStore);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
        return;
      }

      if (path === '/api/analyses') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listAnalyses(analysesDir)));
        return;
      }

      if (path === '/analyses') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderAnalysisList(listAnalyses(analysesDir), lang));
        return;
      }

      if (path === '/observations' || path === '/observations/inbox') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderObservationInboxPage(observationsDir, lang));
        return;
      }

      if (path === '/api/observations/inbox') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(queryObservationInbox(observationsDir)));
        return;
      }

      const analysisDetailMatch = path.match(/^\/analyses\/(.+)$/);
      if (analysisDetailMatch) {
        const id = decodeURIComponent(analysisDetailMatch[1]);
        const report = loadAnalysis(analysesDir, id);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillHealthReport(report, lang));
        return;
      }

      const analysisApiMatch = path.match(/^\/api\/analyses\/(.+)$/);
      if (analysisApiMatch) {
        const id = decodeURIComponent(analysisApiMatch[1]);
        const report = loadAnalysis(analysesDir, id);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'analysis not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      const skillTrendApiMatch = path.match(/^\/api\/skill-trend\/(.+)$/);
      if (skillTrendApiMatch) {
        const skillName = decodeURIComponent(skillTrendApiMatch[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(querySkillTrend(analysesDir, skillName)));
        return;
      }

      const skillTrendPageMatch = path.match(/^\/skill-trend\/(.+)$/);
      if (skillTrendPageMatch) {
        const skillName = decodeURIComponent(skillTrendPageMatch[1]);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillTrendPage(querySkillTrend(analysesDir, skillName), lang));
        return;
      }

      if (path === '/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing from/to query params');
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId);
        if (!diff) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillDiffPage(diff, lang));
        return;
      }

      if (path === '/api/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing from/to query params' }));
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId);
        if (!diff) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'analysis not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diff));
        return;
      }

      if (path === '/api/jobs') {
        const limitParam = parsed.searchParams.get('limit');
        const jobs = await queryJobList(resolvedJobStore, {
          status: parsed.searchParams.get('status') || undefined,
          reportId: parsed.searchParams.get('reportId') || undefined,
          project: parsed.searchParams.get('project') || undefined,
          owner: parsed.searchParams.get('owner') || undefined,
          tag: parsed.searchParams.get('tag') || undefined,
          limit: limitParam ? Number(limitParam) : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jobs));
        return;
      }

      const jobApiMatch = path.match(/^\/api\/job\/(.+)$/);
      if (jobApiMatch) {
        const job = await queryJob(resolvedJobStore, decodeURIComponent(jobApiMatch[1]));
        if (!job) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'job not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(job));
        return;
      }

      const reportApiMatch = path.match(/^\/api\/reports\/(.+)$/);
      if (reportApiMatch) {
        const id = decodeURIComponent(reportApiMatch[1]);

        if (req.method === 'DELETE') {
          const removed = await reportStore.remove(id);
          if (!removed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'report not found' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
          return;
        }

        const report = await queryRun(reportStore, id);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'report not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      // Trends API
      const trendsApiMatch = path.match(/^\/api\/trends\/(.+)$/);
      if (trendsApiMatch) {
        const variantName = decodeURIComponent(trendsApiMatch[1]);
        const trend = await queryTrend(reportStore, variantName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variant: trend.variant, points: trend.points }));
        return;
      }

      // Trends page
      const trendsPageMatch = path.match(/^\/trends\/(.+)$/);
      if (trendsPageMatch) {
        const variantName = decodeURIComponent(trendsPageMatch[1]);
        const trend = await queryTrend(reportStore, variantName);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderTrendsPage(variantName, trend.runs, lang));
        return;
      }

      const reportPageMatch = path.match(/^\/reports\/(.+)$/);
      if (reportPageMatch) {
        const report = await queryRun(reportStore, decodeURIComponent(reportPageMatch[1]));
        res.writeHead(report ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderReportDocumentDetail(report, lang));
        return;
      }

      if (path === '/') {
        const runs = await reportStore.list();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderRunList(runs, lang));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: getErrorMessage(err) }));
    }
  }

  async function start(): Promise<string> {
    if (server) return serverUrl!;
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    if (!existsSync(analysesDir)) mkdirSync(analysesDir, { recursive: true });
    if (!existsSync(jobsDir)) mkdirSync(jobsDir, { recursive: true });

    const p = port ?? Number(process.env.OMK_REPORT_PORT || DEFAULT_PORT);
    const host = '127.0.0.1';

    const boot = (listenPort: number): Promise<Server> => new Promise((resolve, reject) => {
      const srv = createServer(handleRequest);
      srv.once('error', reject);
      srv.listen(listenPort, host, () => resolve(srv));
    });

    try {
      server = await boot(p);
    } catch (err: unknown) {
      const formatted = formatListenError(p, err);
      if (formatted) throw formatted;

      // EADDRINUSE — check if it's an existing omk service we can take over
      const url = `http://${host}:${p}`;
      let isOmk = false;
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        const data = await res.json() as { service?: string };
        isOmk = data.service === 'omk';
      } catch { /* not reachable or not omk */ }

      if (isOmk) {
        // Shut down old omk service, then take over the port
        try { await fetch(`${url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 500));
        try {
          server = await boot(p);
        } catch {
          throw new Error(`port ${p} is still in use; close it manually and retry: lsof -ti:${p} | xargs kill`);
        }
      } else {
        throw new Error(
          `port ${p} is already in use by another process.\n` +
          `  inspect: lsof -i:${p}\n` +
          `  release: lsof -ti:${p} | xargs kill\n` +
          `  or pick another port: ${PORT_HINT}`
        );
      }
    }

    const addr = server!.address() as AddressInfo;
    serverUrl = `http://${host}:${addr.port}`;
    return serverUrl;
  }

  async function stop(): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverUrl = null;
  }

  function getUrl(): string | null {
    return serverUrl;
  }

  return { start, stop, getUrl };
}

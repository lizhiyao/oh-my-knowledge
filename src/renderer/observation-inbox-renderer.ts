import { DEFAULT_LANG, layout, e } from './layout.js';
import type { Lang } from '../types/index.js';
import { severityReasonFor } from '../observability/inbox.js';
import type { ObservationInboxItem } from '../observability/inbox.js';
import type { ObservationInboxViewModel } from '../observability/inbox-view-model.js';

export function renderObservationInboxPage(model: ObservationInboxViewModel, lang: Lang = DEFAULT_LANG): string {
  const {
    allItems,
    items,
    reports,
    skillInvocationCounts,
    skillSessionCounts,
    skillInvocationLastSeen,
    skillToolCallCounts,
    totalSkillInvocations,
    severitySkillCounts,
    skillCount,
    reportCount,
    latestSeenLabel,
  } = model;
  const countSkillsBySeverity = (...severities: ObservationInboxItem['severity'][]): number =>
    new Set(allItems.filter((item) => severities.includes(item.severity)).map((item) => item.skillName)).size;
  const skillAnchor = (skillName: string): string => `skill-${skillName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'}`;
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
      return { label: '高风险/需关注', decision: '优先看，可能要补 SKILL.md 或改 skill 说明', color: 'var(--red)', bg: 'rgba(220,38,38,.08)' };
    }
    if (item.severity === 'medium') {
      return { label: '低风险/抽样确认', decision: '通常不需要改 skill；抽样确认是否反复浪费时间', color: 'var(--yellow)', bg: 'rgba(202,138,4,.10)' };
    }
    if (item.severity === 'low') {
      return { label: '不确定/低优先级', decision: '模型只是说不确定，不一定需要改 skill', color: 'var(--accent)', bg: 'rgba(37,99,235,.08)' };
    }
    return { label: '无异常/无需改 skill', decision: '更像路径、权限、文件太大或工具限制；先不当成 skill 内容缺失', color: 'var(--text-muted)', bg: 'var(--bg-muted)' };
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
    if (item.signalSubtype === 'transient_file_missing') return `${tool} 访问了临时文件但文件不存在：${item.evidence.path || target}`;
    if (item.signalSubtype === 'skill_asset_read_failed') return `${tool} 读取该 skill 自身资源失败：${item.evidence.path || target}`;
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
    if (item.signalSubtype === 'transient_file_missing') return `${item.evidence.tool || '工具'} 访问了临时文件，但文件不存在。`;
    if (item.signalSubtype === 'skill_asset_read_failed') return `${item.evidence.tool || '工具'} 读取该 skill 自身资源失败。`;
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
    const reason = severityReasonFor(item, lang);
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
    const label = item.sourceKind === 'markdown_log' ? 'Markdown log' : item.sourceKind === 'claude' ? 'Claude' : 'Unknown';
    const color = item.sourceKind === 'markdown_log' ? 'var(--green)' : item.sourceKind === 'claude' ? 'var(--accent)' : 'var(--text-muted)';
    return `<span title="调用日志来源：${e(label)}" style="display:inline-flex;width:max-content;margin-top:4px;padding:2px 6px;border-radius:999px;background:var(--bg-muted);color:${color};font-size:11px;font-weight:650">${e(label)}</span>`;
  };
  const confidenceHeaderHelp = '判断把握：OMK 对“这条 过程发现 是否需要处理/是否高风险/需关注”的规则判断有多确定。归属把握：OMK 把这条 过程发现 归到当前 skill 名下有多确定，例如明确调用 skill 通常更高。';
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
            <button type="button" onclick="openObservationTrace('${e(item.id)}', this)" style="margin-top:8px;font-size:12px;padding:5px 8px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer">Open in trace</button>
            <pre id="trace-${e(item.id)}" style="display:none;margin:8px 0 0;padding:9px;background:var(--bg-muted);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;max-height:360px;overflow:auto;text-align:left"></pre>
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
    high: '高风险/需关注',
    medium: '低风险/抽样确认',
    low: '不确定/低优先级',
    noise: '无异常/无需改 skill',
  };
  const severityHeadingZh: Record<ObservationInboxItem['severity'], string> = {
    high: '异常需关注',
    medium: '低风险：Bash 探测',
    low: '不确定信号',
    noise: '无异常：路径/权限/工具限制',
  };
  const skillSections = skillGroups.map(([skillName, groupItems], groupIndex) => {
    const counts = {
      high: groupItems.filter((item) => item.severity === 'high').length,
      medium: groupItems.filter((item) => item.severity === 'medium').length,
      low: groupItems.filter((item) => item.severity === 'low').length,
      noise: groupItems.filter((item) => item.severity === 'noise').length,
    };
    const latestObservation = groupItems.reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
    const latest = latestObservation || skillInvocationLastSeen[skillName] || '';
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
    return `<details id="${e(skillAnchor(skillName))}" data-observe-skill-group data-search="${e(searchText)}" open style="margin-top:14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:visible;scroll-margin-top:16px">
      <summary style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;cursor:pointer;list-style:none">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-family:ui-monospace,monospace;font-size:14px;font-weight:700">${e(skillName)}</span>
            <span title="这个 skill 在当前 trace 里被归因/触发的次数" style="padding:2px 7px;border-radius:999px;background:var(--info-bg);color:var(--accent);font-size:12px;font-weight:650">调用 ${invocationCount} 次</span>
          </div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:3px">${groupItems.length} 过程发现 · ${sessionCount} sessions · source ${e(sourceKinds.join(', '))} · latest ${e(latest.slice(0, 19).replace('T', ' '))}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <span title="高风险/需关注：优先看，可能需要补 SKILL.md 或改 skill 说明" style="padding:3px 7px;border-radius:999px;background:rgba(220,38,38,.08);color:var(--red);font-size:12px">高风险/需关注 ${counts.high}</span>
          <span title="低风险/抽样确认：通常不需要改 skill；抽样确认是否反复浪费时间" style="padding:3px 7px;border-radius:999px;background:rgba(202,138,4,.10);color:var(--yellow);font-size:12px">低风险 ${counts.medium}</span>
          <span title="不确定/低优先级：模型只是说不确定，不一定需要改 skill" style="padding:3px 7px;border-radius:999px;background:rgba(37,99,235,.08);color:var(--accent);font-size:12px">说不确定 ${counts.low}</span>
          <span title="无异常/无需改 skill：更像文件不存在、文件太大、权限或工具限制" style="padding:3px 7px;border-radius:999px;background:var(--bg-muted);color:var(--text-muted);font-size:12px">路径/工具问题 ${counts.noise}</span>
        </div>
      </summary>
      <div style="padding:0 14px 14px">${buckets}</div>
    </details>`;
  }).join('');
  const itemsBySkill = allItems.reduce((map, item) => {
    const existing = map.get(item.skillName) ?? [];
    existing.push(item);
    map.set(item.skillName, existing);
    return map;
  }, new Map<string, ObservationInboxItem[]>());
  const allSkillNames = Array.from(new Set([
    ...Object.keys(skillInvocationCounts),
    ...Array.from(itemsBySkill.keys()),
  ]));
  const skillRollups = allSkillNames.map((skillName) => {
    const groupItems = itemsBySkill.get(skillName) ?? [];
    const counts = {
      high: groupItems.filter((item) => item.severity === 'high').length,
      medium: groupItems.filter((item) => item.severity === 'medium').length,
      low: groupItems.filter((item) => item.severity === 'low').length,
      noise: groupItems.filter((item) => item.severity === 'noise').length,
    };
    const invocationCount = skillInvocationCounts[skillName] ?? groupItems.reduce((sum, item) => sum + item.occurrences, 0);
    const sessionCount = skillSessionCounts[skillName] ?? new Set(groupItems.flatMap((item) => item.recentSessionIds)).size;
    const lastProblemSeen = groupItems.reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
    const lastUsed = skillInvocationLastSeen[skillName] || lastProblemSeen || '';
    const sources = Array.from(new Set(groupItems.map((item) => item.sourceKind))).sort();
    const observationCount = groupItems.length;
    const toolCounts = skillToolCallCounts[skillName] ?? {};
    const metricCounts = {
      bash: toolCounts.Bash ?? 0,
      read: toolCounts.Read ?? 0,
      grep: toolCounts.Grep ?? 0,
      uncertainty: groupItems.filter((item) => item.signalType === 'hedging').reduce((sum, item) => sum + item.occurrences, 0),
      explicitMarker: groupItems.filter((item) => item.signalType === 'explicit_marker').reduce((sum, item) => sum + item.occurrences, 0),
      bashProbe: groupItems.filter((item) => item.signalSubtype === 'bash_probe').reduce((sum, item) => sum + item.occurrences, 0),
      notFound: groupItems.filter((item) => item.signalSubtype === 'not_found').reduce((sum, item) => sum + item.occurrences, 0),
      toolLimit: groupItems.filter((item) => item.signalSubtype === 'tool_limit').reduce((sum, item) => sum + item.occurrences, 0),
      toolFailure: groupItems.filter((item) => item.signalSubtype === 'tool_failure').reduce((sum, item) => sum + item.occurrences, 0),
    };
    const actionableCount = counts.high;
    const reviewLabel = actionableCount > 0
      ? '高风险'
      : counts.medium > 0
        ? '低风险'
        : counts.noise > 0
          ? '无异常'
          : '无异常';
    const reviewColor = actionableCount > 0
      ? 'var(--red)'
      : counts.medium > 0
        ? 'var(--yellow)'
        : counts.noise > 0
          ? 'var(--text-muted)'
          : 'var(--green)';
    return {
      skillName,
      invocationCount,
      sessionCount,
      observationCount,
      counts,
      lastProblemSeen,
      lastUsed,
      sources,
      metricCounts,
      reviewLabel,
      reviewColor,
    };
  }).sort((a, b) => {
    const aRisk = a.counts.high * 100 + a.counts.medium * 10 + a.counts.noise;
    const bRisk = b.counts.high * 100 + b.counts.medium * 10 + b.counts.noise;
    if (bRisk !== aRisk) return bRisk - aRisk;
    return b.invocationCount - a.invocationCount;
  });
  const skillRollupRows = skillRollups.map((row) => {
    const hasDetail = (itemsBySkill.get(row.skillName)?.length ?? 0) > 0;
    return `<tr data-observe-rollup-row data-skill-anchor="${e(skillAnchor(row.skillName))}" style="${hasDetail ? 'cursor:pointer' : ''}">
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(row.skillName)}</td>
      <td class="num" style="padding:9px 10px;text-align:right;font-weight:700">${row.invocationCount}</td>
      <td class="num" style="padding:9px 10px;text-align:right">${row.sessionCount}</td>
      <td class="num" style="padding:9px 10px;text-align:right">${row.observationCount}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);font-size:12px;line-height:1.55">
        <span title="完整 trace 中这个 skill 运行时调用 Bash 工具的次数">Bash调用 ${row.metricCounts.bash}</span> ·
        <span title="完整 trace 中这个 skill 运行时调用 Read 工具的次数">Read ${row.metricCounts.read}</span> ·
        <span title="完整 trace 中这个 skill 运行时调用 Grep 工具的次数">Grep ${row.metricCounts.grep}</span><br>
        <span title="过程发现 中，agent 的回答出现“不确定、可能、需要确认”等表达的次数">回答不确定 ${row.metricCounts.uncertainty}</span> ·
        <span title="过程发现 中，agent 明确说“未知/知识缺口/没覆盖”等内容的次数">明确说缺口 ${row.metricCounts.explicitMarker}</span> ·
        <span title="过程发现 中，Bash 命令看起来是在试目录、试路径或探测环境的次数">Bash试探 ${row.metricCounts.bashProbe}</span><br>
        <span title="过程发现 中，访问的文件或路径不存在的次数">路径不存在 ${row.metricCounts.notFound}</span> ·
        <span title="过程发现 中，文件太长、token 上限或超时这类工具限制次数">工具限制 ${row.metricCounts.toolLimit}</span> ·
        <span title="过程发现 中，工具调用失败但不属于路径不存在或工具限制的次数">工具失败 ${row.metricCounts.toolFailure}</span>
      </td>
      <td class="num" style="padding:9px 10px;text-align:right;color:var(--red);font-weight:650">${row.counts.high}</td>
      <td class="num" style="padding:9px 10px;text-align:right;color:var(--yellow);font-weight:650">${row.counts.medium + row.counts.low}</td>
      <td class="num" style="padding:9px 10px;text-align:right;color:var(--text-muted)">${row.counts.noise}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px" title="${row.lastProblemSeen ? '最近一次产生 过程发现 的时间' : '当前没有发现问题或旧 report 没有 过程发现 时间'}">${row.lastProblemSeen ? e(row.lastProblemSeen.slice(0, 19).replace('T', ' ')) : '—'}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px" title="${row.lastUsed ? '最近一次在 trace 中识别到 skill 调用的时间' : '当前 过程发现 report 中没有这个 skill 的调用时间信息；旧 report 需要重新 ingest 才会补齐'}">${row.lastUsed ? e(row.lastUsed.slice(0, 19).replace('T', ' ')) : '—'}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px">${row.sources.length > 0 ? e(row.sources.join(', ')) : '—'}</td>
      <td style="padding:9px 10px;text-align:right">
        <span style="display:inline-flex;width:max-content;padding:3px 7px;border-radius:999px;background:var(--bg-muted);color:${row.reviewColor};font-size:12px;font-weight:650">${e(row.reviewLabel)}</span>
      </td>
    </tr>`;
  }).join('');
  const actionItems = skillRollups
    .filter((row) => row.observationCount > 0)
    .map((row) => {
      const groupItems = itemsBySkill.get(row.skillName) ?? [];
      const repeatedMedium = groupItems
        .filter((item) => item.severity === 'medium')
        .reduce((sum, item) => sum + item.occurrences, 0);
      const noiseCount = groupItems
        .filter((item) => item.severity === 'noise')
        .reduce((sum, item) => sum + item.occurrences, 0);
      let priority = 'P2';
      let action = '打开明细看 1-2 条证据';
      let reason = '这类记录说明运行中出现过异常信号，但现在还不能直接判断 skill 需要修改。';
      let color = 'var(--text-muted)';
      if (row.counts.high > 0) {
        priority = 'P0';
        action = '先看这个 skill 是否漏写了关键信息';
        reason = '有高风险记录：agent 查找失败后，没有看到它在同一轮里找到替代结果，或回答里明确暴露了缺口。';
        color = 'var(--red)';
      } else if (repeatedMedium >= 3) {
        priority = 'P1';
        action = '看是否要补一段“推荐查找路径”';
        reason = `agent 在这个 skill 运行时反复试目录或路径，共 ${repeatedMedium} 次。单次不用改，但反复出现可能说明 skill 没告诉它该优先看哪里。`;
        color = 'var(--yellow)';
      } else if (row.counts.medium > 0 || row.counts.low > 0) {
        priority = 'P2';
        action = '抽几条看看是否真的影响使用';
        reason = '当前主要是低风险记录：可能只是 agent 正常探索路径，或回答里出现了不确定表达。先看样例，不要直接改 skill。';
        color = 'var(--yellow)';
      } else if (noiseCount > 0) {
        priority = 'P3';
        action = '暂时不用改 skill';
        reason = '当前只有文件不存在、权限、文件过大或工具失败这类记录。它们更像运行环境或工具限制，默认不作为 skill 修改依据。';
        color = 'var(--text-muted)';
      }
      const topItem = groupItems[0];
      return {
        skillName: row.skillName,
        priority,
        action,
        reason,
        color,
        evidenceCount: groupItems.reduce((sum, item) => sum + item.occurrences, 0),
        anchor: skillAnchor(row.skillName),
        sample: topItem ? evidenceConclusion(topItem) : '',
      };
    })
    .sort((a, b) => {
      const rank: Record<string, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
      const byPriority = (rank[b.priority] ?? 0) - (rank[a.priority] ?? 0);
      if (byPriority !== 0) return byPriority;
      return b.evidenceCount - a.evidenceCount;
    });
  const actionRows = actionItems.slice(0, 8).map((item) => `
    <tr data-observe-rollup-row data-skill-anchor="${e(item.anchor)}" style="cursor:pointer">
      <td style="padding:9px 10px;color:${item.color};font-weight:700">${e(item.priority)}</td>
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(item.skillName)}</td>
      <td style="padding:9px 10px;color:var(--text-primary);font-weight:650">${e(item.action)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${e(item.reason)}</td>
      <td class="num" style="padding:9px 10px;text-align:right">${item.evidenceCount}</td>
    </tr>
  `).join('');
  const funnelRows = [
    {
      stage: '1. 调用 skill',
      status: '当前能统计',
      count: totalSkillInvocations,
      desc: '用户或 agent 是否真的用了某个 skill。这里统计的是 trace 中识别到的 skill 调用次数，已排除没有归属到具体 skill 的 general 片段。',
    },
    {
      stage: '2. 运行过程中',
      status: '当前能统计',
      count: allItems.filter((item) => item.signalType === 'failed_search' || item.signalType === 'repeated_failure').reduce((sum, item) => sum + item.occurrences, 0),
      desc: 'skill 运行时，agent 调用了 Read、Grep、Bash 等工具。这里统计工具查找失败、读取失败、Bash 命令异常等记录。',
    },
    {
      stage: '3. 回答阶段',
      status: '只能部分统计',
      count: allItems.filter((item) => item.signalType === 'hedging' || item.signalType === 'explicit_marker').reduce((sum, item) => sum + item.occurrences, 0),
      desc: 'agent 给出回答时，是否出现“不确定、没找到、需要确认”等表达。它只能作为弱信号，不能单独证明 skill 有问题。',
    },
    {
      stage: '4. skill 调用是否跑完',
      status: '只能部分统计',
      count: totalSkillInvocations,
      desc: '当前只能确认 trace 里出现了完整的 skill 调用片段。tool_result 能说明单个工具是否成功，但还不能证明整个 skill 调用产出了正确结果。',
    },
    {
      stage: '5. 用户目标是否完成',
      status: '当前不能统计',
      count: '—',
      desc: '当前不统计。trace 里的 tool_result 只能说明某次工具调用成功或失败，不能证明用户目标已经完成、答案被接受，或用户没有换 session 继续问。',
    },
    {
      stage: '6. 改版后是否变好',
      status: '当前不能统计',
      count: '—',
      desc: '当前不统计。还没有把 SKILL.md 的版本、改动时间和 过程发现 趋势关联起来，所以不能判断 v2 是否比 v1 更好。',
    },
  ];
  const funnelHtml = funnelRows.map((row, index) => {
    const color = row.status === '当前能统计' ? 'var(--green)' : row.status === '只能部分统计' ? 'var(--yellow)' : 'var(--text-muted)';
    const width = Math.max(66, 100 - index * 6);
    return `<div style="width:${width}%;min-width:230px;margin:0 auto;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);position:relative">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <span style="font-weight:650;color:var(--text-primary);line-height:1.3;font-size:12px">${e(row.stage)}</span>
        <span style="font-size:11px;color:${color};font-weight:650;white-space:nowrap">${e(row.status)}</span>
      </div>
      <div style="font-size:17px;font-weight:700;margin-top:3px;color:var(--text-primary)">${e(String(row.count))}</div>
      <div
        class="signal-help"
        tabindex="0"
        data-signal-title="${e(row.stage)}"
        data-signal-description="${e(row.desc)}"
        aria-label="${e(row.desc)}"
        style="font-size:11px;color:var(--text-muted);line-height:1.35;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:help"
      >${e(row.desc)}</div>
    </div>`;
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
      <h3 style="font-size:14px;margin:0 0 8px;color:var(--text-primary)">过程发现 JSON ${index + 1}</h3>
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
      <p style="color:var(--text-muted);font-size:13px">真实 session trace 中聚合出的待 review 问题。判断把握表示这条 过程发现 的规则判断有多确定；归属把握表示它归到当前 skill 名下有多确定。</p>
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
          <div style="color:var(--text-muted);font-size:12px">个 skill 有高风险</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">低风险/抽样确认</div>
          <div style="font-size:24px;font-weight:700;color:var(--yellow);margin-top:4px">${countSkillsBySeverity('medium', 'low')}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 是低风险或不确定</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">无异常/无需改 skill</div>
          <div style="font-size:24px;font-weight:700;color:var(--text-muted);margin-top:4px">${severitySkillCounts.noise}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 无异常，仅路径/权限/工具问题</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">数据范围</div>
          <div style="font-size:18px;font-weight:700;margin-top:6px">${skillCount} trace skills</div>
          <div style="color:var(--text-muted);font-size:12px">${totalSkillInvocations} skill 调用 · ${allItems.length} 过程发现</div>
          <div style="color:var(--text-muted);font-size:12px">${reportCount} reports · latest ${e(latestSeenLabel)}</div>
        </div>
      </section>
      <section style="margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:13px 14px;border-bottom:1px solid var(--border)">
          <div>
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Skill 健康度看板</h2>
            <div style="color:var(--text-muted);font-size:12px;margin-top:3px">一行一个 skill。子项指标同时汇总 trace 工具调用和 过程发现 信号：工具调用看运行行为，过程发现 看发现的问题类型。</div>
          </div>
          <div style="color:var(--text-muted);font-size:12px;white-space:nowrap">${skillRollups.length} trace skills</div>
        </div>
        <div style="width:100%;max-height:70vh;overflow:auto">
          <table style="border-collapse:collapse;width:100%;min-width:1340px;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
            <colgroup>
              <col style="width:210px">
              <col style="width:82px">
              <col style="width:82px">
              <col style="width:96px">
              <col style="width:340px">
              <col style="width:82px">
              <col style="width:96px">
              <col style="width:92px">
              <col style="width:142px">
              <col style="width:142px">
              <col style="width:92px">
              <col style="width:96px">
            </colgroup>
            <thead><tr>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Skill</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">调用</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">Session</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">过程发现</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">子项指标</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">高风险</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">低风险</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">路径/工具</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">最近发现问题</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">最近使用</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">来源</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">Review</th>
            </tr></thead>
            <tbody>${skillRollupRows}</tbody>
          </table>
        </div>
      </section>
      <section style="margin-top:16px;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:12px;align-items:start">
        <section id="observe-action-panel" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden;display:flex;flex-direction:column">
          <div style="padding:13px 14px;border-bottom:1px solid var(--border)">
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Reviewer 待办建议</h2>
            <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这张表回答“我现在该先看哪个 skill、看什么”。它只给 review 优先级，不自动判定必须改。点击行可跳到对应 skill 明细。</div>
          </div>
          ${actionRows ? `<div style="width:100%;overflow:auto;flex:1;min-height:0">
            <table style="border-collapse:collapse;width:100%;min-width:760px;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
              <colgroup>
                <col style="width:58px">
                <col style="width:210px">
                <col style="width:170px">
                <col style="width:auto">
                <col style="width:70px">
              </colgroup>
              <thead><tr>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">P</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Skill</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">现在要做什么</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">为什么这么建议</th>
                <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">次数</th>
              </tr></thead>
              <tbody>${actionRows}</tbody>
            </table>
          </div>` : `<div style="padding:14px;color:var(--text-muted);font-size:13px">当前没有需要 review 的 过程发现。</div>`}
        </section>
        <section id="observe-funnel-panel" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);padding:13px 14px;box-sizing:border-box;overflow:hidden">
          <h2 style="font-size:15px;margin:0;color:var(--text-primary)">当前可观测漏斗</h2>
          <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这张表说明 OMK 现在能统计用户使用 skill 的哪几步。不能统计的项不会在本报告里伪装成结论。</div>
          <div style="display:grid;grid-template-columns:1fr;gap:6px;margin-top:10px">${funnelHtml}</div>
        </section>
      </section>
      <section style="margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);font-size:13px;line-height:1.6">
        <strong>Reviewer path:</strong>
        先看 <span style="color:var(--red);font-weight:650">高风险/需关注</span>；
        “低风险”表示通常不需要改 skill，只需要抽样确认；
        “无异常”表示更像环境、路径、权限或工具限制。
        展开行看判断原因和原始 evidence，必要时到 过程发现 JSON / 打标 tab 查完整结构。
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
            <li>最后看要不要改 skill：只有像 skill 没写清楚、没覆盖路径/流程时，才进入“高风险/需关注”。</li>
          </ol>
          <table style="border-collapse:collapse;width:100%;font-size:12px">
            <thead><tr>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">页面判断</th>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">规则来源</th>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">怎么处理</th>
            </tr></thead>
            <tbody>
              <tr>
                <td style="padding:7px 8px;color:var(--red);font-weight:650">高风险/需关注</td>
                <td style="padding:7px 8px">hard_miss、repeated_failure、明确标了未知/缺口。通常表示查找失败后，没有看到后续找到同主题结果。</td>
                <td style="padding:7px 8px">优先看。确认 skill 是否漏了入口、路径、流程、约束或常见问题。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--yellow);font-weight:650">低风险/抽样确认</td>
                <td style="padding:7px 8px">Bash 里有 ls/find、2&gt;/dev/null、|| true 等试目录/试路径写法，或前面没找到但后面又找到了。</td>
                <td style="padding:7px 8px">通常不需要改 skill；抽样确认是否反复浪费时间。只有反复发生时，再考虑给 skill 补“推荐查找路径”。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--accent);font-weight:650">不确定/低优先级</td>
                <td style="padding:7px 8px">模型文本里说“不确定/需要确认”等，但没有强工具证据。</td>
                <td style="padding:7px 8px">低优先级看。只有它影响最终答案时，才考虑改 skill。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--text-muted);font-weight:650">无异常/无需改 skill：路径/工具问题</td>
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
        <button type="button" data-severity-filter="high" onclick="setObserveSeverityFilter('high')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">高风险/需关注</button>
        <button type="button" data-severity-filter="medium" onclick="setObserveSeverityFilter('medium')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">低风险</button>
        <button type="button" data-severity-filter="noise" onclick="setObserveSeverityFilter('noise')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">路径/工具问题</button>
      </section>
      <div style="display:flex;gap:8px;margin-top:18px;border-bottom:1px solid var(--border)">
        <button type="button" data-observe-tab-button="review" onclick="showObservationTab('review')" style="font-size:13px;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background:var(--bg-surface);border-radius:6px 6px 0 0;cursor:pointer">${lang === 'zh' ? 'Skill 下钻明细' : 'Skill Details'}</button>
        <button type="button" data-observe-tab-button="raw" onclick="showObservationTab('raw')" style="font-size:13px;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background:var(--bg);border-radius:6px 6px 0 0;cursor:pointer">${lang === 'zh' ? '过程发现 JSON / 打标' : '过程发现 JSON / Tags'}</button>
      </div>
      <section id="observe-tab-review" style="margin-top:4px">
        ${items.length > 0 ? skillSections : ''}
      </section>
      <section id="observe-tab-raw" style="display:none">
        <p style="color:var(--text-muted);font-size:13px;margin:16px 0 8px">这里展示 过程发现 JSON 文件里的原始结构，以及已经计算出的 severity / signal / subtype / confidence / attributionConfidence 等分类打标。</p>
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
        </table>${rawReportBlocks}` : `<p style="color:var(--text-muted);margin-top:24px">${lang === 'zh' ? '暂无过程发现 JSON。' : 'No observation JSON yet.'}</p>`}
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
        async function openObservationTrace(id, btn) {
          var target = document.getElementById('trace-' + id);
          if (!target) return;
          var open = target.style.display !== 'none';
          if (open) {
            target.style.display = 'none';
            if (btn) btn.textContent = 'Open in trace';
            return;
          }
          target.style.display = 'block';
          target.textContent = 'Loading...';
          if (btn) btn.textContent = 'Hide trace';
          try {
            var res = await fetch('/api/observations/show?id=' + encodeURIComponent(id));
            var data = await res.json();
            target.textContent = data.text || data.error || '';
          } catch (err) {
            target.textContent = String(err && err.message ? err.message : err);
          }
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
        (function setupSkillRollupRows() {
          var rows = document.querySelectorAll('[data-observe-rollup-row]');
          for (var i = 0; i < rows.length; i++) {
            rows[i].addEventListener('click', function () {
              var id = this.getAttribute('data-skill-anchor');
              if (!id) return;
              var target = document.getElementById(id);
              if (!target) return;
              target.open = true;
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          }
        })();
        (function syncActionPanelHeight() {
          var action = document.getElementById('observe-action-panel');
          var funnel = document.getElementById('observe-funnel-panel');
          if (!action || !funnel) return;
          function sync() {
            action.style.height = '';
            var h = Math.max(funnel.scrollHeight, funnel.offsetHeight);
            if (h > 0) action.style.height = h + 'px';
          }
          sync();
          window.addEventListener('resize', sync);
          if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync).catch(function () {});
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

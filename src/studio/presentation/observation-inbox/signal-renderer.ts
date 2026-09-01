import type { Lang } from '../../../shared/language.js';
import { severityReasonFor } from '../../../observability/inbox/view-model.js';
import type { ObservationInboxItem } from '../../../observability/inbox/view-model.js';
import { e } from '../layout.js';

export type ObservationSignalRenderers = ReturnType<typeof createObservationSignalRenderers>;

export function createObservationSignalRenderers(lang: Lang) {
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
    const label = item.sourceKind === 'dsh' ? 'DeepSeek Harness' : item.sourceKind === 'openclaw' ? 'OpenClaw' : item.sourceKind === 'codex' ? 'Codex' : item.sourceKind === 'markdown_log' ? 'Markdown log' : item.sourceKind === 'claude' ? 'Claude' : 'Unknown';
    const color = item.sourceKind === 'dsh' ? '#0f766e' : item.sourceKind === 'openclaw' ? '#7c3aed' : item.sourceKind === 'codex' ? '#1677ff' : item.sourceKind === 'markdown_log' ? 'var(--green)' : item.sourceKind === 'claude' ? 'var(--accent)' : 'var(--text-muted)';
    return `<span title="调用日志来源：${e(label)}" style="display:inline-flex;margin-top:4px;padding:2px 6px;border-radius:999px;background:var(--bg-muted);color:${color};font-size:11px;font-weight:650">${e(label)}</span>`;
  };
  return {
    evidenceConclusion,
    renderEvidenceCell,
    renderEvidenceDetailList,
    renderOccurrences,
    renderSeverityBadge,
    renderSignalLabel,
    renderSourceBadge,
    reviewSeverityMeta,
    semanticEvidence,
    signalRuleDescription,
  };
}

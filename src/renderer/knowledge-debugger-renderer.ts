import type { Lang } from '../types/index.js';
import type {
  DebugKnowledgeAccessKind,
  DebugKnowledgeEvidence,
  KnowledgeDebuggerViewModel,
  TaskReplayIntegrityCode,
  TaskReplayStep,
  TaskReplayStepKind,
} from '../types/index.js';
import { DEFAULT_LANG, e, layout } from './layout.js';

const ACCESS_LABELS: Record<DebugKnowledgeAccessKind, Record<Lang, string>> = {
  injected: { zh: '进入上下文', en: 'Injected into context' },
  read: { zh: '被读取', en: 'Read' },
  returned: { zh: '工具返回', en: 'Returned by tool' },
};

const STEP_LABELS: Record<TaskReplayStepKind, Record<Lang, string>> = {
  user_request: { zh: '用户请求', en: 'User request' },
  user_message: { zh: '用户补充', en: 'User follow-up' },
  user_correction: { zh: '用户纠正', en: 'User correction' },
  runtime_context: { zh: '运行时上下文', en: 'Runtime context' },
  skill_context: { zh: 'Skill 上下文', en: 'Skill context' },
  tool_exchange: { zh: '工具执行', en: 'Tool execution' },
  unmatched_tool_result: { zh: '未配对工具结果', en: 'Unmatched tool result' },
  assistant_message: { zh: 'AI 回答', en: 'AI response' },
  observation: { zh: '观测事件', en: 'Observation' },
  system_event: { zh: '系统事件', en: 'System event' },
};

const INTEGRITY_LABELS: Record<TaskReplayIntegrityCode, (count: number, lang: Lang) => string> = {
  timeline_truncated: (_count, lang) => lang === 'zh' ? '当前时间线被截断' : 'The timeline is truncated',
  malformed_records: (count, lang) => lang === 'zh' ? `${count} 条格式损坏记录` : `${count} malformed record${count === 1 ? '' : 's'}`,
  ignored_values: (count, lang) => lang === 'zh' ? `${count} 个非对象值被忽略` : `${count} non-object value${count === 1 ? '' : 's'} ignored`,
  unknown_events: (count, lang) => lang === 'zh' ? `${count} 个事件无法识别` : `${count} unrecognized event${count === 1 ? '' : 's'}`,
  unmatched_tool_calls: (count, lang) => lang === 'zh' ? `${count} 次工具调用缺少结果` : `${count} tool call${count === 1 ? '' : 's'} without results`,
  unmatched_tool_results: (count, lang) => lang === 'zh' ? `${count} 条工具结果无法配对` : `${count} tool result${count === 1 ? '' : 's'} could not be paired`,
  missing_timestamps: (count, lang) => lang === 'zh' ? `${count} 个事件缺少时间戳` : `${count} event${count === 1 ? '' : 's'} without timestamps`,
};

export function renderKnowledgeDebuggerPage(
  model: KnowledgeDebuggerViewModel,
  lang: Lang = DEFAULT_LANG,
): string {
  const zh = lang === 'zh';
  const { session, summary, steps, knowledgeEvidence, integrity } = model;
  const evidenceById = new Map(knowledgeEvidence.map((item) => [item.id, item]));

  return layout(zh ? '任务重放' : 'Task Replay', `
    <style>
      .replay-shell{max-width:1120px;margin:0 auto;padding:4px 0 28px;letter-spacing:0}
      .replay-back{display:inline-flex;align-items:center;margin-bottom:14px;color:var(--text-secondary);font-size:13px}
      .replay-back:hover{text-decoration:none;color:var(--accent)}
      .replay-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}
      .replay-eyebrow{margin-bottom:4px;color:var(--accent);font-size:12px;font-weight:700}
      .replay-header h1{margin:0 0 6px;font-size:28px;letter-spacing:0}
      .replay-header p{max-width:720px;margin:0;color:var(--text-secondary);font-size:14px;line-height:1.6}
      .replay-session{display:grid;gap:4px;justify-items:end;max-width:360px;color:var(--text-muted);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;text-align:right}
      .replay-summary{margin-bottom:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden}
      .replay-summary-main{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);gap:0}
      .replay-summary-copy{padding:18px 20px;border-right:1px solid var(--border)}
      .replay-summary-copy h2{margin:0 0 7px;font-size:12px;color:var(--text-muted);font-weight:650}
      .replay-goal{margin:0;color:var(--text-primary);font-size:17px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-outcome{padding:18px 20px;display:grid;align-content:center;gap:7px}
      .replay-outcome-line{display:flex;align-items:center;justify-content:space-between;gap:14px;color:var(--text-secondary);font-size:12px}
      .replay-outcome-line strong{color:var(--text-primary);font-size:13px;font-variant-numeric:tabular-nums}
      .replay-final{padding:13px 20px;border-top:1px solid var(--border);background:var(--bg-soft)}
      .replay-final strong{display:block;margin-bottom:4px;color:var(--text-muted);font-size:11px}
      .replay-final div{color:var(--text-secondary);font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-integrity{display:flex;align-items:flex-start;gap:10px;margin-bottom:18px;padding:11px 13px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface);font-size:12px;color:var(--text-secondary)}
      .replay-integrity.is-partial{border-color:var(--yellow);background:var(--yellow-bg)}
      .replay-integrity-mark{flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--green)}
      .replay-integrity.is-partial .replay-integrity-mark{background:var(--yellow)}
      .replay-integrity strong{color:var(--text-primary)}
      .replay-integrity ul{display:flex;flex-wrap:wrap;gap:5px 16px;margin:4px 0 0;padding:0;list-style:none}
      .replay-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 12px}
      .replay-section-head h2{margin:0;font-size:16px;letter-spacing:0}
      .replay-section-head span{color:var(--text-muted);font-size:12px}
      .replay-list{position:relative;margin-left:17px;padding-left:34px}
      .replay-list:before{content:"";position:absolute;left:0;top:17px;bottom:22px;width:1px;background:var(--border-hover)}
      .replay-step{position:relative;margin-bottom:12px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface)}
      .replay-step:before{content:attr(data-index);position:absolute;left:-51px;top:15px;display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--border-hover);border-radius:50%;background:var(--bg-surface);color:var(--text-secondary);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
      .replay-step.is-correction{border-color:var(--yellow)}
      .replay-step.is-failure{border-color:var(--red)}
      .replay-step-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:12px 14px;border-bottom:1px solid var(--border)}
      .replay-step-heading{min-width:0}
      .replay-step-label{margin-bottom:2px;color:var(--text-muted);font-size:11px;font-weight:650}
      .replay-step-title{color:var(--text-primary);font-size:14px;font-weight:650;overflow-wrap:anywhere}
      .replay-step-meta{flex:none;display:flex;align-items:center;gap:7px;color:var(--text-muted);font-size:11px;font-variant-numeric:tabular-nums}
      .replay-status{border-radius:4px;padding:2px 6px;background:var(--bg-soft);font-weight:650}
      .replay-status.is-success{color:var(--green)}
      .replay-status.is-failure{color:var(--red);background:var(--red-bg)}
      .replay-status.is-unknown,.replay-status.is-cancelled{color:var(--text-secondary)}
      .replay-step-body{padding:13px 14px}
      .replay-message{color:var(--text-secondary);font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-tool{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
      .replay-tool-part{min-width:0;padding:10px 11px;border:1px solid var(--border);border-radius:6px;background:var(--bg-soft)}
      .replay-tool-part strong{display:block;margin-bottom:5px;color:var(--text-muted);font-size:11px}
      .replay-tool-part pre{max-height:260px;margin:0;overflow:auto;color:var(--text-secondary);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-knowledge{display:grid;gap:7px;margin-top:11px;padding-top:11px;border-top:1px solid var(--border)}
      .replay-knowledge-item{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 10px;align-items:start}
      .replay-access{border-radius:4px;padding:2px 6px;background:var(--info-bg);color:var(--accent);font-size:11px;font-weight:650;white-space:nowrap}
      .replay-knowledge-copy{min-width:0;color:var(--text-secondary);font-size:12px;overflow-wrap:anywhere}
      .replay-knowledge-copy strong{color:var(--text-primary)}
      .replay-knowledge-meta{display:block;margin-top:2px;color:var(--text-muted);font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
      .replay-raw{margin-top:10px}
      .replay-raw summary{cursor:pointer;color:var(--accent);font-size:11px}
      .replay-raw-event{margin-top:8px;padding:9px 10px;border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated)}
      .replay-raw-event span{display:block;margin-bottom:4px;color:var(--text-muted);font:10px ui-monospace,SFMono-Regular,Menlo,monospace}
      .replay-raw-event pre{max-height:320px;margin:0;overflow:auto;color:var(--text-secondary);font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-boundary{margin:18px 0 0;padding:11px 13px;border-left:3px solid var(--border-hover);background:var(--bg-soft);color:var(--text-muted);font-size:12px;line-height:1.55}
      @media(max-width:760px){.replay-header{display:grid;gap:10px}.replay-session{justify-items:start;text-align:left;max-width:none}.replay-summary-main{grid-template-columns:1fr}.replay-summary-copy{border-right:0;border-bottom:1px solid var(--border)}.replay-tool{grid-template-columns:1fr}.replay-list{margin-left:14px;padding-left:24px}.replay-step:before{left:-41px;width:26px;height:26px}.replay-step-head{display:grid;gap:7px}.replay-step-meta{justify-content:flex-start}.replay-header h1{font-size:24px}}
    </style>
    <main class="replay-shell">
      <a class="replay-back" href="/observe-inbox${lang === DEFAULT_LANG ? '' : `?lang=${lang}`}">${zh ? '← 返回观测收件箱' : '← Back to observation inbox'}</a>
      <header class="replay-header">
        <div>
          <div class="replay-eyebrow">Knowledge Debugger</div>
          <h1>${zh ? '任务重放' : 'Task Replay'}</h1>
          <p>${zh ? '根据 trace 还原这次任务中可核验的请求、上下文、行动、结果和用户纠正。' : 'A trace-backed replay of the request, context, actions, results, and user corrections observed in this task.'}</p>
        </div>
        <div class="replay-session">
          <span>${e(session.sourceKind)} · ${e(session.sessionId)}</span>
          ${session.cwd ? `<span>${e(session.cwd)}</span>` : ''}
          <span>${e(formatRange(summary.observedStartTimestamp, summary.observedEndTimestamp))}</span>
        </div>
      </header>

      <section class="replay-summary" aria-label="${zh ? '任务摘要' : 'Task summary'}">
        <div class="replay-summary-main">
          <div class="replay-summary-copy">
            <h2>${zh ? '用户最初要求' : 'Original request'}</h2>
            <p class="replay-goal">${e(summary.userGoal ?? (zh ? '当前 trace 中没有可识别的用户请求。' : 'No identifiable user request in this trace.'))}</p>
          </div>
          <div class="replay-outcome">
            <div class="replay-outcome-line"><span>${zh ? '工具调用' : 'Tool calls'}</span><strong>${summary.toolCallCount}</strong></div>
            <div class="replay-outcome-line"><span>${zh ? '工具失败' : 'Tool failures'}</span><strong>${summary.toolFailureCount}</strong></div>
            <div class="replay-outcome-line"><span>${zh ? '用户纠正' : 'User correction'}</span><strong>${summary.hasUserCorrection ? (zh ? '有' : 'Observed') : (zh ? '未识别' : 'Not identified')}</strong></div>
          </div>
        </div>
        ${summary.finalResponse ? `<div class="replay-final"><strong>${zh ? 'AI 最后一次回答' : 'Last AI response'}</strong><div>${e(summary.finalResponse)}</div></div>` : ''}
      </section>

      <section class="replay-integrity ${integrity.status === 'partial' ? 'is-partial' : ''}">
        <span class="replay-integrity-mark" aria-hidden="true"></span>
        <div><strong>${integrity.status === 'complete' ? (zh ? '当前未发现 trace 完整性问题' : 'No trace integrity issues detected') : (zh ? '这次重放可能不完整' : 'This replay may be incomplete')}</strong>
        ${integrity.notices.length > 0 ? `<ul>${integrity.notices.map((notice) => `<li>${e(INTEGRITY_LABELS[notice.code](notice.count, lang))}</li>`).join('')}</ul>` : ''}</div>
      </section>

      <div class="replay-section-head"><h2>${zh ? '发生了什么' : 'What happened'}</h2><span>${steps.length} ${zh ? '个任务步骤' : steps.length === 1 ? 'task step' : 'task steps'}</span></div>
      <section class="replay-list">
        ${steps.map((step, index) => renderStep(step, index, evidenceById, lang)).join('')}
      </section>

      <div class="replay-boundary">${zh
        ? '本页只陈述 trace 中可核验的事实。Knowledge 进入上下文、被读取或由工具返回，不代表模型实际采用了它，也不能单独证明成功或失败的原因。'
        : 'This page only states facts observable in the trace. Knowledge being injected, read, or returned does not prove that the model used it or that it caused the outcome.'}</div>
    </main>
  `, lang);
}

function renderStep(
  step: TaskReplayStep,
  index: number,
  evidenceById: Map<string, DebugKnowledgeEvidence>,
  lang: Lang,
): string {
  const zh = lang === 'zh';
  const evidence = step.knowledgeEvidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is DebugKnowledgeEvidence => Boolean(item));
  const classes = [
    step.stepKind === 'user_correction' ? 'is-correction' : '',
    step.toolStatus === 'failure' ? 'is-failure' : '',
  ].filter(Boolean).join(' ');
  const title = stepTitle(step, lang, evidence);

  return `<article class="replay-step ${classes}" data-index="${index + 1}">
    <header class="replay-step-head">
      <div class="replay-step-heading"><div class="replay-step-label">${e(STEP_LABELS[step.stepKind][lang])}</div><div class="replay-step-title">${e(title)}</div></div>
      <div class="replay-step-meta">${step.toolStatus ? renderToolStatus(step.toolStatus, lang) : ''}${step.timestamp ? `<time>${e(formatTimestamp(step.timestamp))}</time>` : ''}</div>
    </header>
    <div class="replay-step-body">
      ${step.stepKind === 'tool_exchange' ? renderToolExchange(step, lang) : `<div class="replay-message">${e(eventPreview(step.events[0], zh ? '没有可展示的事件内容。' : 'No event content available.'))}</div>`}
      ${evidence.length > 0 ? `<div class="replay-knowledge">${evidence.map((item) => renderKnowledge(item, lang)).join('')}</div>` : ''}
      <details class="replay-raw"><summary>${zh ? '查看原始 trace 证据' : 'View raw trace evidence'}</summary>${step.events.map((event) => `<div class="replay-raw-event" id="event-${e(event.id)}"><span>${e(event.kind)} · ${e(event.id)}${event.sourceLineIndex !== undefined ? ` · line ${event.sourceLineIndex}` : ''}</span><pre>${e(event.fullText ?? event.snippet ?? '')}</pre></div>`).join('')}</details>
    </div>
  </article>`;
}

function renderToolExchange(step: TaskReplayStep, lang: Lang): string {
  const zh = lang === 'zh';
  const call = step.events[0];
  const result = step.events[1];
  return `<div class="replay-tool">
    <div class="replay-tool-part"><strong>${zh ? '调用' : 'Call'}</strong><pre>${e(toolInputPreview(call))}</pre></div>
    <div class="replay-tool-part"><strong>${zh ? '实际结果' : 'Observed result'}</strong><pre>${e(result ? eventPreview(result, zh ? '工具没有返回内容。' : 'The tool returned no content.') : (zh ? '当前 trace 中没有匹配到工具结果。' : 'No matching tool result in this trace.'))}</pre></div>
  </div>`;
}

function renderKnowledge(item: DebugKnowledgeEvidence, lang: Lang): string {
  const source = item.sourceLocator ?? '';
  const hash = item.contentHash ? `sha256:${item.contentHash.slice(0, 12)}` : '';
  return `<div class="replay-knowledge-item">
    <span class="replay-access">${e(ACCESS_LABELS[item.accessKind][lang])}</span>
    <div class="replay-knowledge-copy"><strong>${e(item.label)}</strong>${source || hash ? `<span class="replay-knowledge-meta">${e([source, hash].filter(Boolean).join(' · '))}</span>` : ''}</div>
  </div>`;
}

function renderToolStatus(status: NonNullable<TaskReplayStep['toolStatus']>, lang: Lang): string {
  const labels = {
    success: { zh: '成功', en: 'Success' },
    failure: { zh: '失败', en: 'Failed' },
    cancelled: { zh: '取消', en: 'Cancelled' },
    unknown: { zh: '状态未知', en: 'Unknown' },
  } as const;
  return `<span class="replay-status is-${status}">${e(labels[status][lang])}</span>`;
}

function stepTitle(
  step: TaskReplayStep,
  lang: Lang,
  evidence: DebugKnowledgeEvidence[],
): string {
  if (step.stepKind === 'runtime_context' && evidence.length > 0) {
    return lang === 'zh' ? `${evidence.map((item) => item.label).join('、')} 进入任务上下文` : `${evidence.map((item) => item.label).join(', ')} entered task context`;
  }
  if (step.stepKind === 'skill_context' && evidence.length > 0) {
    return lang === 'zh' ? `${evidence.map((item) => item.label).join('、')} 进入任务上下文` : `${evidence.map((item) => item.label).join(', ')} entered task context`;
  }
  if (step.stepKind === 'tool_exchange') return step.title;
  return STEP_LABELS[step.stepKind][lang];
}

function toolInputPreview(event: TaskReplayStep['events'][number] | undefined): string {
  if (!event) return '';
  const text = event.fullText ?? event.snippet ?? '';
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>;
      for (const key of ['cmd', 'command', 'file_path', 'path', 'url', 'query']) {
        if (typeof input[key] === 'string' && input[key]) return input[key];
      }
      return JSON.stringify(value, null, 2);
    }
  } catch {
    // Keep the source text when the tool input is not JSON.
  }
  return text;
}

function eventPreview(event: TaskReplayStep['events'][number] | undefined, fallback: string): string {
  return event?.fullText?.trim() || event?.snippet?.trim() || fallback;
}

function formatTimestamp(value: string): string {
  return value.slice(0, 19).replace('T', ' ');
}

function formatRange(start?: string, end?: string): string {
  if (!start && !end) return '';
  if (!start) return formatTimestamp(end ?? '');
  if (!end) return formatTimestamp(start);
  return `${formatTimestamp(start)} → ${formatTimestamp(end)}`;
}

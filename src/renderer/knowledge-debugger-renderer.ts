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
  injected: { zh: '进入任务上下文', en: 'Entered task context' },
  read: { zh: '被读取', en: 'Read' },
  returned: { zh: '由工具返回', en: 'Returned by a tool' },
};

const STEP_LABELS: Record<TaskReplayStepKind, Record<Lang, string>> = {
  user_request: { zh: '用户要求', en: 'User request' },
  user_message: { zh: '用户补充', en: 'User follow-up' },
  user_correction: { zh: '用户纠正', en: 'User correction' },
  runtime_context: { zh: '任务上下文', en: 'Task context' },
  skill_context: { zh: 'Skill 上下文', en: 'Skill context' },
  tool_exchange: { zh: 'AI 执行', en: 'AI actions' },
  unmatched_tool_result: { zh: '未配对工具结果', en: 'Unmatched tool result' },
  assistant_message: { zh: 'AI 回答', en: 'AI response' },
  observation: { zh: '观测事件', en: 'Observation' },
  system_event: { zh: '系统事件', en: 'System event' },
};

const INTEGRITY_LABELS: Record<TaskReplayIntegrityCode, (count: number, lang: Lang) => string> = {
  timeline_truncated: (_count, lang) => lang === 'zh' ? '时间线被截断' : 'Timeline truncated',
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
  const pageTitle = summary.userGoal ?? (zh ? '未识别到用户要求' : 'No user request identified');

  return layout(zh ? '任务重放' : 'Task Replay', `
    <style>
      .replay-shell{max-width:980px;margin:0 auto;padding:4px 0 36px;letter-spacing:0}
      .replay-topbar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:22px}
      .replay-back{display:inline-flex;align-items:center;color:var(--text-secondary);font-size:13px}
      .replay-back:hover{text-decoration:none;color:var(--accent)}
      .replay-mode{display:inline-flex;padding:3px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface)}
      .replay-mode button{min-width:68px;padding:5px 10px;border:0;border-radius:5px;background:transparent;color:var(--text-muted);font:600 12px/1.4 inherit;letter-spacing:0;cursor:pointer}
      .replay-mode button[aria-pressed="true"]{background:var(--text-primary);color:var(--bg-surface)}
      .replay-mode button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      .replay-header{margin-bottom:22px}
      .replay-eyebrow{margin-bottom:7px;color:var(--accent);font-size:12px;font-weight:700}
      .replay-header h1{max-width:880px;margin:0 0 11px;font-size:30px;font-weight:650;line-height:1.3;letter-spacing:0;overflow-wrap:anywhere}
      .replay-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;color:var(--text-muted);font-size:12px}
      .replay-meta span{display:inline-flex;align-items:center;gap:6px}
      .replay-meta span+span:before{content:"";width:3px;height:3px;border-radius:50%;background:var(--border-hover)}
      .replay-fact{margin-bottom:18px;padding:16px 18px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-surface)}
      .replay-fact-label{margin-bottom:6px;color:var(--text-muted);font-size:11px;font-weight:700}
      .replay-fact p{margin:0;color:var(--text-primary);font-size:15px;line-height:1.7;overflow-wrap:anywhere}
      .replay-knowledge-index{display:grid;grid-template-columns:150px minmax(0,1fr);gap:18px;margin-bottom:28px;padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
      .replay-knowledge-index-label{color:var(--text-muted);font-size:11px;font-weight:700}
      .replay-knowledge-index-items{display:flex;flex-wrap:wrap;gap:7px 22px}
      .replay-knowledge-link{display:inline-flex;align-items:baseline;gap:7px;color:var(--text-primary);font-size:12px}
      .replay-knowledge-link:hover{text-decoration:none;color:var(--accent)}
      .replay-knowledge-link strong{font-weight:650}
      .replay-knowledge-link span{color:var(--accent);font-size:10px;font-weight:650}
      .replay-integrity-warning{display:flex;align-items:flex-start;gap:9px;margin:-4px 0 24px;padding:10px 12px;border-left:2px solid var(--yellow);background:var(--yellow-bg);color:var(--text-secondary);font-size:11px;line-height:1.55}
      .replay-integrity-warning strong{display:block;color:var(--text-primary)}
      .replay-integrity-warning ul{display:flex;flex-wrap:wrap;gap:2px 18px;margin:4px 0 0;padding-left:16px}
      .replay-workspace{max-width:900px}
      .replay-section-head{margin-bottom:14px}
      .replay-section-head h2{margin:0;font-size:16px;font-weight:650;letter-spacing:0}
      .replay-stream{position:relative}
      .replay-stream:before{content:"";position:absolute;left:76px;top:18px;bottom:22px;width:1px;background:var(--border)}
      .replay-beat{position:relative;display:grid;grid-template-columns:60px 32px minmax(0,1fr);margin-bottom:6px;padding:12px 0}
      .replay-beat-time{padding-top:2px;color:var(--text-muted);font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right;font-variant-numeric:tabular-nums}
      .replay-beat-mark{position:relative}
      .replay-beat-mark:before{content:"";position:absolute;left:12px;top:5px;width:7px;height:7px;border:2px solid var(--bg-base);border-radius:50%;background:var(--text-muted);box-shadow:0 0 0 1px var(--border-hover)}
      .replay-beat.is-context .replay-beat-mark:before{background:var(--accent)}
      .replay-beat.is-failure .replay-beat-mark:before{background:var(--red)}
      .replay-beat.is-correction .replay-beat-mark:before{background:var(--yellow)}
      .replay-beat-label{margin-bottom:5px;color:var(--text-muted);font-size:11px;font-weight:700}
      .replay-beat-content{min-width:0;padding:0 0 17px;border-bottom:1px solid var(--border)}
      .replay-beat:last-child .replay-beat-content{border-bottom:0}
      .replay-message{margin:0;color:var(--text-primary);font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-message.is-quote{padding-left:14px;border-left:2px solid var(--border-hover)}
      .replay-beat.is-correction .replay-beat-content{margin-top:-6px;padding:12px 14px 14px;border:1px solid rgba(217,119,6,.28);border-radius:7px;background:rgba(217,119,6,.06)}
      .replay-beat.is-correction .replay-message{border-left-color:var(--yellow)}
      .replay-context-list{display:grid;gap:7px}
      .replay-context-item{display:flex;align-items:baseline;justify-content:space-between;gap:18px;color:var(--text-secondary);font-size:13px}
      .replay-context-item strong{color:var(--text-primary);font-weight:600}
      .replay-context-item span{flex:none;color:var(--accent);font-size:11px;font-weight:600}
      .replay-tools-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:8px}
      .replay-tools-head strong{font-size:14px;font-weight:650}
      .replay-tools-head span{color:var(--text-muted);font-size:11px}
      .replay-tool-list{border-top:1px solid var(--border)}
      .replay-tool-row{padding:11px 0;border-bottom:1px solid var(--border)}
      .replay-tool-row:last-child{border-bottom:0}
      .replay-tool-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:start}
      .replay-tool-title{color:var(--text-primary);font-size:13px;font-weight:600;line-height:1.55;overflow-wrap:anywhere}
      .replay-tool-command{margin-top:3px;color:var(--text-muted);font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-status{align-self:start;padding:2px 6px;border-radius:4px;background:var(--bg-soft);color:var(--text-secondary);font-size:10px;font-weight:700;white-space:nowrap}
      .replay-status.is-success,.replay-status.is-returned{color:var(--green)}
      .replay-status.is-failure{color:var(--red);background:var(--red-bg)}
      .replay-status.is-unknown,.replay-status.is-cancelled{color:var(--text-secondary)}
      .replay-tool-result{margin-top:9px;padding:9px 11px;border-left:2px solid var(--red);background:rgba(220,38,38,.05);color:var(--text-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-tool-result strong{display:block;margin-bottom:3px;color:var(--red);font-size:10px}
      .replay-raw{margin-top:8px}
      .replay-shell[data-mode="reading"] .replay-raw{display:none}
      .replay-raw summary{width:max-content;max-width:100%;cursor:pointer;color:var(--text-muted);font-size:10px;font-weight:600}
      .replay-raw summary:hover{color:var(--accent)}
      .replay-raw-event{margin-top:8px;padding:9px 10px;border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated)}
      .replay-raw-event span{display:block;margin-bottom:4px;color:var(--text-muted);font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
      .replay-raw-event pre{max-height:320px;margin:0;overflow:auto;color:var(--text-secondary);font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .replay-evidence-footer{display:none;margin-top:24px;padding-top:14px;border-top:1px solid var(--border)}
      .replay-shell[data-mode="evidence"] .replay-evidence-footer{display:grid;gap:14px}
      .replay-session-details summary{cursor:pointer;color:var(--text-secondary);font-size:11px;font-weight:600}
      .replay-session-copy{display:grid;gap:5px;margin-top:8px;color:var(--text-muted);font:9px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
      .replay-boundary{padding:11px 12px;border-left:2px solid var(--border-hover);background:var(--bg-soft);color:var(--text-muted);font-size:10px;line-height:1.65}
      @media(max-width:640px){.replay-shell{padding-bottom:24px}.replay-topbar{margin-bottom:18px}.replay-header h1{font-size:24px}.replay-fact{padding:15px 16px;margin-bottom:16px}.replay-knowledge-index{grid-template-columns:1fr;gap:7px;margin-bottom:22px}.replay-stream:before{left:7px}.replay-beat{grid-template-columns:22px minmax(0,1fr);padding:10px 0}.replay-beat-time{grid-column:2;text-align:left;margin-bottom:4px}.replay-beat-mark{grid-column:1;grid-row:1/3}.replay-beat-mark:before{left:3px}.replay-beat-content{grid-column:2}.replay-beat.is-correction .replay-beat-content{margin-top:0}.replay-meta{gap:5px 12px}}
    </style>
    <main class="replay-shell" data-mode="reading">
      <div class="replay-topbar">
        <a class="replay-back" href="/observe-inbox${lang === DEFAULT_LANG ? '' : `?lang=${lang}`}">${zh ? '← 返回观测收件箱' : '← Back to observation inbox'}</a>
        <div class="replay-mode" aria-label="${zh ? '阅读密度' : 'Reading density'}">
          <button type="button" data-replay-mode="reading" aria-pressed="true">${zh ? '阅读' : 'Read'}</button>
          <button type="button" data-replay-mode="evidence" aria-pressed="false">${zh ? '证据' : 'Evidence'}</button>
        </div>
      </div>

      <header class="replay-header">
        <div class="replay-eyebrow">${zh ? '任务重放' : 'Task Replay'}</div>
        <h1>${e(pageTitle)}</h1>
        <div class="replay-meta">
          <span>${e(session.sourceKind)}</span>
          <span>${e(formatDuration(summary.observedStartTimestamp, summary.observedEndTimestamp, lang))}</span>
          <span>${integrity.status === 'complete' ? (zh ? 'Trace 完整' : 'Trace complete') : (zh ? 'Trace 可能不完整' : 'Trace may be incomplete')}</span>
        </div>
      </header>

      <section class="replay-fact" aria-label="${zh ? '事实摘要' : 'Factual summary'}">
        <div class="replay-fact-label">${zh ? '事实摘要' : 'FACTUAL SUMMARY'}</div>
        <p>${e(buildFactSummary(model, lang))}</p>
      </section>

      ${renderKnowledgeIndex(knowledgeEvidence, steps, lang)}
      ${renderIntegrityWarning(model, lang)}

      <div class="replay-workspace">
        <section aria-labelledby="replay-timeline-title">
          <div class="replay-section-head"><h2 id="replay-timeline-title">${zh ? '任务经过' : 'Task timeline'}</h2></div>
          <div class="replay-stream">
            ${renderTimeline(steps, evidenceById, lang)}
          </div>
        </section>
        <div class="replay-evidence-footer">
          <details class="replay-session-details"><summary>${zh ? '任务信息' : 'Task information'}</summary><div class="replay-session-copy">
            <span>${e(session.sourceKind)} · ${e(session.sessionId)}</span>
            ${session.cwd ? `<span>${e(session.cwd)}</span>` : ''}
            <span>${e(formatRange(summary.observedStartTimestamp, summary.observedEndTimestamp))}</span>
          </div></details>
          <div class="replay-boundary">${zh
            ? '本页只陈述 trace 中可核验的事实。Knowledge 进入上下文、被读取或由工具返回，不代表模型实际采用了它，也不能单独证明成功或失败的原因。'
            : 'This page only states facts observable in the trace. Knowledge being injected, read, or returned does not prove that the model used it or that it caused the outcome.'}</div>
        </div>
      </div>
    </main>
    <script>
      (() => {
        const shell = document.querySelector('.replay-shell');
        const buttons = document.querySelectorAll('[data-replay-mode]');
        if (!shell) return;
        const setMode = (mode) => {
          shell.dataset.mode = mode;
          buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.replayMode === mode)));
          document.querySelectorAll('.replay-raw').forEach((details) => { details.open = mode === 'evidence'; });
        };
        buttons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.replayMode || 'reading')));
      })();
    </script>
  `, lang);
}

function buildFactSummary(model: KnowledgeDebuggerViewModel, lang: Lang): string {
  const { summary, steps } = model;
  const zh = lang === 'zh';
  const failedStep = steps.find((step) => step.stepKind === 'tool_exchange' && step.toolStatus === 'failure');
  const hasCorrection = steps.some((step) => step.stepKind === 'user_correction');
  const response = summary.finalResponse ? compactText(summary.finalResponse, 140) : undefined;
  if (failedStep) {
    const action = compactText(toolInputPreview(failedStep.events[0]) || failedStep.title, 96);
    if (zh) {
      return `${action} 返回失败${response ? `后，AI 回答「${response}」` : ''}${hasCorrection ? '；用户随后进行了纠正' : ''}。`;
    }
    return `${action} returned a failure${response ? `, after which the AI responded, “${response}”` : ''}${hasCorrection ? '; the user then corrected it' : ''}.`;
  }
  if (summary.toolCallCount > 0 || response || hasCorrection) {
    if (zh) {
      return `${summary.toolCallCount > 0 ? `AI 执行了 ${summary.toolCallCount} 次工具操作` : 'AI 完成了本次回答'}${response ? `，最后回答「${response}」` : ''}${hasCorrection ? '；用户随后进行了纠正' : ''}。`;
    }
    return `${summary.toolCallCount > 0 ? `The AI performed ${summary.toolCallCount} tool action${summary.toolCallCount === 1 ? '' : 's'}` : 'The AI completed its response'}${response ? ` and ended with, “${response}”` : ''}${hasCorrection ? '; the user then corrected it' : ''}.`;
  }
  return zh ? '当前 trace 中没有足够信息生成事实摘要。' : 'The trace does not contain enough information for a factual summary.';
}

function renderKnowledgeIndex(
  knowledgeEvidence: DebugKnowledgeEvidence[],
  steps: TaskReplayStep[],
  lang: Lang,
): string {
  const zh = lang === 'zh';
  const knowledgeItems = knowledgeEvidence.filter((item) => item.knowledgeKind !== 'runtime_evidence');
  if (knowledgeItems.length === 0) return '';
  const items = knowledgeItems.map((item) => {
    const step = steps.find((candidate) => candidate.knowledgeEvidenceIds.includes(item.id));
    return `<a class="replay-knowledge-link" href="#${e(step?.id ?? '')}"><strong>${e(item.label)}</strong><span>${e(ACCESS_LABELS[item.accessKind][lang])}</span></a>`;
  }).join('');
  return `<section class="replay-knowledge-index" aria-label="${zh ? '本次出现的 Knowledge' : 'Knowledge in this task'}"><div class="replay-knowledge-index-label">${zh ? '本次出现的 Knowledge' : 'Knowledge in this task'}</div><div class="replay-knowledge-index-items">${items}</div></section>`;
}

function renderIntegrityWarning(model: KnowledgeDebuggerViewModel, lang: Lang): string {
  if (model.integrity.status === 'complete') return '';
  const zh = lang === 'zh';
  return `<section class="replay-integrity-warning"><div><strong>${zh ? '这次重放可能不完整' : 'This replay may be incomplete'}</strong><ul>${model.integrity.notices.map((notice) => `<li>${e(INTEGRITY_LABELS[notice.code](notice.count, lang))}</li>`).join('')}</ul></div></section>`;
}

function renderTimeline(
  steps: TaskReplayStep[],
  evidenceById: Map<string, DebugKnowledgeEvidence>,
  lang: Lang,
): string {
  const parts: string[] = [];
  for (let index = 0; index < steps.length;) {
    const step = steps[index];
    if (!step) break;
    if (step.stepKind === 'runtime_context' || step.stepKind === 'skill_context') {
      const contextSteps: TaskReplayStep[] = [];
      while (index < steps.length && (steps[index]?.stepKind === 'runtime_context' || steps[index]?.stepKind === 'skill_context')) {
        contextSteps.push(steps[index] as TaskReplayStep);
        index += 1;
      }
      parts.push(renderContextGroup(contextSteps, evidenceById, lang));
      continue;
    }
    if (step.stepKind === 'tool_exchange') {
      const toolSteps: TaskReplayStep[] = [];
      while (index < steps.length && steps[index]?.stepKind === 'tool_exchange') {
        toolSteps.push(steps[index] as TaskReplayStep);
        index += 1;
      }
      parts.push(renderToolGroup(toolSteps, evidenceById, lang));
      continue;
    }
    parts.push(renderNarrativeStep(step, lang));
    index += 1;
  }
  return parts.join('');
}

function renderContextGroup(
  steps: TaskReplayStep[],
  evidenceById: Map<string, DebugKnowledgeEvidence>,
  lang: Lang,
): string {
  const zh = lang === 'zh';
  const evidence = uniqueEvidence(steps, evidenceById);
  const content = evidence.length > 0
    ? evidence.map((item) => `<div class="replay-context-item"><strong>${e(item.label)}</strong><span>${e(ACCESS_LABELS[item.accessKind][lang])}</span></div>`).join('')
    : `<p class="replay-message">${e(eventPreview(steps[0]?.events[0], zh ? '任务上下文已进入 trace。' : 'Task context entered the trace.'))}</p>`;
  return `<article class="replay-beat is-context" id="${e(steps[0]?.id ?? '')}">
    <time class="replay-beat-time">${e(formatBeatRange(steps))}</time>
    <div class="replay-beat-mark" aria-hidden="true"></div>
    <div class="replay-beat-content">
      <div class="replay-beat-label">${zh ? '任务上下文' : 'Task context'}</div>
      <div class="replay-context-list">${content}</div>
      ${renderRawEvidence(steps.flatMap((step) => step.events), lang)}
    </div>
  </article>`;
}

function renderToolGroup(
  steps: TaskReplayStep[],
  evidenceById: Map<string, DebugKnowledgeEvidence>,
  lang: Lang,
): string {
  const zh = lang === 'zh';
  const hasFailure = steps.some((step) => step.toolStatus === 'failure');
  return `<article class="replay-beat ${hasFailure ? 'is-failure' : ''}">
    <time class="replay-beat-time">${e(formatBeatRange(steps))}</time>
    <div class="replay-beat-mark" aria-hidden="true"></div>
    <div class="replay-beat-content">
      <div class="replay-beat-label">${zh ? 'AI 执行' : 'AI actions'}</div>
      <div class="replay-tools-head"><strong>${zh ? `${steps.length} 次工具操作` : `${steps.length} tool action${steps.length === 1 ? '' : 's'}`}</strong><span>${hasFailure ? (zh ? '包含失败结果' : 'Includes a failure') : (zh ? '均已返回结果' : 'All returned results')}</span></div>
      <div class="replay-tool-list">${steps.map((step) => renderToolRow(step, evidenceById, lang)).join('')}</div>
    </div>
  </article>`;
}

function renderToolRow(
  step: TaskReplayStep,
  evidenceById: Map<string, DebugKnowledgeEvidence>,
  lang: Lang,
): string {
  const zh = lang === 'zh';
  const evidence = evidenceForStep(step, evidenceById);
  const skillEvidence = evidence.filter((item) => item.knowledgeKind === 'skill' && item.accessKind === 'read');
  const call = step.events[0];
  const result = step.events[1];
  const input = toolInputPreview(call);
  const title = skillEvidence.length > 0
    ? (zh ? `读取 Skill：${skillEvidence.map((item) => item.label).join('、')}` : `Read skill: ${skillEvidence.map((item) => item.label).join(', ')}`)
    : compactText(input || step.title, 140);
  const showCommand = Boolean(input && input !== title);
  const failed = step.toolStatus === 'failure';
  const missingResult = step.events.length === 1;
  return `<div class="replay-tool-row" id="${e(step.id)}">
    <div class="replay-tool-main">
      <div><div class="replay-tool-title">${e(title)}</div>${showCommand ? `<div class="replay-tool-command">${e(compactText(input, 260))}</div>` : ''}</div>
      ${renderToolStatus(step, lang)}
    </div>
    ${failed || missingResult ? `<div class="replay-tool-result"><strong>${zh ? '实际结果' : 'Observed result'}</strong>${e(result ? eventPreview(result, zh ? '工具没有返回内容。' : 'The tool returned no content.') : (zh ? '当前 trace 中没有匹配到工具结果。' : 'No matching tool result in this trace.'))}</div>` : ''}
    ${renderRawEvidence(step.events, lang, zh ? '查看调用与原始证据' : 'View call and raw evidence')}
  </div>`;
}

function renderNarrativeStep(
  step: TaskReplayStep,
  lang: Lang,
): string {
  const classes = [
    step.stepKind === 'user_correction' ? 'is-correction' : '',
    step.toolStatus === 'failure' ? 'is-failure' : '',
  ].filter(Boolean).join(' ');
  const quote = ['user_request', 'user_message', 'user_correction', 'assistant_message'].includes(step.stepKind);
  return `<article class="replay-beat ${classes}" id="${e(step.id)}">
    <time class="replay-beat-time">${e(formatBeatTime(step.timestamp))}</time>
    <div class="replay-beat-mark" aria-hidden="true"></div>
    <div class="replay-beat-content">
      <div class="replay-beat-label">${e(STEP_LABELS[step.stepKind][lang])}</div>
      <p class="replay-message ${quote ? 'is-quote' : ''}">${e(eventPreview(step.events[0], lang === 'zh' ? '没有可展示的事件内容。' : 'No event content available.'))}</p>
      ${renderRawEvidence(step.events, lang)}
    </div>
  </article>`;
}

function renderRawEvidence(
  events: TaskReplayStep['events'],
  lang: Lang,
  label?: string,
): string {
  const zh = lang === 'zh';
  return `<details class="replay-raw"><summary>${label ?? (zh ? '查看原始 trace 证据' : 'View raw trace evidence')}</summary>${events.map((event) => `<div class="replay-raw-event"><span>${e(event.kind)} · ${e(event.id)}${event.sourceLineIndex !== undefined ? ` · line ${event.sourceLineIndex}` : ''}</span><pre>${e(event.fullText ?? event.snippet ?? '')}</pre></div>`).join('')}</details>`;
}

function renderToolStatus(step: TaskReplayStep, lang: Lang): string {
  const zh = lang === 'zh';
  if (step.toolStatus === 'failure') return `<span class="replay-status is-failure">${zh ? '失败' : 'Failed'}</span>`;
  if (step.toolStatus === 'cancelled') return `<span class="replay-status is-cancelled">${zh ? '已取消' : 'Cancelled'}</span>`;
  if (step.events.length > 1) return `<span class="replay-status is-returned">${zh ? '已返回' : 'Returned'}</span>`;
  return `<span class="replay-status is-unknown">${zh ? '结果缺失' : 'Result missing'}</span>`;
}

function evidenceForStep(
  step: TaskReplayStep,
  evidenceById: Map<string, DebugKnowledgeEvidence>,
): DebugKnowledgeEvidence[] {
  return step.knowledgeEvidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is DebugKnowledgeEvidence => Boolean(item));
}

function uniqueEvidence(
  steps: TaskReplayStep[],
  evidenceById: Map<string, DebugKnowledgeEvidence>,
): DebugKnowledgeEvidence[] {
  return [...new Map(steps.flatMap((step) => evidenceForStep(step, evidenceById)).map((item) => [item.id, item])).values()];
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

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatBeatTime(value?: string): string {
  if (!value) return '—';
  const time = value.includes('T') ? value.split('T')[1] : value;
  return (time ?? value).replace(/Z$/, '').slice(0, 8);
}

function formatBeatRange(steps: TaskReplayStep[]): string {
  const start = formatBeatTime(steps[0]?.timestamp);
  const end = formatBeatTime(steps.at(-1)?.events.at(-1)?.timestamp ?? steps.at(-1)?.timestamp);
  return start === end ? start : `${start}–${end}`;
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

function formatDuration(start: string | undefined, end: string | undefined, lang: Lang): string {
  if (!start || !end) return lang === 'zh' ? '时长未知' : 'Duration unknown';
  const milliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return lang === 'zh' ? '时长未知' : 'Duration unknown';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return lang === 'zh' ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return lang === 'zh' ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes}m ${remainingSeconds}s`;
}

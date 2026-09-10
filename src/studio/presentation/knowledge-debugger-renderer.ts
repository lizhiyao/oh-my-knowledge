import type {
  ExperienceTimelineEvent,
  KnowledgeDebuggerViewModel,
  TaskReplayIntegrityCode
} from '../../observability/view-models/index.js';
import type { Lang } from '../../shared/language.js';
import { inlineMarkdownText } from '../application/inline-markdown.js';
import { compactText, formatDisplayTimestamp, formatElapsed, formatRelativeTime, formatRelativeTimestamp, shortHash } from '../application/replay/format.js';
import { projectReplay } from '../application/replay/projection.js';
import { ReplayCard, ReplayFacet, ReplayFacetGroup, ReplayField, ReplayLaneKind, ReplayOperation, ReplayProjection } from '../view-models/replay.js';
import { TRACK_START_PADDING, visibleAxisTicks } from '../application/replay/layout.js';
import { primaryTrajectoryEvidenceRef } from '../application/trajectory-evidence.js';
import { type TrajectoryEvidenceRef } from '../view-models/trajectory-evidence.js';
import { icon } from './icons.js';
import { renderSafeInlineMarkdown } from './inline-markdown.js';
import { DEFAULT_LANG, e, layout } from './layout.js';
import { renderTrajectoryLiveClientSource } from './trajectory-live.js';
import { renderTrajectoryRoutingClientSource } from './trajectory-routing.js';

const INTEGRITY_LABELS: Record<TaskReplayIntegrityCode, (count: number, lang: Lang) => string> = {
  task_boundary_unavailable: (_count, lang) => lang === 'zh' ? '无法从日志判定本次任务边界' : 'Task boundary could not be resolved from the trace',
  timeline_truncated: (count, lang) => lang === 'zh' ? `语义轨迹省略 ${count} 个规范化事件` : `${count} normalized event${count === 1 ? '' : 's'} omitted from the semantic trajectory`,
  malformed_records: (count, lang) => lang === 'zh' ? `${count} 条格式损坏记录` : `${count} malformed record${count === 1 ? '' : 's'}`,
  ignored_values: (count, lang) => lang === 'zh' ? `${count} 个非对象值被忽略` : `${count} non-object value${count === 1 ? '' : 's'} ignored`,
  unknown_events: (count, lang) => lang === 'zh' ? `${count} 个事件无法识别` : `${count} unrecognized event${count === 1 ? '' : 's'}`,
  unmatched_tool_calls: (count, lang) => lang === 'zh' ? `${count} 次工具调用缺少结果` : `${count} tool call${count === 1 ? '' : 's'} without results`,
  unmatched_tool_results: (count, lang) => lang === 'zh' ? `${count} 条工具结果无法配对` : `${count} tool result${count === 1 ? '' : 's'} could not be paired`,
  missing_timestamps: (count, lang) => lang === 'zh' ? `${count} 个事件缺少时间戳` : `${count} event${count === 1 ? '' : 's'} without timestamps`,
};

const LANE_LABELS: Record<ReplayLaneKind, Record<Lang, { title: string; detail: string; empty: string }>> = {
  conversation: {
    zh: { title: '对话', detail: '用户与 AI', empty: '未观测到对话消息' },
    en: { title: 'Conversation', detail: 'User and AI', empty: 'No conversation messages observed' },
  },
  knowledge: {
    zh: { title: '知识', detail: '何时、从何处出现', empty: '未识别到知识' },
    en: { title: 'Knowledge', detail: 'When and where it appeared', empty: 'No Knowledge identified' },
  },
  action: {
    zh: { title: '执行', detail: 'AI 发起的工具调用', empty: '未观测到工具调用' },
    en: { title: 'Actions', detail: 'AI-initiated tool calls', empty: 'No tool calls observed' },
  },
  result: {
    zh: { title: '结果', detail: '工具返回及调用状态', empty: '未观测到工具结果' },
    en: { title: 'Results', detail: 'Tool returns and call status', empty: 'No tool results observed' },
  },
};

const SOURCE_RECORD_PARTIAL_LABELS: Record<Lang, { records: string; content: string }> = {
  zh: {
    records: '原始日志归档不完整：已保留 {retained} 条，省略 {omitted} 条。',
    content: '部分原始日志内容已按归档上限截断。',
  },
  en: {
    records: 'The raw-log archive is partial: {retained} retained, {omitted} omitted.',
    content: 'Some raw-log content was truncated by the archive limit.',
  },
};

export function renderKnowledgeDebuggerPage(
  model: KnowledgeDebuggerViewModel,
  lang: Lang = DEFAULT_LANG,
  options: {
    sourceRecordsEndpoint?: string;
    live?: { endpoint: string; revision: string };
  } = {},
): string {
  const zh = lang === 'zh';
  const projection = projectReplay(model, lang, { pendingToolResults: Boolean(options.live) });
  const pageTitle = model.summary.userGoal ?? (zh ? '未识别到用户要求' : 'No user request identified');
  const normalizedEvents = model.normalizedEvents;
  const normalizedEventCount = normalizedEvents.length;
  const sourceRecordCount = model.sourceRecords.recordCount;
  const sourceLabel = displaySourceKind(model.session.sourceKind);
  const observedModels = model.summary.observedModels;
  const observedModelLabel = observedModels.length === 1
    ? observedModels[0]
    : observedModels.length > 1
      ? (zh ? `${observedModels.length} 个模型` : `${observedModels.length} models`)
      : undefined;
  const toolCallCount = model.summary.toolCallCount;
  const toolFailureCount = model.summary.toolFailureCount;
  const trajectoryRoutingClientSource = renderTrajectoryRoutingClientSource();
  const trajectoryLiveClientSource = renderTrajectoryLiveClientSource();

  return layout(zh ? '任务轨迹' : 'Task Trajectory', `
    <style>
      .trajectory-shell{height:100%;min-height:0;display:flex;flex-direction:column;margin:0;padding:14px 22px;letter-spacing:0}
      .trajectory-mode{display:inline-flex;flex:none;padding:2px;border:1px solid var(--border);border-radius:7px;background:var(--bg-elevated)}
      .trajectory-mode button{height:28px;padding:3px 11px;border:0;border-radius:5px;background:transparent;color:var(--text-secondary);font:500 12px/1.4 inherit;letter-spacing:0;white-space:nowrap;cursor:pointer}
      .trajectory-mode button[aria-pressed="true"]{background:var(--text-primary);color:var(--bg-surface);box-shadow:0 1px 2px rgba(24,32,51,.14)}
      .trajectory-mode button:focus-visible,.trajectory-event:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      .trajectory-heading{flex:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center;min-height:32px;margin:0 0 8px}
      .trajectory-heading h1{min-width:0;margin:0;overflow:hidden;font-size:21px;font-weight:650;line-height:1.28;letter-spacing:0;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-meta{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:0;color:var(--text-secondary);font-size:11px;white-space:nowrap}
      .trajectory-meta span{display:inline-flex;align-items:center}
      .trajectory-meta span+span:before{content:"";width:3px;height:3px;margin:0 10px;border-radius:50%;background:var(--border-hover)}
      .trajectory-meta .trajectory-meta-source{color:var(--accent);font-weight:650}
      .trajectory-meta .trajectory-meta-model{color:var(--text-primary);font-weight:600}
      .trajectory-meta .is-failure{color:var(--red);font-weight:600}
      .trajectory-warning{flex:none;margin:0 0 8px;padding:7px 10px;border-left:2px solid var(--yellow);background:rgba(217,119,6,.06);color:var(--text-secondary);font-size:10px;line-height:1.45}
      .trajectory-warning strong{color:var(--text-primary)}
      .trajectory-frame{flex:1;min-height:0;overflow:hidden;display:grid;grid-template-rows:40px minmax(0,1fr);border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);box-shadow:var(--shadow-sm)}
      .trajectory-frame-head{display:flex;align-items:center;min-height:0;padding:0 10px 0 14px;border-bottom:1px solid var(--border)}
      .trajectory-frame-head h2{flex:none;margin:0;font-size:13px;font-weight:600;letter-spacing:0;white-space:nowrap}
      .trajectory-live-controls{display:inline-flex;align-items:center;gap:3px;margin-left:8px}
      .trajectory-live-state{display:inline-flex;align-items:center;gap:5px;color:var(--text-muted);font-size:9px;white-space:nowrap}
      .trajectory-live-state:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(31,157,99,.1)}
      .trajectory-live-state[data-state="syncing"]:before{background:var(--accent);box-shadow:0 0 0 3px rgba(79,70,229,.1)}
      .trajectory-live-state[data-state="reconnecting"]:before{background:var(--yellow);box-shadow:0 0 0 3px rgba(217,119,6,.1)}
      .trajectory-live-follow{display:inline-flex;height:22px;align-items:center;gap:4px;padding:0 6px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--text-muted);font:500 9px/1 inherit;letter-spacing:0;cursor:pointer;white-space:nowrap}
      .trajectory-live-follow svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .trajectory-live-follow:hover{border-color:var(--border);background:var(--bg-elevated);color:var(--text-primary)}
      .trajectory-live-follow:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .trajectory-live-follow[data-state="following"]{color:var(--accent)}
      .trajectory-live-follow[data-state="pending"],.trajectory-live-follow[data-state="completed"]{border-color:rgba(79,70,229,.2);background:rgba(79,70,229,.07);color:var(--accent)}
      .trajectory-live-follow[data-state="aborted"],.trajectory-live-follow[data-state="interrupted"],.trajectory-live-follow[data-state="unknown"]{border-color:var(--border);background:var(--bg-elevated);color:var(--text-muted)}
      .trajectory-frame-space{flex:1}
      .trajectory-range{color:var(--text-secondary);font:400 10px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-variant-numeric:tabular-nums}
      .trajectory-boundary-info{position:relative;margin-left:4px}
      .trajectory-boundary-info summary{display:grid;width:20px;height:20px;place-items:center;border:0;border-radius:3px;background:transparent;color:var(--text-muted);cursor:pointer;list-style:none}
      .trajectory-boundary-info summary::-webkit-details-marker{display:none}
      .trajectory-boundary-info summary svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .trajectory-boundary-info summary:hover,.trajectory-boundary-info[open] summary{color:var(--text-primary)}
      .trajectory-boundary-info summary:focus-visible{color:var(--text-primary);outline:2px solid var(--accent);outline-offset:1px}
      .trajectory-boundary-popover{position:absolute;top:27px;left:0;z-index:20;width:min(430px,78vw);padding:12px 14px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface);color:var(--text-secondary);font-size:10px;line-height:1.55;box-shadow:var(--shadow-md)}
      .trajectory-boundary-popover h3{margin:0 0 5px;color:var(--text-primary);font-size:11px;font-weight:650}
      .trajectory-boundary-flow{margin:0 0 9px;color:var(--accent);font:600 10px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
      .trajectory-boundary-levels{display:grid;gap:7px;margin:0}
      .trajectory-boundary-levels div{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px}
      .trajectory-boundary-levels dt{color:var(--text-primary);font-weight:650}
      .trajectory-boundary-levels dd{margin:0}
      .trajectory-boundary-note{margin:10px 0 0;padding-top:9px;border-top:1px solid var(--border);color:var(--text-muted)}
      .trajectory-focus{position:relative;margin-left:8px}
      .trajectory-focus summary{position:relative;display:grid;width:28px;height:28px;place-items:center;border:0;border-radius:5px;background:transparent;color:var(--text-secondary);cursor:pointer;list-style:none}
      .trajectory-focus summary::-webkit-details-marker{display:none}
      .trajectory-focus summary svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .trajectory-focus summary:hover,.trajectory-focus[open] summary,.trajectory-focus.has-active summary{background:var(--bg-elevated);color:var(--text-primary)}
      .trajectory-focus summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .trajectory-focus.has-active summary:after{content:"";position:absolute;top:4px;right:4px;width:4px;height:4px;border-radius:50%;background:var(--accent)}
      .trajectory-focus-menu{position:absolute;top:34px;right:0;z-index:24;width:200px;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface);box-shadow:var(--shadow-md)}
      .trajectory-focus-title{display:block;padding:3px 7px 6px;color:var(--text-muted);font-size:9px;font-weight:600}
      .trajectory-focus-option{display:grid;width:100%;grid-template-columns:8px minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 7px;border:0;border-radius:5px;background:transparent;color:var(--text-primary);font:500 11px/1.35 inherit;text-align:left;cursor:pointer}
      .trajectory-focus-option:hover,.trajectory-focus-option[aria-pressed="true"]{background:var(--bg-elevated)}
      .trajectory-focus-option:focus-visible{outline:2px solid var(--accent);outline-offset:-1px}
      .trajectory-focus-option small{color:var(--text-muted);font-size:9px;font-weight:500}
      .trajectory-focus-swatch{width:6px;height:6px;border-radius:50%;background:var(--text-muted)}
      .trajectory-focus-option[data-facet-group="knowledge"] .trajectory-focus-swatch{background:var(--accent)}
      .trajectory-focus-option[data-facet-group="tool"] .trajectory-focus-swatch{background:var(--yellow)}
      .trajectory-focus-option[data-facet-group="status"] .trajectory-focus-swatch{background:var(--red)}
      .trajectory-frame-head .trajectory-mode{margin-left:8px}
      .trajectory-body{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 0;align-items:stretch;transition:grid-template-columns .18s cubic-bezier(.2,.8,.2,1)}
      .trajectory-shell[data-inspector-open="true"] .trajectory-body{grid-template-columns:minmax(0,1fr) clamp(320px,27vw,400px)}
      .trajectory-shell[data-inspector-restoring="true"] .trajectory-body{transition:none}
      .trajectory-scroll{min-width:0;min-height:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;outline-offset:-2px;scrollbar-color:var(--border-hover) transparent;scrollbar-width:thin}
      .trajectory-scroll:focus-visible{outline:2px solid var(--accent)}
      .trajectory-canvas{--lane-label-width:108px;--event-width:clamp(166px,15vw,190px);width:max(100%,var(--timeline-detail-width));height:100%;min-width:var(--timeline-detail-width);display:grid;grid-template-rows:32px minmax(0,1fr)}
      .trajectory-axis,.trajectory-lane{display:grid;grid-template-columns:var(--lane-label-width) minmax(0,1fr)}
      .trajectory-axis{min-height:0;border-bottom:1px solid var(--border);background:var(--bg-elevated)}
      .trajectory-axis-label{position:sticky;left:0;z-index:6;display:flex;align-items:center;padding-left:14px;border-right:1px solid var(--border);background:var(--bg-elevated);color:var(--text-muted);font-size:10px}
      .trajectory-ticks{position:relative;min-width:0;color:var(--text-muted);font:400 9px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-variant-numeric:tabular-nums}
      .trajectory-tick{position:absolute;top:0;bottom:0;display:flex;align-items:center;padding-left:7px;border-left:1px solid var(--border);white-space:nowrap}
      .trajectory-gap-axis{position:absolute;top:4px;height:24px;display:flex;align-items:center;justify-content:center;border-right:1px dashed var(--border-hover);border-left:1px dashed var(--border-hover);background:rgba(246,248,252,.94);color:var(--text-secondary);font-size:8px;white-space:nowrap}
      .trajectory-milestone-axis{position:absolute;top:4px;z-index:2;display:flex;height:24px;align-items:center;gap:5px;padding:0 7px;border-left:2px solid var(--accent);background:rgba(246,248,252,.96);color:var(--text-secondary);white-space:nowrap}
      .trajectory-milestone-axis time{font-size:8px}
      .trajectory-milestone-axis strong{color:var(--text-primary);font-size:9px;font-weight:650}
      .trajectory-milestone-axis.is-end{border-right:2px solid var(--green);border-left:0;transform:translateX(-100%)}
      .trajectory-milestone-axis.is-warning{border-left-color:var(--yellow)}
      .trajectory-milestone-axis.is-neutral{border-left-color:var(--border-hover)}
      .trajectory-lanes{position:relative;min-height:0;display:grid;grid-template-rows:repeat(4,minmax(0,1fr))}
      .trajectory-guides{position:absolute;inset:0 0 0 var(--lane-label-width);z-index:0;pointer-events:none}
      .trajectory-guide{position:absolute;top:0;bottom:0;border-left:1px solid rgba(228,232,241,.72)}
      .trajectory-gap-band{position:absolute;top:0;bottom:0;border-right:1px dashed rgba(148,163,184,.42);border-left:1px dashed rgba(148,163,184,.42);background:rgba(246,248,252,.62)}
      .trajectory-milestone-line{position:absolute;top:0;bottom:0;border-left:1px dashed rgba(79,70,229,.48)}
      .trajectory-milestone-line.is-end{border-left-color:rgba(31,157,99,.52)}
      .trajectory-milestone-line.is-warning{border-left-color:rgba(217,119,6,.58)}
      .trajectory-milestone-line.is-neutral{border-left-color:rgba(148,163,184,.48)}
      .trajectory-links{position:absolute;inset:0;z-index:1;width:100%;height:100%;overflow:visible;pointer-events:none}
      .trajectory-link{fill:none;opacity:.38;stroke:rgba(99,112,131,.58);stroke-width:1.15;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
      .trajectory-link.is-flow{opacity:.28;stroke:rgba(100,116,139,.66);stroke-width:1.05}
      .trajectory-link.is-call-result{opacity:.56;stroke:rgba(71,85,105,.72);stroke-width:1.2}
      .trajectory-link.is-knowledge{stroke:rgba(79,70,229,.46);stroke-width:1.1;stroke-dasharray:4 4}
      .trajectory-link.is-active{opacity:1;stroke-width:1.45}
      .trajectory-link-arrow{fill:rgba(99,112,131,.7);opacity:.4;stroke:none}
      .trajectory-link-arrow.is-flow{fill:rgba(100,116,139,.72);opacity:.36}
      .trajectory-link-arrow.is-call-result{fill:rgba(71,85,105,.76);opacity:.58}
      .trajectory-link-arrow.is-active{opacity:1}
      .trajectory-lane{position:relative;z-index:2;min-height:0;overflow:visible;border-bottom:1px solid var(--border);pointer-events:none}
      .trajectory-lane:last-child{border-bottom:0}
      .trajectory-lane-name{position:sticky;left:0;z-index:6;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:9px 12px;border-right:1px solid var(--border);background:rgba(255,255,255,.96)}
      .trajectory-lane-name strong{font-size:13px;font-weight:650}
      .trajectory-lane-name span{color:var(--text-muted);font-size:10px;line-height:1.35}
      .trajectory-track{position:relative;min-width:0;min-height:0;height:100%}
      .trajectory-empty{position:absolute;left:14px;top:50%;color:var(--text-faint);font-size:10px;transform:translateY(-50%)}
      .trajectory-event{position:absolute;left:var(--event-x);top:50%;z-index:3;display:flex;flex-direction:column;gap:2px;width:var(--event-card-width,var(--event-width));height:56px;overflow:hidden;padding:6px 7px;border:1px solid var(--border-hover);border-left:3px solid var(--event-color,var(--text-secondary));border-radius:6px;background:var(--event-bg,var(--bg-surface));color:var(--text-primary);text-align:left;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px rgba(31,41,55,.04);transform:translateY(-50%);transition:opacity .16s,border-color .16s,box-shadow .16s,transform .16s}
      .trajectory-event.is-compact{top:50%;width:14px;height:14px;padding:0;border:1.5px solid var(--event-color);border-radius:50%;background:var(--bg-surface);box-shadow:0 0 0 3px var(--bg-surface);transform:translate(-50%,-50%)}
      .trajectory-event.is-compact .trajectory-event-head,
      .trajectory-event.is-compact .trajectory-event-body{display:none}
      .trajectory-event.is-compact:hover{border-color:var(--text-primary);background:var(--bg-elevated);transform:translate(-50%,-50%) scale(1.08)}
      .trajectory-event.is-compact.is-related{border-color:var(--accent);background:rgba(79,70,229,.08)}
      .trajectory-event:hover{z-index:5;transform:translateY(-50%) translateY(-1px)}
      .trajectory-event.is-dimmed{opacity:.76}
      .trajectory-event.is-related{z-index:4;border-color:var(--event-color,var(--accent));box-shadow:0 0 0 1px var(--event-ring,rgba(79,70,229,.2)),0 4px 12px rgba(31,41,55,.06)}
      .trajectory-event.is-primary{box-shadow:0 0 0 2px var(--event-ring,rgba(79,70,229,.28)),0 6px 14px rgba(31,41,55,.08)}
      .trajectory-event-head{display:flex;min-width:0;align-items:center;gap:5px}
      .trajectory-event-time{flex:0 0 auto;color:var(--event-color,var(--text-secondary));font:500 9px/1.2 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
      .trajectory-event-body{display:block;min-width:0;width:100%}
      .trajectory-event-kind{display:block;min-width:0;overflow:hidden;color:var(--text-muted);font:500 8px/1.25 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-event-model{min-width:0;overflow:hidden;color:var(--text-muted);font:500 8px/1.25 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-event-title{display:-webkit-box;overflow:hidden;font-size:11px;font-weight:650;line-height:1.3;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal}
      .trajectory-event-title strong{font-weight:750}
      .trajectory-event-title em{font-style:italic}
      .trajectory-event-title code{padding:1px 3px;border-radius:3px;background:rgba(99,112,131,.1);font:500 .88em/1.2 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
      .trajectory-event.has-detail .trajectory-event-title{display:block;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-event-detail{display:block;overflow:hidden;margin-top:2px;color:var(--text-secondary);font-size:9px;line-height:1.3;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-event-raw{display:none}
      .trajectory-lane.has-two-rows .trajectory-event[data-event-row="0"]{top:25%}
      .trajectory-lane.has-two-rows .trajectory-event[data-event-row="1"]{top:75%}
      .trajectory-lane.has-two-rows .trajectory-event.is-compact{top:50%}
      .trajectory-event.is-message{--event-color:var(--text-secondary);--event-ring:rgba(99,112,131,.28);--event-bg:var(--bg-surface)}
      .trajectory-event.is-reasoning{--event-color:#64748b;--event-ring:rgba(100,116,139,.3);--event-bg:rgba(100,116,139,.055)}
      .trajectory-event.is-knowledge{--event-color:var(--accent);--event-ring:rgba(79,70,229,.28);--event-bg:rgba(79,70,229,.055)}
      .trajectory-event.is-action{--event-color:var(--yellow);--event-ring:rgba(217,119,6,.3);--event-bg:rgba(217,119,6,.055)}
      .trajectory-event.is-result{--event-color:var(--green);--event-ring:rgba(31,157,99,.3);--event-bg:rgba(31,157,99,.055)}
      .trajectory-event.is-pending{--event-color:var(--accent);--event-ring:rgba(79,70,229,.28);--event-bg:rgba(79,70,229,.045)}
      .trajectory-event.is-failure{--event-color:var(--red);--event-ring:rgba(220,38,38,.3);--event-bg:rgba(220,38,38,.055)}
      .trajectory-event.is-warning{--event-color:var(--yellow);--event-ring:rgba(217,119,6,.3);--event-bg:rgba(217,119,6,.055)}
      .trajectory-event.is-facet-muted{opacity:.14!important;filter:saturate(.35)}
      .trajectory-event.is-facet-match{opacity:1!important}
      .trajectory-event.is-live-entering{animation:trajectory-live-card-in .42s cubic-bezier(.2,.8,.2,1) both}
      @keyframes trajectory-live-card-in{0%{opacity:.18;box-shadow:0 0 0 0 var(--event-ring,rgba(79,70,229,.2))}58%{opacity:1;box-shadow:0 0 0 4px var(--event-ring,rgba(79,70,229,.2))}100%{opacity:1}}
      .trajectory-inspector{min-width:0;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);border-left:1px solid var(--border);background:var(--bg-surface)}
      .trajectory-inspector[hidden]{display:none}
      .trajectory-operation-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;align-items:start;min-height:0;padding:12px 14px;border-bottom:1px solid var(--border)}
      .trajectory-operation-type{grid-column:1/-1;color:var(--accent);font:500 10px/1.4 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:normal}
      .trajectory-operation-copy{min-width:0}
      .trajectory-operation-copy h3{margin:0 0 2px;font-size:14px;font-weight:650;line-height:1.35;letter-spacing:0;overflow-wrap:anywhere;white-space:normal}
      .trajectory-operation-copy p{display:-webkit-box;margin:0;overflow:hidden;color:var(--text-secondary);font-size:11px;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:2}
      .trajectory-operation-actions{display:flex;align-items:center;gap:6px;padding-top:0}
      .trajectory-evidence-count{color:var(--text-secondary);font-size:10px;white-space:nowrap}
      .trajectory-evidence-jump,.trajectory-field-evidence{border:0;border-radius:4px;background:transparent;color:var(--accent);font-size:9px;font-weight:600;white-space:nowrap;cursor:pointer}
      .trajectory-evidence-jump{padding:4px 6px}
      .trajectory-field-evidence{padding:3px 5px}
      .trajectory-evidence-jump:hover,.trajectory-field-evidence:hover{background:var(--bg-elevated);color:var(--text-primary)}
      .trajectory-evidence-jump:focus-visible,.trajectory-field-evidence:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .trajectory-inspector-close{display:grid;width:24px;height:24px;place-items:center;border:0;border-radius:4px;background:transparent;color:var(--text-muted);cursor:pointer}
      .trajectory-inspector-close:hover{background:var(--bg-elevated);color:var(--text-primary)}
      .trajectory-inspector-close:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .trajectory-inspector-close svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
      .trajectory-operation-panel[hidden]{display:none}
      .trajectory-semantic-panels{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-color:var(--border-hover) transparent;scrollbar-width:thin}
      .trajectory-fields{display:block;min-height:0}
      .trajectory-field{min-width:0;padding:9px 14px;border-bottom:1px solid var(--border)}
      .trajectory-field:last-child{border-bottom:0}
      .trajectory-field-label{display:block;margin-bottom:3px;color:var(--text-muted);font-size:9px;font-weight:600}
      .trajectory-field-value{display:block;margin-bottom:3px;font-size:12px;font-weight:600;overflow-wrap:anywhere}
      .trajectory-field-content{display:block;max-height:min(280px,36vh);overflow:auto;color:var(--text-primary);font-size:12px;font-weight:500;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-color:var(--border-hover) transparent;scrollbar-width:thin}
      .trajectory-field-content strong{font-weight:700}
      .trajectory-field-content em{font-style:italic}
      .trajectory-field-content code{padding:1px 3px;border-radius:3px;background:rgba(99,112,131,.1);font:500 .9em/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
      .trajectory-field-content a{color:var(--accent);text-decoration:none}
      .trajectory-field-content a:hover{text-decoration:underline}
      .trajectory-field.is-content .trajectory-field-detail{max-height:none;margin-top:5px;overflow:visible}
      .trajectory-field-detail{display:block;max-height:132px;overflow:auto;color:var(--text-secondary);font:400 10px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .trajectory-field-detail-block{min-width:0}
      .trajectory-field-detail-block[data-expandable="true"]:not([data-expanded="true"]) .trajectory-field-detail{overflow:hidden}
      .trajectory-field-detail-block[data-expanded="true"] .trajectory-field-detail{max-height:min(320px,42vh);overflow:auto;color:var(--text-primary)}
      .trajectory-field-detail-actions{display:flex;min-height:24px;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
      .trajectory-field-detail-status{color:var(--text-muted);font-size:9px;white-space:nowrap}
      .trajectory-field-detail-controls{display:flex;align-items:center;gap:3px}
      .trajectory-field-detail-toggle,.trajectory-field-detail-copy{border:0;background:transparent;color:var(--accent);cursor:pointer}
      .trajectory-field-detail-toggle{padding:3px 5px;border-radius:3px;font-size:9px;font-weight:600}
      .trajectory-field-detail-copy{display:grid;width:24px;height:24px;place-items:center;border-radius:4px;color:var(--text-secondary)}
      .trajectory-field-detail-toggle:hover,.trajectory-field-detail-copy:hover{background:var(--bg-elevated);color:var(--text-primary)}
      .trajectory-field-detail-toggle:focus-visible,.trajectory-field-detail-copy:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .trajectory-field-detail-copy.is-copied{color:var(--green)}
      .trajectory-raw-list{display:none;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--bg-surface);scrollbar-color:var(--border-hover) transparent;scrollbar-width:thin}
      .trajectory-raw-head,.trajectory-raw-row summary{display:grid;grid-template-columns:76px 126px minmax(240px,1fr) 138px;gap:12px;align-items:center}
      .trajectory-raw-head{position:sticky;top:0;z-index:3;min-height:32px;padding:0 14px;border-bottom:1px solid var(--border);background:var(--bg-elevated);color:var(--text-muted);font-size:9px;font-weight:600}
      .trajectory-raw-row{border-bottom:1px solid var(--border)}
      .trajectory-raw-row.is-evidence-target{background:rgba(79,70,229,.07);box-shadow:inset 3px 0 0 var(--accent)}
      .trajectory-raw-row[hidden]{display:none}
      .trajectory-raw-row summary{min-height:46px;padding:7px 14px;color:var(--text-primary);cursor:pointer;list-style:none}
      .trajectory-raw-row summary::-webkit-details-marker{display:none}
      .trajectory-raw-row summary:hover{background:var(--bg-elevated)}
      .trajectory-raw-row time,.trajectory-raw-kind,.trajectory-raw-id{overflow:hidden;color:var(--text-secondary);font:400 9px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-raw-row strong{overflow:hidden;font-size:11px;font-weight:550;text-overflow:ellipsis;white-space:nowrap}
      .trajectory-raw-row pre{max-height:180px;margin:0;padding:10px 14px 12px 226px;overflow:auto;border-top:1px solid var(--border);background:rgba(246,248,252,.62);color:var(--text-secondary);font:400 10px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .trajectory-raw-empty{padding:28px 14px;color:var(--text-muted);font-size:11px;text-align:center}
      .trajectory-record-notice{padding:8px 14px;border-bottom:1px solid var(--border);background:rgba(217,119,6,.045);color:var(--text-secondary);font-size:10px;line-height:1.45}
      .trajectory-shell:not([data-mode="semantic"]) .trajectory-scroll{display:none}
      .trajectory-shell[data-mode="normalized"] [data-event-view="normalized"],.trajectory-shell[data-mode="source"] [data-event-view="source"]{display:block}
      .trajectory-shell:not([data-mode="semantic"]) .trajectory-body{grid-template-columns:minmax(0,1fr)}
      .trajectory-shell:not([data-mode="semantic"]) .trajectory-inspector{display:none!important}
      @media(prefers-reduced-motion:reduce){.trajectory-event{transition:none}.trajectory-event.is-live-entering{animation:none}}
      @media(max-width:1100px){.trajectory-shell[data-inspector-open="true"] .trajectory-body{grid-template-columns:minmax(0,1fr) 320px}.trajectory-canvas{--lane-label-width:96px;--event-width:148px}.trajectory-lane-name{padding-inline:10px}.trajectory-lane-name span{font-size:9px}}
      @media(max-width:1080px){.trajectory-meta-time{display:none!important}}
      @media(max-width:860px){.trajectory-shell{padding-inline:14px}.trajectory-heading{grid-template-columns:1fr;gap:0}.trajectory-meta{display:none}.trajectory-shell[data-inspector-open="true"] .trajectory-body{grid-template-columns:1fr;grid-template-rows:minmax(0,3fr) minmax(160px,2fr)}.trajectory-inspector{border-top:1px solid var(--border);border-left:0}.trajectory-operation-head{padding-block:9px}}
      @media(max-width:600px){.trajectory-heading h1{font-size:17px}.trajectory-frame-head{gap:2px;padding-inline:8px}.trajectory-frame-space{min-width:0}.trajectory-range{display:none}.trajectory-live-controls{margin-left:3px}.trajectory-live-state{gap:0;font-size:0}.trajectory-live-follow{width:22px;padding:0;justify-content:center}.trajectory-live-follow span{display:none}.trajectory-boundary-info{margin-left:1px}.trajectory-focus{margin-left:2px}.trajectory-frame-head .trajectory-mode{margin-left:2px}.trajectory-mode button{min-width:37px;padding-inline:6px;font-size:0}.trajectory-mode button:after{content:attr(data-short-label);font-size:10px}.trajectory-canvas{--lane-label-width:76px;--event-width:126px}.trajectory-lane-name{padding-inline:8px}.trajectory-lane-name span{display:none}.trajectory-event-time{display:none}.trajectory-raw-head,.trajectory-raw-row summary{grid-template-columns:66px 94px minmax(160px,1fr)}.trajectory-raw-id{display:none}.trajectory-raw-row pre{padding-left:14px}}
      @media(prefers-reduced-motion:reduce){.trajectory-body{transition:none}}
    </style>
    <main class="trajectory-shell" data-mode="semantic"${options.live ? ` data-live-endpoint="${e(options.live.endpoint)}" data-live-revision="${e(options.live.revision)}"` : ''}>
      <header class="trajectory-heading">
        <h1 title="${e(pageTitle)}">${e(pageTitle)}</h1>
        <div class="trajectory-meta">
          <span class="trajectory-meta-source">${e(sourceLabel)}</span>
          ${observedModelLabel ? `<span class="trajectory-meta-model" title="${e(observedModels.join(' · '))}">${e(observedModelLabel)}</span>` : ''}
          <span class="trajectory-meta-time">${e(formatDisplayTimestamp(projection.startTimestamp, lang))}</span>
          <span>${e(formatElapsed(projection.durationMs, lang))}</span>
          <span>${toolCallCount} ${zh ? '次调用' : toolCallCount === 1 ? 'call' : 'calls'}</span>
          ${toolFailureCount > 0 ? `<span class="is-failure">${toolFailureCount} ${zh ? '次失败' : toolFailureCount === 1 ? 'failure' : 'failures'}</span>` : ''}
          <span>${normalizedEventCount} ${zh ? '个规范化事件' : normalizedEventCount === 1 ? 'normalized event' : 'normalized events'}</span>
          ${sourceRecordCount > 0 ? `<span>${sourceRecordCount} ${zh ? '条原始日志' : sourceRecordCount === 1 ? 'raw log entry' : 'raw log entries'}</span>` : ''}
        </div>
      </header>

      ${renderIntegrityWarning(model, lang)}

      <section class="trajectory-frame" aria-labelledby="trajectory-title">
        <header class="trajectory-frame-head">
          <h2 id="trajectory-title">${zh ? '任务轨迹' : 'Task trajectory'}</h2>
          ${options.live ? `<div class="trajectory-live-controls"><span class="trajectory-live-state" data-live-state data-state="connecting">${zh ? '连接中' : 'Connecting'}</span><button class="trajectory-live-follow" type="button" data-live-follow data-state="following" data-following="true" aria-pressed="true" title="${zh ? '暂停自动跟随' : 'Pause automatic follow'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h13"></path><path d="m13 8 4 4-4 4"></path><path d="M20 5v14"></path></svg><span data-live-follow-label>${zh ? '跟随中' : 'Following'}</span></button></div>` : ''}
          <details class="trajectory-boundary-info">
            <summary aria-label="${zh ? '了解三类信息' : 'About the three views'}" title="${zh ? '三类信息说明' : 'About the three views'}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg></summary>
            <div class="trajectory-boundary-popover">${renderTrajectoryViewExplanation(model, lang)}</div>
          </details>
          <span class="trajectory-frame-space"></span>
          <span class="trajectory-range">${e(formatRelativeTime(0))} — ${e(formatRelativeTime(projection.durationMs))}</span>
          ${projection.facets.length > 0 ? renderFacetFocus(projection.facets, lang) : ''}
          <div class="trajectory-mode" aria-label="${zh ? '查看模式' : 'View mode'}">
            <button type="button" data-trajectory-mode="semantic" data-short-label="${zh ? '轨迹' : 'Track'}" aria-pressed="true">${zh ? '语义轨迹' : 'Semantic trajectory'}</button>
            <button type="button" data-trajectory-mode="normalized" data-short-label="${zh ? '事件' : 'Events'}" aria-pressed="false">${zh ? '规范化事件' : 'Normalized events'}</button>
            <button type="button" data-trajectory-mode="source" data-short-label="${zh ? '日志' : 'Logs'}" aria-pressed="false">${zh ? '原始日志' : 'Raw logs'}</button>
          </div>
        </header>

        <div class="trajectory-body">
          <div class="trajectory-scroll" tabindex="0" aria-label="${zh ? '完整任务时间轴' : 'Full task timeline'}">
            <div class="trajectory-canvas" style="--timeline-detail-width:${projection.detailWidth}px">
              <div class="trajectory-axis" aria-hidden="true"><div class="trajectory-axis-label">${zh ? '时间' : 'Time'}</div><div class="trajectory-ticks">${renderAxis(projection, lang)}</div></div>
              <div class="trajectory-lanes">
                <div class="trajectory-guides" aria-hidden="true">${renderGuides(projection)}</div>
                <svg class="trajectory-links" aria-hidden="true"></svg>
                ${(['conversation', 'action', 'result', 'knowledge'] as ReplayLaneKind[]).map((lane) => renderLane(lane, projection, undefined, lang)).join('')}
              </div>
            </div>
          </div>

          ${renderNormalizedEventList(normalizedEvents, projection.operations, projection.startTimestamp, lang)}
          ${renderSourceRecordList(model, projection.startTimestamp, lang, options.sourceRecordsEndpoint)}

          <aside class="trajectory-inspector" aria-live="polite" hidden>
            <header class="trajectory-operation-head">
              <div class="trajectory-operation-type" id="trajectory-operation-type"></div>
              <div class="trajectory-operation-copy"><h3 id="trajectory-operation-title"></h3><p id="trajectory-operation-summary"></p></div>
              <div class="trajectory-operation-actions"><div class="trajectory-evidence-count" id="trajectory-evidence-count"></div><button class="trajectory-evidence-jump" type="button" data-operation-evidence hidden></button><button class="trajectory-inspector-close" type="button" data-inspector-close aria-label="${zh ? '关闭详情' : 'Close details'}" title="${zh ? '关闭详情' : 'Close details'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg></button></div>
            </header>
            <div class="trajectory-semantic-panels">${projection.operations.map((operation) => renderSemanticPanel(operation, false, lang)).join('')}</div>
          </aside>
        </div>
      </section>
    </main>
    <script>
      (() => {
        ${trajectoryRoutingClientSource}
        ${trajectoryLiveClientSource}
        const initializeTrajectoryPage = () => {
        window.__omkTrajectoryDispose?.();
        const pageLifecycle = new AbortController();
        const shell = document.querySelector('.trajectory-shell');
        if (!shell) return;
        const cards = Array.from(document.querySelectorAll('[data-trajectory-operation]'));
        const normalizedRows = Array.from(document.querySelectorAll('[data-trajectory-normalized-event]'));
        const normalizedEmpty = document.querySelector('[data-trajectory-normalized-empty]');
        const sourceRecordList = document.querySelector('[data-event-view="source"]');
        const semanticPanels = Array.from(document.querySelectorAll('[data-trajectory-semantic-panel]'));
        const semanticPanelContainer = document.querySelector('.trajectory-semantic-panels');
        const detailBlocks = Array.from(document.querySelectorAll('[data-field-detail-block]'));
        const operationType = document.querySelector('#trajectory-operation-type');
        const operationTitle = document.querySelector('#trajectory-operation-title');
        const operationSummary = document.querySelector('#trajectory-operation-summary');
        const evidenceCount = document.querySelector('#trajectory-evidence-count');
        const operationEvidence = document.querySelector('[data-operation-evidence]');
        const lanes = document.querySelector('.trajectory-lanes');
        const operationLinks = document.querySelector('.trajectory-links');
        const facetFocus = document.querySelector('.trajectory-focus');
        const facetButtons = Array.from(document.querySelectorAll('[data-trajectory-facet]'));
        const boundaryInfo = document.querySelector('.trajectory-boundary-info');
        const boundarySummary = boundaryInfo?.querySelector('summary');
        const inspector = document.querySelector('.trajectory-inspector');
        const inspectorClose = document.querySelector('[data-inspector-close]');
        const trajectoryBody = document.querySelector('.trajectory-body');
        const timeline = document.querySelector('.trajectory-scroll');
        const liveFollowButton = document.querySelector('[data-live-follow]');
        let currentOperationId = '';
        let pendingLayoutFrame;
        let layoutTransitionTimer;
        let layoutScrollReleaseTimer;
        let sourceRecordsPromise;
        const copyFeedbackTimers = new Set();
        let pauseLiveFollow = () => {};
        const sourceRecordLabels = ${JSON.stringify({
          empty: zh ? '空记录' : 'Empty record',
          redacted: zh ? '【不透明加密载荷已省略】' : '[Opaque encrypted payload omitted]',
          truncated: zh ? '【该记录已按归档上限截断】' : '[Record truncated by archive limit]',
          loadFailed: zh ? '原始日志读取失败。可以切换视图后重试。' : 'Raw logs could not be loaded. Switch views and retry.',
          partialRecords: SOURCE_RECORD_PARTIAL_LABELS[lang].records,
          partialContent: SOURCE_RECORD_PARTIAL_LABELS[lang].content,
          viewSource: zh ? '查看原始日志' : 'View raw log',
          viewNormalized: zh ? '查看规范化事件' : 'View normalized event',
        })};
        const cardLane = (card) => card.closest('.trajectory-lane')?.dataset.lane || '';
        const operationIds = semanticPanels.map((panel) => panel.dataset.trajectorySemanticPanel).filter(Boolean);
        const cardsByOperation = new Map(operationIds.map((id) => [id, []]));
        cards.forEach((card) => {
          const operationId = card.dataset.trajectoryOperation || '';
          const relatedCards = cardsByOperation.get(operationId);
          if (relatedCards) relatedCards.push(card);
        });
        const fullDetailText = (block) => {
          if (typeof block.__omkFullDetail === 'string') return block.__omkFullDetail;
          const sourceEventId = block.dataset.detailSourceEventId || '';
          const sourceRow = normalizedRows.find((row) => row.dataset.trajectoryNormalizedEvent === sourceEventId);
          const fullText = sourceRow?.querySelector('pre')?.textContent || block.querySelector('[data-field-detail]')?.textContent || '';
          block.__omkFullDetail = fullText;
          return fullText;
        };
        detailBlocks.forEach((block) => {
          const detail = block.querySelector('[data-field-detail]');
          const toggle = block.querySelector('[data-field-detail-toggle]');
          const copy = block.querySelector('[data-field-detail-copy]');
          const status = block.querySelector('[data-field-detail-status]');
          const previewText = detail?.textContent || '';
          toggle?.addEventListener('click', () => {
            const expanded = block.dataset.expanded === 'true';
            if (detail) detail.textContent = expanded ? previewText : fullDetailText(block);
            block.dataset.expanded = String(!expanded);
            toggle.textContent = expanded ? block.dataset.expandLabel : block.dataset.collapseLabel;
            toggle.setAttribute('aria-expanded', String(!expanded));
            if (status) status.textContent = expanded ? block.dataset.previewStatus : block.dataset.fullStatus;
          }, { signal: pageLifecycle.signal });
          copy?.addEventListener('click', async () => {
            const text = fullDetailText(block);
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              const textarea = document.createElement('textarea');
              textarea.value = text;
              textarea.style.position = 'fixed';
              textarea.style.opacity = '0';
              document.body.append(textarea);
              textarea.select();
              document.execCommand('copy');
              textarea.remove();
            }
            copy.classList.add('is-copied');
            copy.setAttribute('aria-label', block.dataset.copiedLabel);
            copy.setAttribute('title', block.dataset.copiedLabel);
            const copyFeedbackTimer = window.setTimeout(() => {
              copyFeedbackTimers.delete(copyFeedbackTimer);
              copy.classList.remove('is-copied');
              copy.setAttribute('aria-label', block.dataset.copyLabel);
              copy.setAttribute('title', block.dataset.copyLabel);
            }, 1200);
            copyFeedbackTimers.add(copyFeedbackTimer);
          }, { signal: pageLifecycle.signal });
        });
        const operationEntries = operationIds.map((id, order) => {
          const relatedCards = cardsByOperation.get(id) || [];
          const actionCard = relatedCards.find((card) => cardLane(card) === 'action');
          const resultCard = relatedCards.find((card) => cardLane(card) === 'result');
          const knowledgeCards = relatedCards.filter((card) => cardLane(card) === 'knowledge');
          const conversationCard = relatedCards.find((card) => cardLane(card) === 'conversation');
          const startCard = actionCard || conversationCard || resultCard;
          const endCard = resultCard || conversationCard || actionCard;
          return { id, order, startCard, endCard, actionCard, resultCard, knowledgeCards };
        });
        const primaryOperations = operationEntries.filter((operation) => operation.startCard && operation.endCard);
        const substantiveOperations = primaryOperations.filter((operation) => !operation.startCard.classList.contains('is-compact'));
        const compactCards = cards.filter((card) => card.classList.contains('is-compact'));
        const linksByOperation = new Map();
        let activeLinkElements = [];
        const registerLink = (link, relatedOperationIds) => {
          const operationTokens = [...new Set(relatedOperationIds.filter(Boolean))];
          link.setAttribute('data-link-operations', operationTokens.join(' '));
          operationTokens.forEach((operationId) => {
            const relatedLinks = linksByOperation.get(operationId) || [];
            relatedLinks.push(link);
            linksByOperation.set(operationId, relatedLinks);
          });
        };
        const setLinkActivity = (activeId = '') => {
          activeLinkElements.forEach((link) => link.classList.remove('is-active'));
          activeLinkElements = activeId ? (linksByOperation.get(activeId) || []) : [];
          activeLinkElements.forEach((link) => link.classList.add('is-active'));
        };

        const updateOperationLinks = () => {
          if (!lanes || !operationLinks || shell.dataset.mode !== 'semantic') return;
          activeLinkElements = [];
          linksByOperation.clear();
          operationLinks.replaceChildren();
          const layoutStartedAt = performance.now();
          const layoutMetrics = {
            flowRoutes: 0,
            obstacleQueries: 0,
            obstacleCandidates: 0,
            collisionChecks: 0,
            curveCandidates: 0,
            corridorCandidates: 0,
          };
          const lanesRect = lanes.getBoundingClientRect();
          compactCards.forEach((card) => {
            card.style.removeProperty('left');
            card.style.removeProperty('top');
          });
          const edgePoint = (rect, targetX, targetY) => {
            const centerX = (rect.left + rect.right) / 2;
            const centerY = (rect.top + rect.bottom) / 2;
            const dx = targetX - centerX;
            const dy = targetY - centerY;
            const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (rect.width / 2) / Math.abs(dx);
            const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (rect.height / 2) / Math.abs(dy);
            const scale = Math.min(scaleX, scaleY);
            return {
              x: centerX + dx * scale - lanesRect.left,
              y: centerY + dy * scale - lanesRect.top,
            };
          };
          const connectionPoints = (fromRect, toRect) => {
            const fromCenterX = (fromRect.left + fromRect.right) / 2;
            const fromCenterY = (fromRect.top + fromRect.bottom) / 2;
            const toCenterX = (toRect.left + toRect.right) / 2;
            const toCenterY = (toRect.top + toRect.bottom) / 2;
            const moveToward = (point, target, distance) => {
              const dx = target.x - point.x;
              const dy = target.y - point.y;
              const length = Math.hypot(dx, dy) || 1;
              return { x: point.x + dx / length * distance, y: point.y + dy / length * distance };
            };
            const from = edgePoint(fromRect, toCenterX, toCenterY);
            const to = edgePoint(toRect, fromCenterX, fromCenterY);
            return {
              from: moveToward(from, { x: toCenterX - lanesRect.left, y: toCenterY - lanesRect.top }, 2),
              to: moveToward(to, { x: fromCenterX - lanesRect.left, y: fromCenterY - lanesRect.top }, 2),
            };
          };
          const appendArrow = (fromX, fromY, toX, toY, linkKind, relatedOperationIds) => {
            const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const classes = 'trajectory-link-arrow is-' + linkKind;
            const dx = toX - fromX;
            const dy = toY - fromY;
            const length = Math.hypot(dx, dy) || 1;
            const unitX = dx / length;
            const unitY = dy / length;
            const perpendicularX = -unitY;
            const perpendicularY = unitX;
            const baseX = toX - unitX * 5;
            const baseY = toY - unitY * 5;
            const d = 'M ' + (baseX + perpendicularX * 2.7) + ' ' + (baseY + perpendicularY * 2.7)
              + ' L ' + toX + ' ' + toY
              + ' L ' + (baseX - perpendicularX * 2.7) + ' ' + (baseY - perpendicularY * 2.7)
              + ' Z';
            arrow.setAttribute('class', classes);
            arrow.setAttribute('d', d);
            registerLink(arrow, relatedOperationIds);
            operationLinks.appendChild(arrow);
          };
          const connectStraight = (from, to, linkKind, relatedOperationIds, withArrow = true) => {
            if (!from || !to) return;
            const fromRect = from.getBoundingClientRect();
            const toRect = to.getBoundingClientRect();
            const points = connectionPoints(fromRect, toRect);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('class', 'trajectory-link is-' + linkKind);
            path.setAttribute('data-link-kind', linkKind);
            registerLink(path, relatedOperationIds);
            path.setAttribute('d', 'M ' + points.from.x + ' ' + points.from.y + ' L ' + points.to.x + ' ' + points.to.y);
            operationLinks.appendChild(path);
            if (withArrow) appendArrow(points.from.x, points.from.y, points.to.x, points.to.y, linkKind, relatedOperationIds);
          };
          const toRoutingRect = (rect, owner) => ({
            owner,
            left: rect.left - lanesRect.left,
            right: rect.right - lanesRect.left,
            top: rect.top - lanesRect.top,
            bottom: rect.bottom - lanesRect.top,
          });
          const createFlowPath = (from, to, relatedOperationIds) => {
            if (!from || !to || from === to) return undefined;
            const route = planFlowRoute({
              fromRect: toRoutingRect(from.getBoundingClientRect(), from),
              toRect: toRoutingRect(to.getBoundingClientRect(), to),
              fromLane: cardLane(from),
              toLane: cardLane(to),
              obstacleIndex,
              fromOwner: from,
              toOwner: to,
            });
            if (!route) return undefined;
            Object.keys(route.metrics).forEach((key) => {
              layoutMetrics[key] += route.metrics[key];
            });
            layoutMetrics.flowRoutes += 1;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('class', 'trajectory-link is-flow');
            path.setAttribute('data-link-kind', 'flow');
            path.setAttribute('data-flow-from', from.dataset.trajectoryOperation || '');
            path.setAttribute('data-flow-to', to.dataset.trajectoryOperation || '');
            registerLink(path, relatedOperationIds);
            path.setAttribute('d', route.d);
            operationLinks.appendChild(path);
            appendArrow(route.arrowFrom.x, route.arrowFrom.y, route.to.x, route.to.y, 'flow', relatedOperationIds);
            return path;
          };
          const blockingRects = cards.filter((card) => !card.classList.contains('is-compact')).map((card) => {
            const rect = card.getBoundingClientRect();
            return {
              owner: card,
              left: rect.left - lanesRect.left - 9,
              right: rect.right - lanesRect.left + 9,
              top: rect.top - lanesRect.top - 9,
              bottom: rect.bottom - lanesRect.top + 9,
            };
          });
          const reservedCallResultChannels = operationEntries.flatMap((operation) => {
            if (!operation.actionCard || !operation.resultCard) return [];
            const actionRect = operation.actionCard.getBoundingClientRect();
            const resultRect = operation.resultCard.getBoundingClientRect();
            const channel = connectionPoints(actionRect, resultRect);
            const top = Math.min(channel.from.y, channel.to.y);
            const bottom = Math.max(channel.from.y, channel.to.y);
            const endpointInset = 18;
            if (bottom - top <= endpointInset * 2) return [];
            return [{
              left: Math.min(channel.from.x, channel.to.x) - 12,
              right: Math.max(channel.from.x, channel.to.x) + 12,
              top: top + endpointInset,
              bottom: bottom - endpointInset,
            }];
          });
          const obstacleIndex = createHorizontalObstacleIndex([
            ...blockingRects,
            ...reservedCallResultChannels,
          ]);
          const markerObstacles = [...blockingRects, ...reservedCallResultChannels];
          const laneBoundaries = [...document.querySelectorAll('.trajectory-lane')]
            .map((lane) => lane.getBoundingClientRect().bottom - lanesRect.top)
            .filter((boundary) => boundary > 8 && boundary < lanesRect.height - 8);
          const placedMarkerCenters = [];
          const pointRectDistance = (x, y, rect) => {
            const dx = Math.max(rect.left - x, 0, x - rect.right);
            const dy = Math.max(rect.top - y, 0, y - rect.bottom);
            return Math.hypot(dx, dy);
          };
          const markerClearance = (x, y) => markerObstacles.length === 0
            ? Number.POSITIVE_INFINITY
            : Math.min(...markerObstacles.map((rect) => pointRectDistance(x, y, rect)));
          const laneBoundaryClearance = (y) => laneBoundaries.length === 0
            ? Number.POSITIVE_INFINITY
            : Math.min(...laneBoundaries.map((boundary) => Math.abs(boundary - y)));
          const markerCollides = (x, y) => markerClearance(x, y) < 16
            || laneBoundaryClearance(y) < 16
            || placedMarkerCenters.some((point) => Math.hypot(point.x - x, point.y - y) < 32);
          operationEntries.forEach((operation) => {
            if (operation.actionCard && operation.resultCard) {
              connectStraight(operation.actionCard, operation.resultCard, 'call-result', [operation.id]);
            }
            const knowledgeSource = operation.resultCard || operation.actionCard;
            if (knowledgeSource) {
              operation.knowledgeCards.forEach((card) => connectStraight(knowledgeSource, card, 'knowledge', [operation.id], false));
            }
          });
          const markerPlacementTasks = [];
          substantiveOperations.forEach((operation, index) => {
            const previous = substantiveOperations[index - 1];
            if (!previous) return;
            const markerOperations = primaryOperations
              .filter((candidate) => candidate.startCard.classList.contains('is-compact')
                && candidate.order > previous.order
                && candidate.order < operation.order);
            const relatedOperationIds = [previous.id, ...markerOperations.map((candidate) => candidate.id), operation.id];
            const path = createFlowPath(previous.endCard, operation.startCard, relatedOperationIds);
            if (path && markerOperations.length > 0) markerPlacementTasks.push({ path, markerOperations });
          });
          operationEntries.filter((operation) => !operation.startCard && operation.knowledgeCards.length > 0).forEach((operation) => {
            const previous = [...primaryOperations].reverse().find((candidate) => candidate.order < operation.order);
            const next = primaryOperations.find((candidate) => candidate.order > operation.order);
            const source = previous?.endCard || next?.startCard;
            const relatedOperationIds = [operation.id, previous?.id, next?.id];
            if (source) {
              operation.knowledgeCards.forEach((card) => connectStraight(source, card, 'knowledge', relatedOperationIds, false));
            }
          });
          const markerPlacements = [];
          markerPlacementTasks.forEach(({ path, markerOperations }) => {
            const pathLength = path.getTotalLength();
            const idealProgresses = planFlowMarkerProgresses(pathLength, markerOperations.length);
            const endpointClearance = Math.min(18, pathLength / 2);
            markerOperations.forEach((markerOperation, markerIndex) => {
              const marker = markerOperation.startCard;
              const idealProgress = idealProgresses[markerIndex] ?? .5;
              const trackRect = marker.closest('.trajectory-track')?.getBoundingClientRect();
              if (!trackRect) return;
              const progressCandidates = [idealProgress, ...Array.from({ length: 161 }, (_value, candidateIndex) => (
                .04 + .92 * candidateIndex / 160
              ))];
              const safeCandidates = progressCandidates
                .map((progress) => ({
                  progress,
                  point: path.getPointAtLength(pathLength * progress),
                  sourceDistance: progress * pathLength,
                  destinationDistance: (1 - progress) * pathLength,
                }))
                .filter((candidate) => candidate.point.y >= 10
                  && candidate.point.y <= lanesRect.height - 10
                  && candidate.sourceDistance >= endpointClearance
                  && candidate.destinationDistance >= endpointClearance
                  && !markerCollides(candidate.point.x, candidate.point.y))
                .map((candidate) => ({
                  ...candidate,
                  clearance: markerClearance(candidate.point.x, candidate.point.y),
                  boundaryClearance: laneBoundaryClearance(candidate.point.y),
                }))
                .map((candidate) => ({
                  ...candidate,
                  score: Math.abs(candidate.progress - idealProgress) * Math.min(pathLength, 420) * 4
                    + Math.max(0, 36 - candidate.clearance) * 8
                    + Math.max(0, 30 - candidate.boundaryClearance) * 10,
                }));
              let target = safeCandidates.sort((left, right) => left.score - right.score)[0]?.point;
              target ||= path.getPointAtLength(pathLength * idealProgress);
              placedMarkerCenters.push(target);
              markerPlacements.push({ marker, target, trackRect });
            });
          });
          markerPlacements.forEach(({ marker, target, trackRect }) => {
            marker.style.left = (lanesRect.left + target.x - trackRect.left) + 'px';
            marker.style.top = (lanesRect.top + target.y - trackRect.top) + 'px';
          });
          window.__omkTrajectoryMetrics = {
            ...layoutMetrics,
            durationMs: performance.now() - layoutStartedAt,
            cardCount: cards.length,
            obstacleCount: markerObstacles.length,
            linkElementCount: operationLinks.childElementCount,
          };
          setLinkActivity(currentOperationId);
        };

        const scheduleOperationLinks = () => {
          if (pendingLayoutFrame !== undefined) cancelAnimationFrame(pendingLayoutFrame);
          pendingLayoutFrame = requestAnimationFrame(() => {
            pendingLayoutFrame = undefined;
            updateOperationLinks();
          });
        };

        const revealSelectedOperation = () => {
          if (!timeline || !currentOperationId) return;
          const relatedCards = cardsByOperation.get(currentOperationId) || [];
          const card = relatedCards.find((item) => item.dataset.primary === 'true') || relatedCards[0];
          if (!card) return;
          const viewportRect = timeline.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();
          const canvas = timeline.querySelector('.trajectory-canvas');
          const laneLabelWidth = Number.parseFloat(canvas ? getComputedStyle(canvas).getPropertyValue('--lane-label-width') : '') || 0;
          const visibleLeft = viewportRect.left + laneLabelWidth + 12;
          const visibleRight = viewportRect.right - 12;
          const delta = cardRect.left < visibleLeft
            ? cardRect.left - visibleLeft
            : cardRect.right > visibleRight
              ? cardRect.right - visibleRight
              : 0;
          if (Math.abs(delta) > 1) timeline.scrollLeft = Math.max(0, timeline.scrollLeft + delta);
        };
        const alignFollowingViewport = () => {
          if (!timeline || liveFollowButton?.dataset.following !== 'true') return false;
          timeline.scrollLeft = Math.max(0, timeline.scrollWidth - timeline.clientWidth);
          return true;
        };
        const finishLayoutTransition = () => {
          if (layoutTransitionTimer !== undefined) window.clearTimeout(layoutTransitionTimer);
          layoutTransitionTimer = undefined;
          if (!alignFollowingViewport()) revealSelectedOperation();
          scheduleOperationLinks();
          if (layoutScrollReleaseTimer !== undefined) window.clearTimeout(layoutScrollReleaseTimer);
          layoutScrollReleaseTimer = window.setTimeout(() => {
            delete shell.dataset.layoutTransition;
            layoutScrollReleaseTimer = undefined;
          }, 120);
        };
        const beginLayoutTransition = () => {
          if (layoutTransitionTimer !== undefined) window.clearTimeout(layoutTransitionTimer);
          if (layoutScrollReleaseTimer !== undefined) window.clearTimeout(layoutScrollReleaseTimer);
          layoutScrollReleaseTimer = undefined;
          shell.dataset.layoutTransition = 'true';
          layoutTransitionTimer = window.setTimeout(finishLayoutTransition, 240);
        };

        const selectOperation = (id, animateLayout = true) => {
          const panel = semanticPanels.find((item) => item.dataset.trajectorySemanticPanel === id);
          if (!panel) return;
          cards.forEach((card) => {
            const related = card.dataset.trajectoryOperation === id;
            card.classList.toggle('is-related', related);
            card.classList.toggle('is-dimmed', !related);
            card.classList.toggle('is-primary', related && card.dataset.primary === 'true');
            card.setAttribute('aria-pressed', String(related));
          });
          semanticPanels.forEach((item) => { item.hidden = item.dataset.trajectorySemanticPanel !== id; });
          if (operationType) operationType.textContent = panel.dataset.typeLabel || '—';
          if (operationTitle) operationTitle.textContent = panel.dataset.title || '—';
          if (operationSummary) operationSummary.textContent = panel.dataset.summary || '';
          if (evidenceCount) evidenceCount.textContent = panel.dataset.evidenceLabel || '';
          if (operationEvidence) {
            const sourceEventId = panel.dataset.evidenceSourceEventId || '';
            operationEvidence.hidden = !sourceEventId;
            operationEvidence.dataset.evidenceSourceEventId = sourceEventId;
            operationEvidence.dataset.evidenceSourceLineIndex = panel.dataset.evidenceSourceLineIndex || '';
            operationEvidence.dataset.evidenceTraceId = panel.dataset.evidenceTraceId || '';
            operationEvidence.textContent = panel.dataset.evidenceSourceLineIndex
              ? sourceRecordLabels.viewSource
              : sourceRecordLabels.viewNormalized;
          }
          currentOperationId = id;
          if (animateLayout && shell.dataset.inspectorOpen !== 'true') beginLayoutTransition();
          shell.dataset.inspectorOpen = 'true';
          if (inspector) inspector.hidden = false;
          setLinkActivity(id);
          scheduleOperationLinks();
        };

        const closeInspector = (shouldScheduleLayout = true) => {
          const inspectorWasOpen = shell.dataset.inspectorOpen === 'true';
          cards.forEach((card) => {
            card.classList.remove('is-related', 'is-dimmed', 'is-primary');
            card.setAttribute('aria-pressed', 'false');
          });
          semanticPanels.forEach((item) => { item.hidden = true; });
          currentOperationId = '';
          if (operationEvidence) operationEvidence.hidden = true;
          if (inspectorWasOpen) beginLayoutTransition();
          delete shell.dataset.inspectorOpen;
          if (inspector) inspector.hidden = true;
          setLinkActivity();
          if (shouldScheduleLayout) scheduleOperationLinks();
        };

        cards.forEach((card) => {
          const operationId = card.dataset.trajectoryOperation || '';
          if (card.classList.contains('is-live-entering')) {
            card.addEventListener('animationend', () => card.classList.remove('is-live-entering'), {
              once: true,
              signal: pageLifecycle.signal,
            });
          }
          const previewOperation = () => {
            if (!currentOperationId) setLinkActivity(operationId);
          };
          const clearOperationPreview = () => {
            if (!currentOperationId) setLinkActivity();
          };
          card.addEventListener('mouseenter', previewOperation, { signal: pageLifecycle.signal });
          card.addEventListener('mouseleave', clearOperationPreview, { signal: pageLifecycle.signal });
          card.addEventListener('focus', previewOperation, { signal: pageLifecycle.signal });
          card.addEventListener('blur', clearOperationPreview, { signal: pageLifecycle.signal });
          card.addEventListener('click', () => {
            if (operationId === currentOperationId) closeInspector();
            else selectOperation(operationId);
          }, { signal: pageLifecycle.signal });
        });
        inspectorClose?.addEventListener('click', () => closeInspector(), { signal: pageLifecycle.signal });
        const applyFacet = (facetId) => {
          facetFocus?.classList.toggle('has-active', Boolean(facetId));
          cards.forEach((card) => {
            const matches = !facetId || (card.dataset.trajectoryFacets || '').split(' ').includes(facetId);
            card.classList.toggle('is-facet-muted', Boolean(facetId) && !matches);
            card.classList.toggle('is-facet-match', Boolean(facetId) && matches);
          });
          let visibleNormalizedRows = 0;
          normalizedRows.forEach((row) => {
            const matches = !facetId || (row.dataset.trajectoryFacets || '').split(' ').includes(facetId);
            row.hidden = !matches;
            if (matches) visibleNormalizedRows += 1;
          });
          if (normalizedEmpty) normalizedEmpty.hidden = visibleNormalizedRows > 0;
        };
        facetButtons.forEach((button) => button.addEventListener('click', () => {
          const facetId = button.dataset.trajectoryFacet || '';
          facetButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
          applyFacet(facetId);
          if (facetFocus) facetFocus.open = false;
        }, { signal: pageLifecycle.signal }));
        const relativeSourceTime = (timestamp) => {
          const valueMs = Date.parse(timestamp || '');
          const startMs = Date.parse(sourceRecordList?.dataset.sourceRecordsStart || '');
          if (!Number.isFinite(valueMs) || !Number.isFinite(startMs)) return '—';
          const totalTenths = Math.max(0, Math.round((valueMs - startMs) / 100));
          const minutes = Math.floor(totalTenths / 600);
          const seconds = Math.floor((totalTenths % 600) / 10);
          return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + (totalTenths % 10);
        };
        const appendSourceRecord = (record) => {
          if (!sourceRecordList) return;
          const details = document.createElement('details');
          details.className = 'trajectory-raw-row';
          details.dataset.sourceLineIndex = String(record.sourceIndex ?? '');
          details.dataset.sourceTraceId = String(record.traceId || '');
          const summary = document.createElement('summary');
          const time = document.createElement('time');
          time.textContent = relativeSourceTime(record.timestamp);
          const kind = document.createElement('span');
          kind.className = 'trajectory-raw-kind';
          kind.textContent = String(record.sourceType || 'unknown');
          const preview = document.createElement('strong');
          preview.textContent = String(record.raw || sourceRecordLabels.empty).replace(/\\s+/g, ' ').trim().slice(0, 180);
          const locator = document.createElement('code');
          locator.className = 'trajectory-raw-id';
          locator.textContent = '#' + String(record.sourceIndex ?? '—') + ' · ' + String(record.traceId || '—').slice(0, 12);
          summary.append(time, kind, preview, locator);
          const body = document.createElement('pre');
          const notices = [record.redacted ? sourceRecordLabels.redacted : '', record.truncated ? sourceRecordLabels.truncated : ''].filter(Boolean);
          body.textContent = String(record.raw || '') + (notices.length > 0 ? '\\n\\n' + notices.join('\\n') : '');
          details.append(summary, body);
          sourceRecordList.append(details);
        };
        const loadSourceRecords = () => {
          if (!sourceRecordList || sourceRecordList.dataset.sourceRecordsLoaded === 'true') return Promise.resolve();
          if (sourceRecordsPromise) return sourceRecordsPromise;
          const state = sourceRecordList.querySelector('[data-source-records-state]');
          sourceRecordsPromise = fetch(sourceRecordList.dataset.sourceRecordsEndpoint, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: pageLifecycle.signal,
          }).then((response) => {
            if (!response.ok) throw new Error('source records request failed');
            return response.json();
          }).then((archive) => {
            state?.remove();
            if (archive.status === 'partial') {
              const notice = document.createElement('div');
              notice.className = 'trajectory-record-notice';
              const omittedRecordCount = Number(archive.omittedRecordCount ?? 0);
              notice.textContent = omittedRecordCount > 0
                ? sourceRecordLabels.partialRecords
                  .replace('{retained}', String(archive.recordCount ?? archive.records?.length ?? 0))
                  .replace('{omitted}', String(omittedRecordCount))
                : sourceRecordLabels.partialContent;
              sourceRecordList.append(notice);
            }
            (Array.isArray(archive.records) ? archive.records : []).forEach(appendSourceRecord);
            sourceRecordList.dataset.sourceRecordsLoaded = 'true';
          }).catch(() => {
            sourceRecordsPromise = undefined;
            if (state) state.textContent = sourceRecordLabels.loadFailed;
          });
          return sourceRecordsPromise;
        };
        const setTrajectoryMode = (mode) => {
          shell.dataset.mode = mode;
          if (mode !== 'semantic') pauseLiveFollow();
          if (boundaryInfo) boundaryInfo.open = false;
          if (mode !== 'semantic') closeInspector(false);
          else scheduleOperationLinks();
          if (mode === 'source') void loadSourceRecords();
          document.querySelectorAll('[data-trajectory-mode]').forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.trajectoryMode === mode)));
        };
        const clearEvidenceTarget = () => {
          document.querySelectorAll('.trajectory-raw-row.is-evidence-target').forEach((row) => row.classList.remove('is-evidence-target'));
        };
        const revealEvidenceRow = (row) => {
          if (!row) return false;
          clearEvidenceTarget();
          row.open = true;
          row.classList.add('is-evidence-target');
          requestAnimationFrame(() => row.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'center',
          }));
          return true;
        };
        const matchingSourceRow = (lineIndex, traceId) => Array.from(sourceRecordList?.querySelectorAll('[data-source-line-index]') || [])
          .find((row) => row.dataset.sourceLineIndex === lineIndex
            && (!traceId || row.dataset.sourceTraceId === traceId));
        const revealEvidence = async (target) => {
          const sourceEventId = target.dataset.evidenceSourceEventId || target.dataset.detailSourceEventId || '';
          const sourceLineIndex = target.dataset.evidenceSourceLineIndex || target.dataset.detailSourceLineIndex || '';
          const traceId = target.dataset.evidenceTraceId || target.dataset.detailTraceId || '';
          if (sourceLineIndex && sourceRecordList) {
            setTrajectoryMode('source');
            await loadSourceRecords();
            if (revealEvidenceRow(matchingSourceRow(sourceLineIndex, traceId))) return;
          }
          if (!sourceEventId) return;
          setTrajectoryMode('normalized');
          revealEvidenceRow(normalizedRows.find((row) => row.dataset.trajectoryNormalizedEvent === sourceEventId));
        };
        operationEvidence?.addEventListener('click', () => void revealEvidence(operationEvidence), { signal: pageLifecycle.signal });
        document.querySelectorAll('[data-view-evidence]').forEach((button) => {
          button.addEventListener('click', () => void revealEvidence(button.closest('[data-field-detail-block]') || button), { signal: pageLifecycle.signal });
        });
        document.querySelectorAll('[data-trajectory-mode]').forEach((button) => {
          button.addEventListener('click', () => {
            const mode = button.dataset.trajectoryMode || 'semantic';
            setTrajectoryMode(mode);
          }, { signal: pageLifecycle.signal });
        });

        timeline?.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const operationIds = semanticPanels.map((panel) => panel.dataset.trajectorySemanticPanel).filter(Boolean);
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const currentIndex = operationIds.indexOf(currentOperationId);
          const nextIndex = currentIndex < 0
            ? (direction > 0 ? 0 : operationIds.length - 1)
            : Math.min(operationIds.length - 1, Math.max(0, currentIndex + direction));
          const nextId = operationIds[nextIndex];
          if (nextId) selectOperation(nextId);
        }, { signal: pageLifecycle.signal });
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          if (boundaryInfo?.open) {
            boundaryInfo.open = false;
            boundarySummary?.focus();
            event.preventDefault();
            return;
          }
          if (currentOperationId) closeInspector();
        }, { signal: pageLifecycle.signal });
        document.addEventListener('pointerdown', (event) => {
          if (boundaryInfo?.open && !boundaryInfo.contains(event.target)) boundaryInfo.open = false;
        }, { signal: pageLifecycle.signal });
        trajectoryBody?.addEventListener('transitionend', (event) => {
          if (event.propertyName === 'grid-template-columns') finishLayoutTransition();
        }, { signal: pageLifecycle.signal });
        window.addEventListener('resize', scheduleOperationLinks, { passive: true, signal: pageLifecycle.signal });
        const layoutResizeObserver = typeof ResizeObserver === 'function' && timeline
          ? new ResizeObserver(scheduleOperationLinks)
          : undefined;
        layoutResizeObserver?.observe(timeline);
        const refreshTrajectorySnapshot = async () => {
          const eventPosition = (card) => Number.parseFloat(card.style.getPropertyValue('--event-x')) || 0;
          const currentCards = Array.from(shell.querySelectorAll('[data-trajectory-operation]'));
          const previousEnd = currentCards.length > 0 ? Math.max(...currentCards.map(eventPosition)) : -1;
          const response = await fetch(window.location.href, {
            headers: { Accept: 'text/html' },
            cache: 'no-store',
            signal: pageLifecycle.signal,
          });
          if (!response.ok) throw new Error('trajectory snapshot request failed');
          const incomingDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
          const incomingShell = incomingDocument.querySelector('.trajectory-shell');
          if (!incomingShell) throw new Error('trajectory snapshot missing');
          const replacement = document.importNode(incomingShell, true);
          const selectedOperationId = currentOperationId;
          const inspectorScrollTop = semanticPanelContainer?.scrollTop ?? 0;
          const expandedDetailSourceEventIds = detailBlocks
            .filter((block) => block.dataset.expanded === 'true')
            .map((block) => block.dataset.detailSourceEventId || '')
            .filter(Boolean);
          replacement.querySelectorAll('[data-trajectory-operation]').forEach((card) => {
            if (eventPosition(card) > previousEnd + 1) card.classList.add('is-live-entering');
          });
          if (selectedOperationId) {
            replacement.dataset.selectedOperationId = selectedOperationId;
            replacement.dataset.inspectorScrollTop = String(inspectorScrollTop);
            replacement.dataset.expandedDetailSourceEventIds = JSON.stringify(expandedDetailSourceEventIds);
            replacement.dataset.inspectorRestoring = 'true';
          }
          window.__omkTrajectoryDispose?.();
          shell.replaceWith(replacement);
          if (incomingDocument.title) document.title = incomingDocument.title;
          initializeTrajectoryPage();
        };
        const liveEndpoint = shell.dataset.liveEndpoint || '';
        const liveState = document.querySelector('[data-live-state]');
        const liveController = createTrajectoryLiveController({
          shell,
          timeline,
          liveState,
          followButton: liveFollowButton,
          followLabel: document.querySelector('[data-live-follow-label]'),
          liveEndpoint,
          labels: ${JSON.stringify({
            connecting: zh ? '连接中' : 'Connecting',
            live: zh ? '实时' : 'Live',
            syncing: zh ? '同步中' : 'Syncing',
            reconnecting: zh ? '重连中' : 'Reconnecting',
            failed: zh ? '实时更新失败' : 'Live update failed',
            taskFailed: zh ? '任务已失败' : 'Task failed',
            following: zh ? '跟随中' : 'Following',
            resume: zh ? '跟随最新' : 'Follow latest',
            pending: zh ? '查看更新' : 'View update',
            completed: zh ? '任务已结束' : 'Task completed',
            aborted: zh ? '任务已中止' : 'Task aborted',
            interrupted: zh ? '任务已中断' : 'Task interrupted',
            unknown: zh ? '状态未知' : 'Status unknown',
            pauseTitle: zh ? '暂停自动跟随' : 'Pause automatic follow',
          })},
          getMode: () => shell.dataset.mode || 'semantic',
          setMode: setTrajectoryMode,
          isScrollTrackingSuppressed: () => shell.dataset.layoutTransition === 'true'
            || shell.dataset.inspectorRestoring === 'true',
          refreshSnapshot: refreshTrajectorySnapshot,
          browserWindow: window,
          browserDocument: document,
        });
        pauseLiveFollow = liveController.pauseFollowing;
        const restoredOperationId = shell.dataset.selectedOperationId || '';
        const restoredInspectorScrollTop = Number(shell.dataset.inspectorScrollTop) || 0;
        let restoredExpandedDetailSourceEventIds = [];
        try {
          restoredExpandedDetailSourceEventIds = JSON.parse(shell.dataset.expandedDetailSourceEventIds || '[]');
        } catch {
          restoredExpandedDetailSourceEventIds = [];
        }
        delete shell.dataset.selectedOperationId;
        delete shell.dataset.inspectorScrollTop;
        delete shell.dataset.expandedDetailSourceEventIds;
        window.__omkTrajectoryDispose = () => {
          pageLifecycle.abort();
          layoutResizeObserver?.disconnect();
          liveController.dispose();
          if (pendingLayoutFrame !== undefined) cancelAnimationFrame(pendingLayoutFrame);
          pendingLayoutFrame = undefined;
          if (layoutTransitionTimer !== undefined) window.clearTimeout(layoutTransitionTimer);
          layoutTransitionTimer = undefined;
          if (layoutScrollReleaseTimer !== undefined) window.clearTimeout(layoutScrollReleaseTimer);
          layoutScrollReleaseTimer = undefined;
          copyFeedbackTimers.forEach((timer) => window.clearTimeout(timer));
          copyFeedbackTimers.clear();
        };
        if (restoredOperationId && operationIds.includes(restoredOperationId)) {
          selectOperation(restoredOperationId, false);
          detailBlocks.forEach((block) => {
            if (!restoredExpandedDetailSourceEventIds.includes(block.dataset.detailSourceEventId || '')) return;
            block.querySelector('[data-field-detail-toggle]')?.click();
          });
          requestAnimationFrame(() => {
            if (semanticPanelContainer) semanticPanelContainer.scrollTop = restoredInspectorScrollTop;
            delete shell.dataset.inspectorRestoring;
          });
        } else {
          delete shell.dataset.inspectorRestoring;
          scheduleOperationLinks();
        }
        };
        window.__omkInitializeTrajectory = initializeTrajectoryPage;
        initializeTrajectoryPage();
      })();
    </script>
  `, lang, { navigation: 'observe', workspace: true });
}

function renderLane(
  lane: ReplayLaneKind,
  projection: ReplayProjection,
  selectedOperationId: string | undefined,
  lang: Lang,
): string {
  const labels = LANE_LABELS[lane][lang];
  const cards = projection.cards.filter((card) => card.lane === lane);
  const laneRows = projection.laneRows[lane];
  return `<section class="trajectory-lane${laneRows === 2 ? ' has-two-rows' : ''}" data-lane="${lane}" style="--lane-rows:${laneRows};">
    <div class="trajectory-lane-name"><strong>${e(labels.title)}</strong><span>${e(labels.detail)}</span></div>
    <div class="trajectory-track">${cards.length > 0 ? cards.map((card) => renderCard(card, projection.startTimestamp, selectedOperationId)).join('') : `<span class="trajectory-empty">${e(labels.empty)}</span>`}</div>
  </section>`;
}

function renderCard(card: ReplayCard, startTimestamp: string | undefined, selectedOperationId: string | undefined): string {
  const hasSelection = Boolean(selectedOperationId);
  const related = hasSelection && card.operationId === selectedOperationId;
  const classes = [
    'trajectory-event',
    `is-${card.tone}`,
    card.compact ? 'is-compact' : '',
    card.detail ? 'has-detail' : '',
    hasSelection ? (related ? 'is-related' : 'is-dimmed') : '',
    related && card.primary ? 'is-primary' : '',
  ].filter(Boolean).join(' ');
  const titleText = compactText(inlineMarkdownText(card.title), 72);
  const accessibleLabel = [
    formatRelativeTimestamp(card.timestamp, startTimestamp),
    card.kindLabel,
    card.model,
    titleText,
  ].filter(Boolean).join(' · ');
  return `<button class="${classes}" type="button" data-event-row="${card.row}"${card.conversationRole ? ` data-conversation-role="${card.conversationRole}"` : ''} style="--event-x:${Math.round(card.position)}px;--event-row:${card.row};--event-card-width:${card.width}px" data-trajectory-operation="${e(card.operationId)}" data-trajectory-facets="${e(card.facetIds.join(' '))}" data-primary="${card.primary}" aria-pressed="${related}"${card.compact ? ` aria-label="${e(accessibleLabel)}"` : ''} title="${e(accessibleLabel)}">
    <span class="trajectory-event-head"><span class="trajectory-event-time">${e(formatRelativeTimestamp(card.timestamp, startTimestamp))}</span><span class="trajectory-event-kind">${e(card.kindLabel)}</span>${card.model ? `<span class="trajectory-event-model" title="${e(card.model)}">${e(card.model)}</span>` : ''}</span>
    <span class="trajectory-event-body"><span class="trajectory-event-title">${renderSafeInlineMarkdown(card.title, { links: 'text', maxLength: 72 })}</span>${card.detail ? `<span class="trajectory-event-detail">${e(card.detail)}</span>` : ''}<span class="trajectory-event-raw">${e(card.rawId)}</span></span>
  </button>`;
}

function renderFacetFocus(facets: ReplayFacet[], lang: Lang): string {
  const zh = lang === 'zh';
  const groupLabel: Record<ReplayFacetGroup, string> = {
    knowledge: zh ? '知识' : 'Knowledge',
    tool: zh ? '工具' : 'Tool',
    status: zh ? '状态' : 'Status',
  };
  const options = facets.map((facet) => `<button class="trajectory-focus-option" type="button" data-trajectory-facet="${e(facet.id)}" data-facet-group="${facet.group}" aria-pressed="false"><span class="trajectory-focus-swatch" aria-hidden="true"></span><span>${e(facet.label)}</span><small>${e(groupLabel[facet.group])}</small></button>`).join('');
  return `<details class="trajectory-focus"><summary aria-label="${zh ? '类型筛选' : 'Filter by type'}" title="${zh ? '类型筛选' : 'Filter by type'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M7 12h10"></path><path d="M10 18h4"></path></svg></summary><div class="trajectory-focus-menu" role="group" aria-label="${zh ? '类型筛选' : 'Type filter'}"><span class="trajectory-focus-title">${zh ? '类型筛选' : 'Type filter'}</span><button class="trajectory-focus-option" type="button" data-trajectory-facet="" aria-pressed="true"><span class="trajectory-focus-swatch" aria-hidden="true"></span><span>${zh ? '全部类型' : 'All types'}</span><small>${zh ? '清除' : 'Clear'}</small></button>${options}</div></details>`;
}

function renderSemanticPanel(operation: ReplayOperation, selected: boolean, lang: Lang): string {
  const evidence = primaryTrajectoryEvidenceRef(operation.events);
  return `<div class="trajectory-operation-panel trajectory-fields" data-trajectory-semantic-panel="${e(operation.id)}" data-selection-label="${e(operation.selectionLabel)}" data-type-label="${e(operation.typeLabel)}" data-title="${e(operation.title)}" data-summary="${e(operation.summary)}" data-evidence-label="${e(operation.evidenceLabel)}"${renderEvidenceDataAttributes(evidence)}${selected ? '' : ' hidden'}>${operation.fields.map((field) => {
    const content = field.presentation === 'content'
      ? `<div class="trajectory-field-content">${renderSafeInlineMarkdown(field.value)}</div>`
      : `<strong class="trajectory-field-value">${e(field.value)}</strong>`;
    return `<div class="trajectory-field${field.presentation === 'content' ? ' is-content' : ''}"><span class="trajectory-field-label">${e(field.label)}</span>${content}${renderFieldDetail(field, lang)}</div>`;
  }).join('')}</div>`;
}

function renderFieldDetail(field: ReplayField, lang: Lang): string {
  const preview = fieldDetailPreview(field.detail);
  if ((!preview.truncated || !field.evidence?.normalizedEventId) && !field.copyable && !field.evidence) {
    return `<code class="trajectory-field-detail">${e(field.detail)}</code>`;
  }
  const zh = lang === 'zh';
  const result = field.detailKind === 'result';
  const previewStatus = preview.truncatedByLines
    ? (zh ? `已显示 ${preview.visibleLineCount} / ${preview.totalLineCount} 行` : `Showing ${preview.visibleLineCount} of ${preview.totalLineCount} lines`)
    : (zh ? `已显示部分内容 · 共 ${preview.totalLineCount} 行` : `Showing a preview · ${preview.totalLineCount} lines total`);
  const fullStatus = zh ? `完整内容 · ${preview.totalLineCount} 行` : `Full content · ${preview.totalLineCount} lines`;
  const expandLabel = zh ? (result ? '展开完整结果' : '展开完整内容') : (result ? 'Show full result' : 'Show full content');
  const collapseLabel = zh ? (result ? '收起结果' : '收起内容') : (result ? 'Collapse result' : 'Collapse content');
  const copyLabel = zh ? (result ? '复制结果' : '复制内容') : (result ? 'Copy result' : 'Copy content');
  const copiedLabel = zh ? '已复制' : 'Copied';
  const canExpand = preview.truncated && Boolean(field.evidence?.normalizedEventId);
  const displayedDetail = canExpand ? preview.text : field.detail;
  const evidenceAttributes = renderEvidenceDataAttributes(field.evidence, 'detail');
  const status = canExpand
    ? `<span class="trajectory-field-detail-status" data-field-detail-status>${e(previewStatus)}</span>`
    : '<span></span>';
  const toggle = canExpand
    ? `<button class="trajectory-field-detail-toggle" type="button" data-field-detail-toggle aria-expanded="false">${e(expandLabel)}</button>`
    : '';
  const evidenceButton = field.evidence
    ? `<button class="trajectory-field-evidence" type="button" data-view-evidence>${lang === 'zh' ? (field.evidence.sourceLineIndex !== undefined ? '查看原始日志' : '查看规范化事件') : (field.evidence.sourceLineIndex !== undefined ? 'View raw log' : 'View normalized event')}</button>`
    : '';
  return `<div class="trajectory-field-detail-block" data-field-detail-block data-expanded="false" data-expandable="${String(canExpand)}"${evidenceAttributes} data-preview-status="${e(previewStatus)}" data-full-status="${e(fullStatus)}" data-expand-label="${e(expandLabel)}" data-collapse-label="${e(collapseLabel)}" data-copy-label="${e(copyLabel)}" data-copied-label="${e(copiedLabel)}"><code class="trajectory-field-detail" data-field-detail>${e(displayedDetail)}</code><div class="trajectory-field-detail-actions">${status}<span class="trajectory-field-detail-controls">${evidenceButton}${toggle}<button class="trajectory-field-detail-copy" type="button" data-field-detail-copy aria-label="${e(copyLabel)}" title="${e(copyLabel)}">${icon('copy', { size: 13 })}</button></span></div></div>`;
}

function renderEvidenceDataAttributes(
  evidence: TrajectoryEvidenceRef | undefined,
  prefix: 'evidence' | 'detail' = 'evidence',
): string {
  if (!evidence) return '';
  const attributes = [` data-${prefix}-source-event-id="${e(evidence.normalizedEventId)}"`];
  if (evidence.sourceLineIndex !== undefined) {
    attributes.push(` data-${prefix}-source-line-index="${evidence.sourceLineIndex}"`);
  }
  if (evidence.traceId) attributes.push(` data-${prefix}-trace-id="${e(evidence.traceId)}"`);
  return attributes.join('');
}

function fieldDetailPreview(detail: string): {
  text: string;
  totalLineCount: number;
  visibleLineCount: number;
  truncated: boolean;
  truncatedByLines: boolean;
} {
  const lines = detail.replace(/\r\n/g, '\n').split('\n');
  const visibleLines = lines.slice(0, 8);
  const truncatedByLines = lines.length > visibleLines.length;
  let text = visibleLines.join('\n');
  const truncatedByLength = text.length > 720;
  if (truncatedByLength) text = `${text.slice(0, 719).trimEnd()}…`;
  return {
    text,
    totalLineCount: lines.length,
    visibleLineCount: visibleLines.length,
    truncated: truncatedByLines || truncatedByLength,
    truncatedByLines,
  };
}

function renderNormalizedEventList(
  events: ExperienceTimelineEvent[],
  operations: ReplayOperation[],
  startTimestamp: string | undefined,
  lang: Lang,
): string {
  const zh = lang === 'zh';
  const facetsByEventId = new Map<string, Set<string>>();
  for (const operation of operations) {
    for (const event of operation.events) {
      const facetIds = facetsByEventId.get(event.id) ?? new Set<string>();
      operation.facetIds.forEach((facetId) => facetIds.add(facetId));
      facetsByEventId.set(event.id, facetIds);
    }
  }
  const rows = events.map((event) => {
    const content = event.fullText ?? event.snippet ?? '';
    const preview = compactText(content || event.label || (zh ? '无事件内容' : 'No event content'), 180);
    const source = `${event.sourceLineIndex !== undefined ? `#${event.sourceLineIndex} · ` : ''}${shortHash(event.traceId ?? event.id)}`;
    const facetIds = [...(facetsByEventId.get(event.id) ?? [])];
    const kind = event.sourceType ? `${event.kind} · ${event.sourceType}` : event.kind;
    const sourceAttributes = `${event.sourceLineIndex !== undefined ? ` data-source-line-index="${event.sourceLineIndex}"` : ''}${event.traceId ? ` data-source-trace-id="${e(event.traceId)}"` : ''}`;
    return `<details class="trajectory-raw-row" data-trajectory-normalized-event="${e(event.id)}"${sourceAttributes} data-trajectory-facets="${e(facetIds.join(' '))}"><summary><time>${e(formatRelativeTimestamp(event.timestamp, startTimestamp))}</time><span class="trajectory-raw-kind">${e(kind)}</span><strong>${e(preview)}</strong><code class="trajectory-raw-id">${e(source)}</code></summary><pre>${e(content || event.label || '')}</pre></details>`;
  }).join('');
  return `<section class="trajectory-raw-list" data-event-view="normalized" aria-label="${zh ? '按来源顺序排列的规范化事件' : 'Normalized events in source order'}"><header class="trajectory-raw-head"><span>${zh ? '时间' : 'Time'}</span><span>${zh ? '规范化 / 来源类型' : 'Normalized / source type'}</span><span>${zh ? '内容' : 'Content'}</span><span>${zh ? '来源位置' : 'Source position'}</span></header>${rows}<div class="trajectory-raw-empty" data-trajectory-normalized-empty hidden>${zh ? '没有符合当前类型筛选的规范化事件' : 'No normalized events match the current type filter'}</div></section>`;
}

function renderTrajectoryViewExplanation(model: KnowledgeDebuggerViewModel, lang: Lang): string {
  const basisLabel = taskWindowBasisLabel(model, lang);
  if (lang === 'zh') {
    return `<h3>本页如何划定与呈现任务</h3>
      <p class="trajectory-boundary-flow">原始日志 → 规范化事件 → 语义轨迹</p>
      <dl class="trajectory-boundary-levels">
        <div><dt>原始日志</dt><dd>经脱敏和有界归档后保留的来源日志原文。</dd></div>
        <div><dt>规范化事件</dt><dd>OMK 将不同来源的私有格式转换成统一的 Trace IR。</dd></div>
        <div><dt>语义轨迹</dt><dd>面向人，把事件组织为对话、执行、结果和知识。</dd></div>
      </dl>
      <p class="trajectory-boundary-note">当前任务范围依据：${e(basisLabel)}。OMK 优先按 Agent turn 划定任务起止；Skill 只用于定位它属于哪次任务，不决定边界。三层并非一一对应，知识出现也不代表模型实际采用了它。</p>`;
  }
  return `<h3>How the three views relate</h3>
    <p class="trajectory-boundary-flow">Raw logs → Normalized events → Semantic trajectory</p>
    <dl class="trajectory-boundary-levels">
      <div><dt>Raw logs</dt><dd>Source log records retained after redaction and bounded archiving.</dd></div>
      <div><dt>Normalized events</dt><dd>Source-specific records converted by OMK into source-neutral Trace IR.</dd></div>
      <div><dt>Semantic trajectory</dt><dd>A human-readable projection across conversation, action, result, and knowledge lanes.</dd></div>
    </dl>
    <p class="trajectory-boundary-note">Current task boundary: ${e(basisLabel)}. OMK prefers the agent turn lifecycle; Skill evidence only locates the relevant task and does not define its boundaries. The layers are not one-to-one, and Knowledge appearing in context does not prove that the model used it.</p>`;
}

function taskWindowBasisLabel(model: KnowledgeDebuggerViewModel, lang: Lang): string {
  const turnId = model.taskScope.turnId ? ` · ${model.taskScope.turnId}` : '';
  if (model.taskScope.basis === 'turn_id') {
    return lang === 'zh' ? `Agent turn${turnId}` : `Agent turn${turnId}`;
  }
  if (model.taskScope.basis === 'turn_lifecycle') {
    return lang === 'zh' ? 'Agent turn 生命周期' : 'Agent turn lifecycle';
  }
  if (model.taskScope.basis === 'user_message') {
    return lang === 'zh' ? '用户消息边界（来源未提供 turn 标识）' : 'User-message boundary (source has no turn identity)';
  }
  return lang === 'zh' ? '无法判定' : 'Unresolved';
}

function renderSourceRecordList(
  model: KnowledgeDebuggerViewModel,
  startTimestamp: string | undefined,
  lang: Lang,
  sourceRecordsEndpoint?: string,
): string {
  const zh = lang === 'zh';
  const source = model.sourceRecords;
  const lazy = Boolean(sourceRecordsEndpoint && source.status !== 'unavailable' && source.recordCount > 0 && source.records.length === 0);
  const statusNotice = !lazy && source.status === 'partial'
    ? `<div class="trajectory-record-notice">${e(sourceRecordPartialNotice(source.recordCount, source.omittedRecordCount, lang))}</div>`
    : '';
  const rows = source.records.map((record) => {
    const preview = compactText(record.raw || (zh ? '空记录' : 'Empty record'), 180);
    const locator = `#${record.sourceIndex} · ${shortHash(record.traceId)}`;
    const notices = [
      record.redacted ? (zh ? '【不透明加密载荷已省略】' : '[Opaque encrypted payload omitted]') : '',
      record.truncated ? (zh ? '【该记录已按归档上限截断】' : '[Record truncated by archive limit]') : '',
    ].filter(Boolean).join('\n');
    return `<details class="trajectory-raw-row" data-source-line-index="${record.sourceIndex}" data-source-trace-id="${e(record.traceId)}"><summary><time>${e(formatRelativeTimestamp(record.timestamp, startTimestamp))}</time><span class="trajectory-raw-kind">${e(record.sourceType)}</span><strong>${e(preview)}</strong><code class="trajectory-raw-id">${e(locator)}</code></summary><pre>${e(record.raw)}${notices ? `\n\n${e(notices)}` : ''}</pre></details>`;
  }).join('');
  const unavailable = source.status === 'unavailable'
    ? `<div class="trajectory-raw-empty">${e(sourceRecordUnavailableLabel(source.reason, lang))}</div>`
    : '';
  const loading = lazy
    ? `<div class="trajectory-raw-empty" data-source-records-state>${zh ? '正在读取原始日志…' : 'Loading raw logs…'}</div>`
    : '';
  const endpoint = lazy ? ` data-source-records-endpoint="${e(sourceRecordsEndpoint)}"` : '';
  const start = startTimestamp ? ` data-source-records-start="${e(startTimestamp)}"` : '';
  return `<section class="trajectory-raw-list" data-event-view="source"${endpoint}${start} data-source-records-loaded="${lazy ? 'false' : 'true'}" aria-label="${zh ? '按来源顺序排列的原始日志' : 'Raw logs in source order'}"><header class="trajectory-raw-head"><span>${zh ? '时间' : 'Time'}</span><span>${zh ? '来源类型' : 'Source type'}</span><span>${zh ? '原始 JSONL' : 'Raw JSONL'}</span><span>${zh ? '来源位置' : 'Source position'}</span></header>${statusNotice}${rows}${unavailable}${loading}</section>`;
}

function sourceRecordPartialNotice(recordCount: number, omittedRecordCount: number, lang: Lang): string {
  if (omittedRecordCount === 0) return SOURCE_RECORD_PARTIAL_LABELS[lang].content;
  return SOURCE_RECORD_PARTIAL_LABELS[lang].records
    .replace('{retained}', String(recordCount))
    .replace('{omitted}', String(omittedRecordCount));
}

function sourceRecordUnavailableLabel(
  reason: KnowledgeDebuggerViewModel['sourceRecords']['reason'],
  lang: Lang,
): string {
  const zh = lang === 'zh';
  if (reason === 'source_missing') return zh ? '原始 trace 已不存在，无法生成原始日志归档。' : 'The original trace no longer exists.';
  if (reason === 'unsupported_source') return zh ? '当前来源暂不支持原始日志归档。' : 'Raw-log archiving is not supported for this source.';
  if (reason === 'read_failed') return zh ? '读取原始 trace 失败。' : 'The original trace could not be read.';
  if (reason === 'archive_limit') return zh ? '原始日志超过归档上限。' : 'Raw logs exceeded the archive limit.';
  if (reason === 'archive_invalid') return zh ? '原始日志归档无效或越过安全读取边界。' : 'The raw-log archive is invalid or outside the safe read boundary.';
  return zh
    ? '此报告没有原始日志归档。请重新执行 observe ingest；这里不会用规范化事件冒充原始日志。'
    : 'This report has no raw-log archive. Re-run observe ingest; normalized events are never presented as raw logs.';
}

function renderAxis(projection: ReplayProjection, lang: Lang): string {
  const ticks = visibleAxisTicks(projection)
    .map((tick) => `<span class="trajectory-tick" style="left:${Math.round(tick.position)}px">${e(tick.label)}</span>`)
    .join('');
  const gaps = projection.gaps.map((gap) => {
    const elapsed = formatElapsed(gap.durationMs, lang);
    const label = lang === 'zh' ? `${elapsed} · 无可观测事件` : `${elapsed} · no observable events`;
    return `<span class="trajectory-gap-axis" style="left:${Math.round(gap.position)}px;width:${Math.round(gap.width)}px" title="${e(label)}">${e(label)}</span>`;
  }).join('');
  const milestones = projection.milestones.map((milestone) => `<span class="trajectory-milestone-axis is-${milestone.tone}" style="left:${Math.round(milestone.position)}px" title="${e(milestone.label)}"><time>${e(formatRelativeTimestamp(milestone.timestamp, projection.startTimestamp))}</time><strong>${e(milestone.label)}</strong></span>`).join('');
  return `${ticks}${gaps}${milestones}`;
}

function renderGuides(projection: ReplayProjection): string {
  const ticks = visibleAxisTicks(projection)
    .map((tick) => `<span class="trajectory-guide" style="left:${Math.round(tick.position)}px"></span>`)
    .join('');
  const gaps = projection.gaps
    .map((gap) => `<span class="trajectory-gap-band" style="left:${Math.round(gap.position)}px;width:${Math.round(gap.width)}px"></span>`)
    .join('');
  const milestones = projection.milestones
    .filter((milestone) => !(milestone.tone === 'start' && milestone.position <= TRACK_START_PADDING))
    .map((milestone) => `<span class="trajectory-milestone-line is-${milestone.tone}" style="left:${Math.round(milestone.position)}px"></span>`)
    .join('');
  return `${ticks}${gaps}${milestones}`;
}

function renderIntegrityWarning(model: KnowledgeDebuggerViewModel, lang: Lang): string {
  if (model.integrity.status === 'complete') return '';
  const zh = lang === 'zh';
  const details = model.integrity.notices.map((notice) => INTEGRITY_LABELS[notice.code](notice.count, lang)).join(zh ? '；' : '; ');
  const hasDataDamage = model.integrity.notices.some((notice) => notice.code !== 'timeline_truncated');
  const heading = hasDataDamage
    ? (zh ? '轨迹数据存在限制：' : 'Trajectory data has limitations: ')
    : (zh ? '语义轨迹为摘要展示：' : 'Semantic trajectory is summarized: ');
  return `<div class="trajectory-warning"><strong>${heading}</strong>${e(details)}</div>`;
}

function displaySourceKind(value: string): string {
  if (value.toLowerCase() === 'codex') return 'Codex';
  if (value.toLowerCase() === 'claude') return 'Claude';
  return value;
}

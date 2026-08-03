import type { Lang } from '../types/index.js';
import type {
  DebugKnowledgeAccessKind,
  DebugKnowledgeEvidence,
  DebugKnowledgeKind,
  KnowledgeDebuggerViewModel,
} from '../types/index.js';
import { shellQuoteArg } from '../shared/shell-quote.js';
import { DEFAULT_LANG, e, layout } from './layout.js';

const KNOWLEDGE_KIND_LABELS: Record<DebugKnowledgeKind, Record<Lang, string>> = {
  project_instruction: { zh: '项目指令', en: 'Project instructions' },
  skill: { zh: 'Skill', en: 'Skill' },
  runtime_evidence: { zh: '运行时证据', en: 'Runtime evidence' },
};

const ACCESS_KIND_LABELS: Record<DebugKnowledgeAccessKind, Record<Lang, string>> = {
  injected: { zh: '进入上下文', en: 'Injected' },
  read: { zh: '被读取', en: 'Read' },
  returned: { zh: '工具返回', en: 'Returned' },
};

const TIMELINE_LABELS: Record<string, Record<Lang, string>> = {
  user_message: { zh: '用户', en: 'User' },
  synthetic_user_event: { zh: '系统事件', en: 'System event' },
  assistant_message: { zh: 'AI', en: 'AI' },
  runtime_context: { zh: '运行时上下文', en: 'Runtime context' },
  skill_context: { zh: 'Skill 上下文', en: 'Skill context' },
  tool_use: { zh: '工具调用', en: 'Tool call' },
  tool_result: { zh: '工具结果', en: 'Tool result' },
  observation: { zh: '观测', en: 'Observation' },
};

const GAP_KIND_LABELS = {
  missing: { zh: '缺失', en: 'Missing' },
  stale: { zh: '过时', en: 'Stale' },
  conflicting: { zh: '冲突', en: 'Conflicting' },
  out_of_scope: { zh: '越界', en: 'Out of scope' },
} as const;

export function renderKnowledgeDebuggerPage(
  model: KnowledgeDebuggerViewModel,
  lang: Lang = DEFAULT_LANG,
): string {
  const zh = lang === 'zh';
  const { session, knowledgeEvidence, knowledgeGaps, observationsDir } = model;
  const timeline = [...session.fullSessionTimeline].sort((a, b) => a.order - b.order);
  const evidenceByKind = new Map<DebugKnowledgeKind, DebugKnowledgeEvidence[]>();
  for (const item of knowledgeEvidence) {
    evidenceByKind.set(item.knowledgeKind, [...(evidenceByKind.get(item.knowledgeKind) ?? []), item]);
  }

  return layout(zh ? 'Knowledge 调试' : 'Knowledge Debugger', `
    <style>
      .kd-shell{max-width:1440px;margin:0 auto;padding:4px 0 12px;letter-spacing:0}
      .kd-breadcrumb{display:inline-flex;align-items:center;gap:8px;margin-bottom:12px;font-size:13px;color:var(--text-secondary)}
      .kd-breadcrumb:hover{text-decoration:none}
      .kd-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:16px}
      .kd-header h1{font-size:28px;margin:0 0 5px;letter-spacing:0}
      .kd-header p{margin:0;color:var(--text-secondary);font-size:14px}
      .kd-session-meta{display:flex;flex-wrap:wrap;gap:7px;justify-content:flex-end;max-width:58%}
      .kd-meta{border:1px solid var(--border);background:var(--bg-surface);border-radius:5px;padding:4px 9px;font-size:12px;color:var(--text-secondary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .kd-caution{margin:0 0 18px;padding:10px 13px;border-left:3px solid var(--yellow);background:var(--yellow-bg);font-size:13px;color:var(--text-secondary)}
      .kd-evidence-levels{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:-8px 0 18px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface);overflow:hidden}
      .kd-level{min-width:0;padding:10px 12px;border-right:1px solid var(--border)}
      .kd-level:last-child{border-right:0}
      .kd-level strong{display:block;margin-bottom:2px;font-size:12px;color:var(--text-primary)}
      .kd-level span{display:block;font-size:11px;line-height:1.45;color:var(--text-muted)}
      .kd-level-current strong{color:var(--accent)}
      .kd-grid{display:grid;grid-template-columns:minmax(0,1.28fr) minmax(380px,.72fr);gap:18px;align-items:start}
      .kd-panel{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;min-width:0}
      .kd-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)}
      .kd-panel-head h2{font-size:15px;margin:0;letter-spacing:0}
      .kd-panel-count{font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums}
      .kd-timeline{padding:4px 16px 12px}
      .kd-event{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px;padding:12px 0;border-bottom:1px solid var(--border)}
      .kd-event:last-child{border-bottom:0}
      .kd-event-type{font-size:12px;font-weight:650;color:var(--text-secondary)}
      .kd-event-time{display:block;margin-top:2px;font-size:11px;font-weight:400;color:var(--text-muted);font-variant-numeric:tabular-nums}
      .kd-event-body{min-width:0}
      .kd-event-title{font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:3px}
      .kd-event-text{font-size:13px;color:var(--text-secondary);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
      .kd-event details{margin-top:7px}
      .kd-event summary{cursor:pointer;color:var(--accent);font-size:12px}
      .kd-event pre{max-height:340px;overflow:auto;margin:7px 0 0;padding:10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:5px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .kd-side{display:grid;gap:18px;min-width:0}
      .kd-knowledge-groups{padding:4px 16px 14px}
      .kd-group{padding:12px 0;border-bottom:1px solid var(--border)}
      .kd-group:last-child{border-bottom:0}
      .kd-group h3{font-size:12px;color:var(--text-muted);margin:0 0 8px;text-transform:none;letter-spacing:0}
      .kd-knowledge{padding:10px 11px;margin-top:7px;border:1px solid var(--border);border-radius:6px;background:var(--bg-soft)}
      .kd-knowledge-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .kd-knowledge strong{font-size:13px;overflow-wrap:anywhere}
      .kd-access{flex:none;border-radius:4px;padding:2px 6px;background:var(--info-bg);color:var(--accent);font-size:11px;font-weight:600}
      .kd-knowledge-meta{margin-top:7px;display:grid;gap:3px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-muted);overflow-wrap:anywhere}
      .kd-empty{padding:18px 16px;color:var(--text-muted);font-size:13px}
      .kd-gap-body{padding:14px 16px 16px}
      .kd-field{display:grid;gap:5px;margin-bottom:11px}
      .kd-field label{font-size:12px;font-weight:600;color:var(--text-secondary)}
      .kd-field select,.kd-field textarea{width:100%;border:1px solid var(--border-hover);border-radius:5px;background:var(--bg-surface);color:var(--text-primary);font:13px/1.5 inherit;padding:8px 9px;letter-spacing:0}
      .kd-field textarea{min-height:82px;resize:vertical}
      .kd-field select:focus,.kd-field textarea:focus{outline:2px solid rgba(79,70,229,.2);border-color:var(--accent)}
      .kd-submit{border:0;border-radius:5px;background:var(--accent);color:#fff;padding:8px 12px;font-size:13px;font-weight:650;cursor:pointer}
      .kd-submit:disabled{opacity:.55;cursor:wait}
      .kd-form-status{min-height:20px;margin-top:7px;color:var(--text-secondary);font-size:12px}
      .kd-gap-list{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
      .kd-gap{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;padding:9px 0;border-bottom:1px solid var(--border)}
      .kd-gap:last-child{border-bottom:0}
      .kd-gap-label{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:650}
      .kd-gap-note{margin-top:3px;color:var(--text-secondary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
      .kd-gap-evidence{margin-top:3px;color:var(--text-muted);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
      .kd-gap-candidate{margin-top:7px;padding:7px 8px;border-left:2px solid var(--accent);background:var(--info-bg);color:var(--text-secondary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
      .kd-gap-command{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center;margin-top:8px}
      .kd-gap-command code{display:block;min-width:0;padding:7px 8px;border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
      .kd-copy{border:1px solid var(--border-hover);background:var(--bg-surface);color:var(--text-secondary);border-radius:5px;padding:6px 8px;font-size:12px;cursor:pointer;white-space:nowrap}
      .kd-copy:hover{border-color:var(--accent);color:var(--accent)}
      .kd-delete{align-self:start;border:1px solid var(--border);background:transparent;color:var(--text-muted);border-radius:5px;padding:4px 7px;font-size:12px;cursor:pointer}
      .kd-delete:hover{border-color:var(--red);color:var(--red)}
      .kd-evidence-links{display:flex;flex-wrap:wrap;gap:7px;margin-top:7px;font-size:11px}
      .kd-evidence-links a{color:var(--accent)}
      @media(max-width:980px){.kd-grid{grid-template-columns:1fr}.kd-session-meta{max-width:none;justify-content:flex-start}.kd-header{align-items:flex-start;flex-direction:column;gap:10px}.kd-evidence-levels{grid-template-columns:repeat(2,minmax(0,1fr))}.kd-level:nth-child(2){border-right:0}.kd-level:nth-child(-n+2){border-bottom:1px solid var(--border)}}
      @media(max-width:640px){.kd-shell{padding:0}.kd-event{grid-template-columns:1fr;gap:4px}.kd-header h1{font-size:23px}.kd-meta{max-width:100%}.kd-evidence-levels{grid-template-columns:1fr}.kd-level,.kd-level:nth-child(2){border-right:0;border-bottom:1px solid var(--border)}.kd-level:last-child{border-bottom:0}.kd-gap-command{grid-template-columns:1fr}.kd-copy{justify-self:start}}
    </style>
    <main class="kd-shell">
      <a class="kd-breadcrumb" href="/observe-inbox${lang === DEFAULT_LANG ? '' : `?lang=${lang}`}">${zh ? '← 返回观测收件箱' : '← Back to observation inbox'}</a>
      <header class="kd-header">
        <div>
          <h1>${zh ? 'Knowledge 调试' : 'Knowledge Debugger'}</h1>
          <p>${zh ? '沿一次真实执行，检查哪些 knowledge 进入了 AI 的工作上下文。' : 'Inspect which knowledge entered the AI working context during one real run.'}</p>
        </div>
        <div class="kd-session-meta">
          <span class="kd-meta">${e(session.sourceKind)}</span>
          <span class="kd-meta">${e(session.skillName)}</span>
          ${session.cwd ? `<span class="kd-meta" title="${e(session.cwd)}">${e(session.cwd)}</span>` : ''}
          <span class="kd-meta" title="${e(session.sessionId)}">${e(session.sessionId)}</span>
        </div>
      </header>
      <div class="kd-caution">${zh
        ? '证据只说明 knowledge 已进入上下文、被读取或由工具返回；它不代表模型一定采用了这些内容，也不能单独证明因果。'
        : 'Evidence only shows that knowledge was injected, read, or returned by a tool. It does not prove that the model used it or establish causality.'}</div>
      <div class="kd-evidence-levels" aria-label="${zh ? '证据层级' : 'Evidence levels'}">
        <div class="kd-level kd-level-current"><strong>${zh ? '观测事实' : 'Observed fact'}</strong><span>${zh ? '时间线与 knowledge 来源' : 'Timeline and knowledge provenance'}</span></div>
        <div class="kd-level kd-level-current"><strong>${zh ? '用户诊断' : 'User diagnosis'}</strong><span>${zh ? '人工确认的 Knowledge Gap' : 'Human-confirmed Knowledge Gap'}</span></div>
        <div class="kd-level"><strong>${zh ? '系统推断' : 'System inference'}</strong><span>${zh ? 'MVP 不自动推断根因' : 'No automatic root-cause claim in MVP'}</span></div>
        <div class="kd-level"><strong>${zh ? '受控证据' : 'Controlled evidence'}</strong><span>${zh ? '进入 doctor → eval 后获得' : 'Produced by doctor → eval'}</span></div>
      </div>
      <div class="kd-grid">
        <section class="kd-panel">
          <header class="kd-panel-head"><h2>${zh ? '执行时间线' : 'Execution timeline'}</h2><span class="kd-panel-count">${timeline.length} ${zh ? '条证据' : 'events'}</span></header>
          ${timeline.length > 0 ? `<div class="kd-timeline">${timeline.map((event) => {
            const label = TIMELINE_LABELS[event.kind]?.[lang] ?? event.kind;
            const title = event.toolName ?? event.label ?? label;
            const snippet = event.snippet ?? event.fullText ?? '';
            const fullText = event.fullText && event.fullText !== snippet ? event.fullText : '';
            return `<article class="kd-event" id="event-${e(event.id)}">
              <div class="kd-event-type">${e(label)}${event.timestamp ? `<span class="kd-event-time">${e(formatTimestamp(event.timestamp))}</span>` : ''}</div>
              <div class="kd-event-body">
                <div class="kd-event-title">${e(title)}</div>
                ${snippet ? `<div class="kd-event-text">${e(snippet)}</div>` : ''}
                ${fullText ? `<details><summary>${zh ? '查看完整证据' : 'View full evidence'}</summary><pre>${e(fullText)}</pre></details>` : ''}
              </div>
            </article>`;
          }).join('')}</div>` : `<div class="kd-empty">${zh ? '这次执行没有可展示的时间线。' : 'No timeline is available for this run.'}</div>`}
        </section>
        <aside class="kd-side">
          <section class="kd-panel">
            <header class="kd-panel-head"><h2>${zh ? 'Knowledge 证据' : 'Knowledge evidence'}</h2><span class="kd-panel-count">${knowledgeEvidence.length}</span></header>
            ${knowledgeEvidence.length > 0 ? `<div class="kd-knowledge-groups">${([...evidenceByKind.entries()]).map(([knowledgeKind, items]) => `
              <section class="kd-group">
                <h3>${e(KNOWLEDGE_KIND_LABELS[knowledgeKind][lang])}</h3>
                ${items.map((item) => renderKnowledgeEvidence(item, lang)).join('')}
              </section>`).join('')}</div>` : `<div class="kd-empty">${zh ? '没有识别出可定位的 knowledge 证据。' : 'No locatable knowledge evidence was found.'}</div>`}
          </section>
          <section class="kd-panel">
            <header class="kd-panel-head"><h2>${zh ? 'Knowledge 缺口' : 'Knowledge gaps'}</h2><span class="kd-panel-count">${knowledgeGaps.length}</span></header>
            <div class="kd-gap-body">
              <form id="knowledge-gap-form" data-experience-session-id="${e(session.id)}">
                <div class="kd-field"><label for="gap-kind">${zh ? '类型' : 'Type'}</label><select id="gap-kind" name="gapKind" required>
                  ${Object.entries(GAP_KIND_LABELS).map(([value, labels]) => `<option value="${value}">${e(labels[lang])}</option>`).join('')}
                </select></div>
                <div class="kd-field"><label for="gap-evidence">${zh ? '关联证据' : 'Related evidence'}</label><select id="gap-evidence" name="knowledgeEvidenceId">
                  <option value="">${zh ? '不关联现有证据' : 'No existing evidence'}</option>
                  ${knowledgeEvidence.map((item) => `<option value="${e(item.id)}">${e(item.label)} · ${e(ACCESS_KIND_LABELS[item.accessKind][lang])}</option>`).join('')}
                </select></div>
                <div class="kd-field"><label for="gap-note">${zh ? '缺口描述' : 'Gap description'}</label><textarea id="gap-note" name="note" maxlength="500" required placeholder="${zh ? '缺了什么、哪里过时，或哪些规则互相冲突？' : 'What is missing, stale, conflicting, or out of scope?'}"></textarea></div>
                <div class="kd-field"><label for="candidate-knowledge">${zh ? '候选 knowledge（可选）' : 'Candidate knowledge (optional)'}</label><textarea id="candidate-knowledge" name="candidateKnowledge" maxlength="2000" placeholder="${zh ? '你认为 AI 下次应该获得什么明确规则或事实？' : 'What explicit rule or fact should the AI receive next time?'}"></textarea></div>
                <button class="kd-submit" type="submit">${zh ? '记录缺口' : 'Record gap'}</button>
                <div class="kd-form-status" id="knowledge-gap-status" role="status"></div>
              </form>
              ${knowledgeGaps.length > 0 ? `<div class="kd-gap-list">${knowledgeGaps.map((gap) => `<div class="kd-gap">
                <div><div class="kd-gap-label">${e(gap.gapKind ? GAP_KIND_LABELS[gap.gapKind][lang] : '')}</div>
                ${gap.note ? `<div class="kd-gap-note">${e(gap.note)}</div>` : ''}
                ${gap.knowledgeEvidenceId ? `<div class="kd-gap-evidence">${e(gap.knowledgeEvidenceId)}</div>` : ''}
                ${gap.candidateKnowledge ? `<div class="kd-gap-candidate"><strong>${zh ? '待复核候选：' : 'Candidate for review: '}</strong>${e(gap.candidateKnowledge)}</div>` : ''}
                <div class="kd-gap-command"><code title="${e(sampleFromGapCommand(gap.targetId, observationsDir))}">${e(sampleFromGapDisplayCommand(gap.targetId))}</code><button type="button" class="kd-copy" data-copy-command="${e(sampleFromGapCommand(gap.targetId, observationsDir))}">${zh ? '复制命令' : 'Copy command'}</button></div></div>
                <button type="button" class="kd-delete" data-gap-id="${e(gap.targetId)}" title="${zh ? '删除缺口' : 'Delete gap'}">${zh ? '删除' : 'Delete'}</button>
              </div>`).join('')}</div>` : ''}
            </div>
          </section>
        </aside>
      </div>
    </main>
    <script>
      (function () {
        var form = document.getElementById('knowledge-gap-form');
        var status = document.getElementById('knowledge-gap-status');
        if (form) form.addEventListener('submit', async function (event) {
          event.preventDefault();
          var submit = form.querySelector('button[type="submit"]');
          submit.disabled = true;
          status.textContent = ${JSON.stringify(zh ? '正在保存…' : 'Saving…')};
          var data = new FormData(form);
          try {
            var response = await fetch('/api/observe-debugger/gaps', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                experienceSessionId: form.dataset.experienceSessionId,
                gapKind: data.get('gapKind'),
                knowledgeEvidenceId: data.get('knowledgeEvidenceId') || undefined,
                note: data.get('note'),
                candidateKnowledge: data.get('candidateKnowledge') || undefined
              })
            });
            if (!response.ok) throw new Error(await response.text());
            window.location.reload();
          } catch (error) {
            status.textContent = ${JSON.stringify(zh ? '保存失败，请重试。' : 'Save failed. Try again.')};
            submit.disabled = false;
          }
        });
        document.addEventListener('click', async function (event) {
          var copyButton = event.target && event.target.closest ? event.target.closest('[data-copy-command]') : null;
          if (copyButton) {
            try {
              await navigator.clipboard.writeText(copyButton.dataset.copyCommand);
              copyButton.textContent = ${JSON.stringify(zh ? '已复制' : 'Copied')};
            } catch (error) {
              copyButton.textContent = ${JSON.stringify(zh ? '复制失败' : 'Copy failed')};
            }
            return;
          }
          var button = event.target && event.target.closest ? event.target.closest('[data-gap-id]') : null;
          if (!button) return;
          button.disabled = true;
          try {
            var response = await fetch('/api/observe-inbox/review-state?targetType=knowledge_gap&targetId=' + encodeURIComponent(button.dataset.gapId), { method: 'DELETE' });
            if (!response.ok) throw new Error(await response.text());
            window.location.reload();
          } catch (error) {
            button.disabled = false;
          }
        });
      })();
    </script>
  `, lang);
}

function renderKnowledgeEvidence(item: DebugKnowledgeEvidence, lang: Lang): string {
  const zh = lang === 'zh';
  return `<article class="kd-knowledge" id="${e(item.id)}">
    <div class="kd-knowledge-top"><strong>${e(item.label)}</strong><span class="kd-access">${e(ACCESS_KIND_LABELS[item.accessKind][lang])}</span></div>
    <div class="kd-knowledge-meta">
      ${item.sourceLocator ? `<span>${e(item.sourceLocator)}</span>` : ''}
      ${item.contentHash ? `<span>sha256:${e(item.contentHash.slice(0, 12))}</span>` : ''}
      ${item.firstSeen ? `<span>${zh ? '首次：' : 'First: '}${e(formatTimestamp(item.firstSeen))}</span>` : ''}
      ${item.lastSeen && item.lastSeen !== item.firstSeen ? `<span>${zh ? '最近：' : 'Latest: '}${e(formatTimestamp(item.lastSeen))}</span>` : ''}
      <span>${item.accessCount} ${zh ? '次证据' : item.accessCount === 1 ? 'evidence event' : 'evidence events'}</span>
    </div>
    <div class="kd-evidence-links">${item.evidenceRefs.map((ref, index) => `<a href="#event-${e(ref.id)}">${zh ? `原始证据 ${index + 1}` : `Raw evidence ${index + 1}`}</a>`).join('')}</div>
  </article>`;
}

function sampleFromGapCommand(targetId: string, observationsDir?: string): string {
  const dir = observationsDir ?? '.omk/observe-inbox';
  return `omk sample --from-traces --observations-dir ${shellQuoteArg(dir)} --gap ${shellQuoteArg(targetId)}`;
}

function sampleFromGapDisplayCommand(targetId: string): string {
  return `omk sample --from-traces --gap ${shellQuoteArg(targetId)}`;
}

function formatTimestamp(value: string): string {
  return value.slice(0, 19).replace('T', ' ');
}

import { DEFAULT_LANG, e, layout } from '../layout.js';
import type { Lang } from '../../../shared/language.js';
import type { ObservationInboxViewModel } from '../../../observability/inbox/view-model.js';
import { shellQuoteArg } from '../../../shared/shell-quote.js';
import { observationInboxClientScript } from './client-script.js';
import type { ObservationExperienceWorkspace } from './experience-workspace-renderer.js';
import type { ObservationProcessWorkspace } from './process-workspace-renderer.js';
import type { ObservationReviewRenderers } from './review-renderer.js';
import { OBSERVATION_INBOX_STYLES } from './styles.js';

export function renderObservationInboxDocument({
  model,
  lang = DEFAULT_LANG,
  experienceWorkspace,
  processWorkspace,
  reviewRenderers,
}: {
  readonly model: ObservationInboxViewModel;
  readonly lang?: Lang;
  readonly experienceWorkspace: ObservationExperienceWorkspace;
  readonly processWorkspace: ObservationProcessWorkspace;
  readonly reviewRenderers: ObservationReviewRenderers;
}): string {
  const {
    activeSkill,
    allItems,
    items,
    latestSeenLabel,
    observationsDir,
    reportCount,
    reports,
    severitySkillCounts,
    skillCount,
    totalSkillInvocations,
  } = model;
  const pageTitle = activeSkill ? `Observe Inbox · ${activeSkill}` : 'Observe Inbox';
  const countSkillsBySeverity = (...severities: ObservationInboxViewModel['allItems'][number]['severity'][]): number =>
    new Set(allItems.filter((item) => severities.includes(item.severity)).map((item) => item.skillName)).size;
  const sessionTimeLabel = lang === 'zh' ? 'Session 时间' : 'Session time';
  const {
    empty,
    experienceSection,
    reportSessionCount,
    reportSessionRangeLabel,
  } = experienceWorkspace;
  const {
    actionRows,
    funnelHtml,
    metricGuideHtml,
    rawReportBlocks,
    rawRows,
    skillRollupRows,
    skillRollups,
    skillSections,
  } = processWorkspace;
  const { renderConfidenceHeader } = reviewRenderers;
  const recyclableObservationCount = allItems.filter((item) => item.severity !== 'noise').reduce((sum, item) => sum + item.occurrences, 0);
  const sampleFromTracesBaseCommand = `omk sample --from-traces --observations-dir ${shellQuoteArg(observationsDir || '.omk/observe-inbox')}`;
  const sampleFromTracesCommand = activeSkill
    ? `${sampleFromTracesBaseCommand} --skill ${shellQuoteArg(activeSkill)}`
    : sampleFromTracesBaseCommand;
  const observeLoopCta = recyclableObservationCount > 0
    ? `<section data-observe-feedback-loop style="margin-top:14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);padding:12px 14px;font-size:13px;line-height:1.55">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <div style="font-weight:700;color:var(--text-primary)">${lang === 'zh' ? '把已确认的 observe gap 回流成 eval sample' : 'Recycle confirmed observe gaps into eval samples'}</div>
            <div style="color:var(--text-muted);margin-top:3px">${lang === 'zh' ? `当前有 ${recyclableObservationCount} 个非噪声信号。先 review 高风险或抽样信号，确认可复现后生成草稿。` : `${recyclableObservationCount} non-noise signal(s) are available. Review high-risk / sampled signals first, then draft reproducible cases.`}</div>
          </div>
          <code style="display:block;max-width:100%;overflow:auto;white-space:nowrap;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary)">${e(sampleFromTracesCommand)}</code>
        </div>
      </section>`
    : '';
  const v0SummarySection = `
      <section class="observe-summary-grid" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px">
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
          <div style="color:var(--text-muted);font-size:12px">${reportSessionCount} sessions · ${totalSkillInvocations} skill 调用 · ${allItems.length} 过程发现</div>
          <div style="color:var(--text-muted);font-size:12px">${e(sessionTimeLabel)}: ${e(reportSessionRangeLabel)}</div>
          <div style="color:var(--text-muted);font-size:12px">${reportCount} reports · latest ${e(latestSeenLabel)}</div>
          <div style="color:var(--text-muted);font-size:12px">当前只展示最新一次 ingest 的结果</div>
        </div>
      </section>`;
  const ingestionIssues = reports.reduce((totals, report) => {
    const ingestion = report.meta.ingestion;
    if (!ingestion) return totals;
    totals.malformed += ingestion.malformedRecordCount;
    totals.ignored += ingestion.ignoredValueCount;
    totals.unknown += ingestion.unknownEventCount;
    return totals;
  }, { malformed: 0, ignored: 0, unknown: 0 });
  const ingestionNotice = ingestionIssues.malformed > 0
    || ingestionIssues.ignored > 0
    || ingestionIssues.unknown > 0
    ? `<div style="margin:12px 0;padding:10px 12px;border:1px solid var(--yellow);border-radius:8px;background:var(--yellow-bg);color:var(--text-secondary);font-size:13px">
        <strong style="color:var(--yellow)">${lang === 'zh' ? '观测输入需要复核' : 'Observation input needs review'}</strong>
        <span style="margin-left:8px">${lang === 'zh'
          ? `${ingestionIssues.malformed} 条格式损坏记录，${ingestionIssues.ignored} 个非对象值，${ingestionIssues.unknown} 个未识别事件。`
          : `${ingestionIssues.malformed} malformed records, ${ingestionIssues.ignored} non-object values, ${ingestionIssues.unknown} unrecognized events.`}</span>
      </div>`
    : '';
	  return layout(pageTitle, `
	    <main class="observe-report-root">
	      <nav style="margin-bottom:12px"><a href="/observe-health" style="color:var(--accent);text-decoration:none">${lang === 'zh' ? '能力健康度日报' : 'Skill health reports'}</a></nav>
	      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0">
	        <div>
	          <h1 style="font-size:22px;margin:0">${activeSkill ? `观测收件箱 · ${e(activeSkill)}` : '观测收件箱'}</h1>
	          ${activeSkill ? `<div style="color:var(--text-muted);font-size:12px;margin-top:4px">当前只展示能力 ${e(activeSkill)} 的复盘记录。</div>` : ''}
	        </div>
	        ${activeSkill ? `<a href="/observe-inbox" style="color:var(--accent);text-decoration:none;font-size:13px">查看全量</a>` : ''}
	      </div>
      ${ingestionNotice}
      <style>${OBSERVATION_INBOX_STYLES}</style>
      <div id="signal-global-tooltip" role="tooltip"></div>
      <div id="timeline-fulltext-tooltip" role="dialog" aria-modal="true" aria-hidden="true" aria-label="时间线消息详情"></div>
      <div id="experience-detail-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Session 回溯详情"></div>
      <aside id="inbox-metric-popover" role="dialog" aria-modal="false" aria-hidden="true" aria-label="指标详情"></aside>
      <div id="metric-guide-toolbar" aria-label="指标说明工具栏">
        <button type="button" title="指标说明" aria-label="指标说明" onclick="window.toggleMetricGuide && window.toggleMetricGuide()">?</button>
      </div>
      <aside id="metric-guide-panel" aria-label="指标含义和评判标准">
        <div class="metric-guide-header">
          <div>
            <h2>指标含义和评判标准</h2>
            <p>这些指标只解释 trace 里观察到的证据，不自动判断 skill 最终好坏。</p>
          </div>
          <button type="button" onclick="closeMetricGuide()">关闭</button>
        </div>
        <div class="metric-guide-body">${metricGuideHtml}</div>
      </aside>
      ${empty}
      ${observeLoopCta}
      ${experienceSection}
      <div data-v0-observation-view style="display:none">
      <div class="report-version-divider" aria-label="1.0 和 2.0 报告分隔">
        <div></div>
        <span>V1 · Skill 实战复盘结束 · 以下进入 V0 · 过程发现视图</span>
        <div></div>
      </div>
      <section style="margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);padding:13px 14px">
        <h2 style="font-size:15px;margin:0;color:var(--text-primary)">V0 · 过程发现总览</h2>
        <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这里是老版 inbox / 过程发现维度，只看 severity、signal、dedup 后过程发现，不参与 V1 的 session 复盘判断。</div>
        ${v0SummarySection}
      </section>
      <section style="margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:13px 14px;border-bottom:1px solid var(--border)">
          <div>
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Skill 观测看板</h2>
            <div style="color:var(--text-muted);font-size:12px;margin-top:3px">一行一个 skill。子项指标同时汇总 trace 工具调用和 过程发现 信号：工具调用看运行行为，过程发现 看发现的问题类型。</div>
          </div>
          <div style="color:var(--text-muted);font-size:12px;white-space:nowrap">${skillRollups.length} trace skills</div>
        </div>
        <div class="observe-table-wrap" style="width:100%;max-height:70vh;overflow:auto">
          <table class="observe-fit-table skill-health-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
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
      <section class="observe-action-funnel-grid" style="margin-top:16px;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:12px;align-items:start">
        <section id="observe-action-panel" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden;display:flex;flex-direction:column">
          <div style="padding:13px 14px;border-bottom:1px solid var(--border)">
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Reviewer 待办建议</h2>
            <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这张表回答“我现在该先看哪个 skill、看什么”。它只给 review 优先级，不自动判定必须改。点击行可跳到对应 skill 明细。</div>
          </div>
          ${actionRows ? `<div class="observe-table-wrap" style="width:100%;overflow:auto;flex:1;min-height:0">
            <table class="observe-fit-table action-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
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
          <div class="observe-table-wrap">
          <table class="observe-fit-table scoring-guide-table" style="border-collapse:collapse;width:100%;font-size:12px">
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
                <td style="padding:7px 8px">文件不存在、文件太长、权限失败、工具执行失败或超时。</td>
                <td style="padding:7px 8px">通常不是 skill 内容缺失。先看环境、路径、权限、文件大小或工具调用方式。</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </section>
      <section style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px">
        <input id="observe-filter-input" type="search" placeholder="Filter skill / signal / evidence / path" style="flex:1;min-width:0;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text-primary);font-size:13px">
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
        ${reports.length > 0 ? `<div class="observe-table-wrap" style="width:100%;overflow-x:auto"><table class="observe-fit-table raw-observation-table" style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
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
        </table></div>${rawReportBlocks}` : `<p style="color:var(--text-muted);margin-top:24px">${lang === 'zh' ? '暂无过程发现 JSON。' : 'No observation JSON yet.'}</p>`}
      </section>
      </div>
      <script>${observationInboxClientScript(lang)}      </script>
    </main>
  `, lang);
}

import { DEFAULT_LANG, layout, e } from './layout.js';
import type { Lang } from '../../shared/language.js';
import type {
  ObservationInboxItem,
  ObservationInboxViewModel,
  ResolvedObservationReviewSession,
  ResolvedOwnerSuggestion,
} from '../../observability/inbox/view-model.js';
import { durationMsBetween } from '../../shared/time.js';
import { incrementRecordCount } from '../../shared/record-count.js';
import { OBSERVATION_INBOX_STYLES } from './observation-inbox/styles.js';
import { observationInboxClientScript } from './observation-inbox/client-script.js';
import {
  createObservationMetricRenderers,
  type IndicatorHelpKey,
} from './observation-inbox/metric-renderer.js';
import { createObservationReviewRenderers } from './observation-inbox/review-renderer.js';
import { createObservationSignalRenderers } from './observation-inbox/signal-renderer.js';
import { createObservationSkillChainRenderers } from './observation-inbox/skill-chain-renderer.js';
import { createReviewerReportRenderers } from './observation-inbox/reviewer-report.js';
import {
  isAssistantCompletionResultSignal,
  isAssistantDeliverableArtifactSignal,
} from './observation-inbox/timeline.js';
import {
  experienceSkillAnchor,
  formatTimeRange as formatTimeRangeImpl,
  formatTimestamp,
  renderJson,
  skillAnchor,
} from './observation-inbox/helpers.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';
export { renderFeedbackAttributionLabel } from './observation-inbox/helpers.js';
import type {
  ExperienceChecklistItem,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceInvocation,
  ExperienceReviewPriority,
  ExperienceReviewerReport,
  ExperienceEpisode,
  ExperienceFeedbackSignal,
  ExperienceSkillSegment,
  ExperienceSessionStoryAnswer,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../../observability/inbox/feedback-projection.js';

export function renderObservationInboxPage(model: ObservationInboxViewModel, lang: Lang = DEFAULT_LANG): string {
	  const {
	    observationsDir,
	    activeSkill,
	    allItems,
	    items,
    reports,
    experienceReports,
    skillInvocationCounts,
    skillSessionCounts,
    skillInvocationLastSeen,
    skillToolCallCounts,
    skillChains,
    skillDerivedStandards,
    totalSkillInvocations,
    severitySkillCounts,
    skillCount,
    reportCount,
    latestSeenLabel,
	    reviewState,
    resolvedReviewSessions,
	  } = model;
	  const experience = experienceReports.find((report) => report.skills.length > 0 || report.sessions.length > 0 || report.invocations.length > 0);
	  const {
	    cleanReportCopy,
	    fallbackSessionStory,
	    renderReviewerReport,
	  } = createReviewerReportRenderers(skillDerivedStandards);
	  const pageTitle = activeSkill ? `Observe Inbox · ${activeSkill}` : 'Observe Inbox';
  const experienceToolCountsBySkill = new Map<string, Record<string, number>>();
  const experienceEntrypointCountsBySkill = new Map<string, Record<string, number>>();
  const experienceSkillOriginCountsBySkill = new Map<string, Record<string, number>>();
  const experienceAttributionCountsBySkill = new Map<string, Record<string, number>>();
  for (const invocation of experience?.invocations ?? []) {
    const toolCounts = experienceToolCountsBySkill.get(invocation.skillName) ?? {};
    for (const [tool, count] of Object.entries(invocation.toolCounts ?? {})) {
      incrementRecordCount(toolCounts, tool, count);
    }
    experienceToolCountsBySkill.set(invocation.skillName, toolCounts);

    const entrypoint = invocation.entrypoint ?? invocation.sourceKind ?? 'unknown';
    const entrypointCounts = experienceEntrypointCountsBySkill.get(invocation.skillName) ?? {};
    incrementRecordCount(entrypointCounts, entrypoint);
    experienceEntrypointCountsBySkill.set(invocation.skillName, entrypointCounts);

    const originLabel = invocation.attribution.pluginName
      ? `Skill 来源：插件 ${invocation.attribution.pluginName}`
      : 'Skill 来源：本地 skill';
    const originCounts = experienceSkillOriginCountsBySkill.get(invocation.skillName) ?? {};
    incrementRecordCount(originCounts, originLabel);
    experienceSkillOriginCountsBySkill.set(invocation.skillName, originCounts);

    const attributionMethod = invocation.attribution.source === 'command-name'
      ? '通过斜杠命令触发'
      : invocation.attribution.source === 'skill-tool'
        ? '通过 Skill 工具启动'
        : invocation.attribution.source === 'business-action' || invocation.attribution.source === ['ai', 'ma-cmd'].join('')
          ? '通过业务动作触发'
        : invocation.attribution.source === 'read-skill-md'
          ? '通过读取 Skill 文档推断'
          : invocation.attribution.source === 'general'
            ? '未识别到明确触发方式'
            : invocation.attribution.source || '未记录触发方式';
    const attributionTarget = invocation.attribution.commandName ?? invocation.attribution.rawSkillRef ?? invocation.skillName;
    const attributionLabel = attributionTarget ? `${attributionMethod}：${attributionTarget}` : attributionMethod;
    const attributionCounts = experienceAttributionCountsBySkill.get(invocation.skillName) ?? {};
    incrementRecordCount(attributionCounts, attributionLabel);
    experienceAttributionCountsBySkill.set(invocation.skillName, attributionCounts);
  }
  const countSkillsBySeverity = (...severities: ObservationInboxItem['severity'][]): number =>
    new Set(allItems.filter((item) => severities.includes(item.severity)).map((item) => item.skillName)).size;
  const sessionTimeLabel = lang === 'zh' ? 'Session 时间' : 'Session time';
  const sessionTimeRangeLabel = lang === 'zh' ? 'Session 时间范围' : 'Session time range';
  const latestInvocationLabel = lang === 'zh' ? '最近调用' : 'Latest invocation';
  const invocationWindowLabel = lang === 'zh' ? '调用窗口' : 'Invocation window';
  const formatTimeRange = (start?: string, end?: string, durationMs?: number): string => formatTimeRangeImpl(start, end, durationMs, lang);
  const timestampedOccurrences = (item: ObservationInboxItem): number =>
    item.timestampedOccurrences
      ?? (item.firstSeen === '1970-01-01T00:00:00.000Z' ? 0 : item.occurrences);
  const observedItemTimestamp = (item: ObservationInboxItem, value: string): string =>
    timestampedOccurrences(item) > 0
      ? value.slice(0, 19).replace('T', ' ')
      : (lang === 'zh' ? '未记录' : 'Not recorded');
  const sessionTimestampedInvocationCount = (session: ExperienceSessionSummary): number =>
    session.timestampedInvocationCount
      ?? (session.startTimestamp === '1970-01-01T00:00:00.000Z' ? 0 : session.invocationIds.length);
  const observedSessionRange = (session: ExperienceSessionSummary): string => {
    const count = sessionTimestampedInvocationCount(session);
    if (count === 0) return lang === 'zh' ? '未记录' : 'Not recorded';
    const range = formatTimeRange(session.startTimestamp, session.endTimestamp);
    return count < session.invocationIds.length
      ? `${range}${lang === 'zh' ? '（部分调用无时间）' : ' (partial timestamps)'}`
      : range;
  };
  const observedSessionTimestamp = (session: ExperienceSessionSummary, value: string): string =>
    sessionTimestampedInvocationCount(session) > 0
      ? value.slice(0, 19).replace('T', ' ')
      : (lang === 'zh' ? '未记录' : 'Not recorded');
  const skillTimestampedInvocationCount = (skill: NonNullable<typeof experience>['skills'][number]): number =>
    skill.timestampedInvocationCount
      ?? (skill.firstSeen === '1970-01-01T00:00:00.000Z' ? 0 : skill.invocationCount);
  const observationMetricRenderers = createObservationMetricRenderers({ experience, reviewState });
  const observationSignalRenderers = createObservationSignalRenderers(lang);
  const {
    evidenceConclusion,
    renderEvidenceCell,
    renderSignalLabel,
    renderSourceBadge,
    semanticEvidence,
  } = observationSignalRenderers;
  const observationSkillChainRenderers = createObservationSkillChainRenderers({
    experienceToolCountsBySkill,
    skillChains,
    skillDerivedStandards,
    metricRenderers: observationMetricRenderers,
  });
  const {
    indicatorLabels,
    indicatorHelps,
    metric,
    formatEntrypoint,
    formatAttributionSource,
    renderInvocationSummary,
    compactRankedCountText,
    renderOpenClawSourceMetadata,
    renderSessionOpenClawSourceMetadata,
    canonicalFeedbackSignalsForDisplay,
    displayIndicatorsForSession,
    sessionMetricSourceTitle,
    displayBasisCodes,
    displayPriority,
    displayAssistiveInference,
    displayRuleFindings,
  } = observationMetricRenderers;
  const {
    renderSkillEvidenceSummary,
    renderSkillChainSummary,
    renderSkillChainButton,
    renderRuntimeRuleFlow,
    renderSkillChainTemplate,
  } = observationSkillChainRenderers;
  const {
    fallbackEvidenceChain,
    renderConfidenceHeader,
    renderPriorityBadge,
    renderAssistiveInference,
    reviewStateKey,
    renderExperienceBasis,
    renderRuleFindings,
    renderEvidenceChain,
    renderReviewRows,
    renderTimelinePair,
  } = createObservationReviewRenderers({
    experience,
    lang,
    observedItemTimestamp,
    reviewState,
    timestampedOccurrences,
    metricRenderers: observationMetricRenderers,
    signalRenderers: observationSignalRenderers,
    skillChainRenderers: observationSkillChainRenderers,
  });
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
    const latestObservation = groupItems
      .filter((item) => timestampedOccurrences(item) > 0)
      .reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
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
        <div class="observe-table-wrap" style="width:100%">
        <table class="observe-fit-table review-bucket-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed">
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
          <div style="color:var(--text-muted);font-size:12px;margin-top:3px">${groupItems.length} 过程发现 · ${sessionCount} sessions · source ${e(sourceKinds.join(', '))} · latest ${e(latest ? latest.slice(0, 19).replace('T', ' ') : '未记录')}</div>
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
    const lastProblemSeen = groupItems
      .filter((item) => timestampedOccurrences(item) > 0)
      .reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
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
      <td class="experience-evidence-cell" style="padding:9px 10px;color:var(--text-secondary);font-size:12px;line-height:1.55">
        ${metric('Bash调用', row.metricCounts.bash, 'bash')} ·
        ${metric('Read', row.metricCounts.read, 'read')} ·
        ${metric('Grep', row.metricCounts.grep, 'grep')}<br>
        ${metric('回答不确定', row.metricCounts.uncertainty, 'hedging')} ·
        ${metric('明确说缺口', row.metricCounts.explicitMarker, 'explicitMarker')} ·
        ${metric('Bash试探', row.metricCounts.bashProbe, 'bashProbe')}<br>
        ${metric('路径不存在', row.metricCounts.notFound, 'notFound')} ·
        ${metric('工具限制', row.metricCounts.toolLimit, 'toolLimit')} ·
        ${metric('工具执行失败', row.metricCounts.toolFailure, 'toolFailure')}
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
        reason = '当前只有文件不存在、权限、文件过大或工具执行失败这类记录。它们更像运行环境或工具限制，默认不作为 skill 修改依据。';
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
      desc: '当前不统计。trace 里的 tool_result 只能说明某次工具执行成功或失败，不能证明用户目标已经完成、答案被接受，或用户没有换 session 继续问。',
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
    return `<div style="width:${width}%;min-width:0;max-width:100%;margin:0 auto;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);position:relative">
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
  const experienceGoalById = new Map((experience?.goalSlices ?? []).map((goal) => [goal.id, goal]));
  const metricGuideSections: Array<{ title: string; keys: IndicatorHelpKey[] }> = [
    { title: '用户交互', keys: ['userCorrection', 'userInterruption', 'userFollowUp', 'negativeFeedback', 'positiveFeedback', 'userGoalShift', 'hardRule'] },
    { title: 'Skill 执行', keys: ['toolCall', 'toolFailure', 'bash', 'read', 'grep'] },
    { title: 'Skill 类型', keys: ['skillRoleRouter', 'skillRoleExecutor', 'skillRoleMixed', 'skillRoleUnknown', 'llmSkillTypeRouter', 'llmSkillTypeDelegation', 'llmSkillTypeExecutor', 'llmSkillTypeAdvisory', 'llmSkillTypeWorkflowOwner', 'llmSkillTypeUnknown'] },
    { title: '过程发现', keys: ['highObservation', 'mediumObservation', 'hedging', 'explicitMarker', 'bashProbe', 'notFound', 'toolLimit'] },
  ];
  const metricGuideHtml = metricGuideSections.map((section) => `
    <section class="metric-guide-section">
      <h3>${e(section.title)}</h3>
      ${section.keys.map((key) => `
        <button type="button" class="metric-guide-item" data-metric-guide-key="${key}" onclick="openMetricGuide('${key}')">
          <strong>${e(indicatorLabels[key])}</strong>
          <span>${e(indicatorHelps[key])}</span>
        </button>
      `).join('')}
    </section>
  `).join('');
  const renderSessionGoals = (goalSliceIds: string[]): string => {
    const goals = goalSliceIds
      .map((id) => experienceGoalById.get(id))
      .filter((goal): goal is NonNullable<ReturnType<typeof experienceGoalById.get>> => Boolean(goal))
      .map((goal) => goal.inferredUserGoal || '未提取到明确用户目标');
    if (goals.length === 0) return '<span style="color:var(--text-muted)">未提取到明确用户目标</span>';
    return `<div class="goal-list">${goals.map((goal, index) => `
      <div class="goal-item">
        <span>目标切片 ${index + 1}/${goals.length}</span>
        <div>${e(goal)}</div>
      </div>
    `).join('')}</div>`;
  };
  const renderReviewerOverview = (session: ExperienceSessionSummary, detailId: string): string => {
    const report = session.reviewerReport;
    const story = session.sessionStory ?? (report ? report.sessionStory ?? fallbackSessionStory(report) : undefined);
    if (!story) return '<span style="color:var(--text-muted);font-size:12px">暂无复盘报告</span>';
    const answerText = story.answers
      .map((answer) => `${answer.label.replace('用户', '')}：${answer.status === 'ok' ? '看起来正常' : answer.status === 'attention' ? '要看一眼' : answer.status === 'degraded' ? '数据有问题' : answer.status === 'not_applicable' ? '不适用' : '信息不够'}`)
      .join('；');
    const mainline = story.mainlineNodeIds
      .map((id) => story.nodes.find((node) => node.id === id)?.label)
      .filter(Boolean)
      .slice(0, 5)
      .join(' → ');
    return `<div class="reviewer-overview-cell">
      <div class="reviewer-overview-title">${e(story.summary)}</div>
      <div class="reviewer-overview-findings">
        ${mainline ? `<span title="${e(mainline)}">主线：${e(mainline)}</span>` : ''}
        ${story.subagentDispatches.length > 0 ? `<span>关键分叉：${story.subagentDispatches.map((dispatch) => dispatch.label).slice(0, 3).map(e).join('、')}</span>` : ''}
        ${answerText ? `<span title="${e(answerText)}">${e(answerText)}</span>` : ''}
      </div>
      ${report ? `<button type="button" data-open-experience-detail onclick="event.stopPropagation(); openExperienceDetailModal('${detailId}', this, 'reviewer')">查看报告详情</button>` : ''}
    </div>`;
  };
  const sanitizeReviewerReportForDisplay = (report?: ExperienceReviewerReport): ExperienceReviewerReport | undefined => {
    if (!report) return undefined;
    return {
      ...report,
      summary: cleanReportCopy(report.summary),
      findings: report.findings.map((finding) => ({ ...finding, body: cleanReportCopy(finding.body) })),
    };
  };
  const experienceSkillRows = (experience?.skills ?? []).map((skill) => {
    // L1 不再展示 priority badge（与左侧"优先复盘/抽样复盘"列冗余）；priority 仍在 L2 / 详情 modal 使用。
    const chainId = `context-chain-${experienceSkillAnchor(skill.skillName)}`;
    const entrypointText = compactRankedCountText(skill.entrypointCounts, { label: formatEntrypoint });
    const originText = compactRankedCountText(experienceSkillOriginCountsBySkill.get(skill.skillName) ?? (
      (skill.pluginNames ?? []).length > 0
        ? Object.fromEntries((skill.pluginNames ?? []).map((plugin) => [`Skill 来源：插件 ${plugin}`, 1]))
        : { 'Skill 来源：本地 skill': skill.invocationCount }
    ));
    const attributionText = compactRankedCountText(experienceAttributionCountsBySkill.get(skill.skillName) ?? (
      Object.keys(skill.attributionCounts ?? {}).length > 0
        ? Object.fromEntries(Object.entries(skill.attributionCounts).map(([key, count]) => [formatAttributionSource(key), count]))
        : {}
    ));
    const sourceMetadataHtml = renderOpenClawSourceMetadata(skill.sourceMetadataCounts);
    const hardRuleSession = (experience?.sessions ?? []).find((session) =>
      session.skillName === skill.skillName && (displayIndicatorsForSession(session).hardRuleTextHitCount ?? 0) > 0
    );
    // 旧版按钮挂的是 onclick="event.stopPropagation()"，
    // 这会阻止冒泡到 document 上的 [data-open-experience-session] 全局监听器，
    // 导致点击没反应。改用 data-no-rollup-click 让外层 rollup row 监听器忽略本元素，
    // 但允许冒泡到 document 把 modal 打开。
    const sampleReviewCta = hardRuleSession
      ? `<button type="button" class="review-inline-cta" data-no-rollup-click="1" data-open-experience-session="${e(hardRuleSession.id)}" data-open-timeline-tag="hard_rule">查看详情</button>`
      : '';
    return `<tr data-observe-rollup-row data-skill-anchor="${e(experienceSkillAnchor(skill.skillName))}" style="cursor:pointer">
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(skill.skillName)}</td>
      <td class="num" title="skill 调用段数：同一个 session 内多次触发同一个 skill，会累计为多次调用段。" style="padding:9px 10px;text-align:right;font-weight:700">${skill.invocationCount}<br><span style="color:var(--text-muted);font-size:10px;font-weight:400">调用段</span></td>
      <td class="num" title="需要优先打开看证据的 session 数" style="padding:9px 6px;text-align:right;color:var(--red);font-weight:650">${skill.reviewFirstSessionCount}</td>
      <td class="num" title="适合抽样确认的 session 数" style="padding:9px 6px;text-align:right;color:var(--yellow);font-weight:650">${skill.sampleReviewSessionCount}${sampleReviewCta ? `<br>${sampleReviewCta}` : ''}</td>
      <td data-no-rollup-click="1" style="padding:9px 10px;text-align:left">${renderSkillChainButton(skill.skillName, chainId)}${renderSkillChainSummary(skill.skillName)}</td>
      <td class="experience-evidence-cell" data-no-rollup-click="1" style="padding:8px 10px;color:var(--text-secondary);font-size:11px;line-height:1.45">
        ${renderSkillEvidenceSummary(skill)}
      </td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:11px;line-height:1.45">
        <div>入口：${e(entrypointText)}</div>
        <div>${e(originText)}</div>
        <div>触发判断：${e(attributionText)}</div>
        ${sourceMetadataHtml}
      </td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px">${e(
        skillTimestampedInvocationCount(skill) > 0
          ? skill.lastSeen.slice(0, 19).replace('T', ' ')
          : '未记录'
      )}</td>
    </tr>
    <tr id="${e(chainId)}" data-context-chain-template style="display:none">
      <td colspan="8">${renderSkillChainTemplate(skill.skillName)}</td>
    </tr>`;
  }).join('');
  const renderExperienceSessionRows = (sessions: ExperienceSessionSummary[], idPrefix: string): string => sessions.map((session, index) => {
    const detailId = `${idPrefix}-session-${index}`;
    const evidenceChain = session.evidenceChain ?? fallbackEvidenceChain(session);
    const indicators = displayIndicatorsForSession(session);
    const shownPriority = displayPriority(indicators);
    const shownRuleFindings = displayRuleFindings(session, indicators);
    const shownInference = displayAssistiveInference(indicators, session.assistiveInference);
    const shownBasisCodes = displayBasisCodes(indicators);
    const pluginNames = session.pluginNames ?? [];
    const commandNames = session.commandNames ?? [];
    const attributionSources = session.attributionSources ?? [];
    const sessionOriginText = pluginNames.length > 0 ? `Skill 来源：插件 ${pluginNames.join('、')}` : 'Skill 来源：本地 skill';
    const sessionAttributionText = commandNames.length > 0
      ? `触发判断：通过斜杠命令触发 ${commandNames.join('、')}`
      : `触发判断：${attributionSources.map(formatAttributionSource).join('、') || '未记录'}`;
    const sessionOpenClawMetadata = renderSessionOpenClawSourceMetadata(session);
    const hasReviewerReport = Boolean(session.reviewerReport);
    return `<tr data-observe-experience-session data-experience-session-id="${e(session.id)}">
      <td style="padding:9px 10px">
        ${renderPriorityBadge(shownPriority)}
        <div style="margin-top:6px">${renderAssistiveInference(shownInference, true)}</div>
      </td>
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-size:12px;color:var(--text-muted);word-break:break-all">${e(session.sessionId)}<br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--accent)">入口：${e(formatEntrypoint(session.entrypoint))}</span><br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(sessionOriginText)}</span><br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(sessionAttributionText)}</span>${sessionOpenClawMetadata ? `<br>${sessionOpenClawMetadata}` : ''}</td>
      <td style="padding:9px 10px">${renderInvocationSummary(indicators, session.invocationIds.length)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${renderSessionGoals(session.goalSliceIds)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${renderReviewerOverview(session, detailId)}</td>
      <td style="padding:9px 10px">${renderRuleFindings(shownRuleFindings, true)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);font-size:12px;line-height:1.55">
        ${metric('纠正', indicators.userCorrectionCount, 'userCorrection', sessionMetricSourceTitle(session, 'user_correction', '纠正'))} ·
        ${metric('人工中断', indicators.userInterruptionCount, 'userInterruption', sessionMetricSourceTitle(session, 'user_interruption', '人工中断'))} ·
        ${metric('追问', indicators.userFollowUpCount, 'userFollowUp', sessionMetricSourceTitle(session, 'user_follow_up', '追问'))} ·
        ${metric('负向反馈', indicators.negativeFeedbackCount ?? 0, 'negativeFeedback', sessionMetricSourceTitle(session, 'negative_feedback', '负向反馈'))} ·
        ${metric('正向反馈', indicators.positiveFeedbackCount ?? 0, 'positiveFeedback', sessionMetricSourceTitle(session, 'positive_feedback', '正向反馈'))} ·
        ${metric('目标切换', indicators.userGoalShiftCount ?? 0, 'userGoalShift', sessionMetricSourceTitle(session, 'user_goal_shift', '目标切换'))}<br>
        ${metric('自我纠正', indicators.selfCorrectionCount ?? 0, 'selfCorrection')} ·
        ${metric('重复执行', indicators.repeatedExecutionCount ?? 0, 'repeatedExecution')} ·
        ${metric('工具执行失败', indicators.toolFailureCount, 'toolFailure')} ·
        ${metric('工具调用取消', indicators.toolCancelledCount ?? 0, 'toolCancelled')} ·
        ${metric('工具状态未知', indicators.toolUnknownCount ?? 0, 'toolUnknown')} ·
        ${metric('高优先级过程发现', indicators.highObservationCount, 'highObservation')}
      </td>
      <td class="session-time-cell" style="padding:9px 10px;color:var(--text-muted);font-size:12px;white-space:normal">
        <div>${e(
          session.sourceSessionStartTimestamp || session.sourceSessionEndTimestamp
            ? formatTimeRange(session.sourceSessionStartTimestamp, session.sourceSessionEndTimestamp, session.sourceSessionDurationMs)
            : observedSessionRange(session)
        )}</div>
        <div style="margin-top:3px;color:var(--text-muted);font-size:11px">${e(invocationWindowLabel)}: ${e(observedSessionRange(session))}</div>
      </td>
      <td class="num" style="padding:9px 10px;text-align:right"><button type="button" data-open-experience-detail onclick="event.stopPropagation(); openExperienceDetailModal('${detailId}', this, 'evidence')" style="font-size:12px;padding:5px 10px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer;white-space:nowrap">证据片段</button></td>
    </tr>
    <tr id="${detailId}" data-experience-detail-template style="display:none;background:var(--bg-muted)">
      <td colspan="9" style="padding:0;border-bottom:1px solid var(--border);text-align:left">
        <div class="experience-detail-shell">
        <div class="experience-detail-tabs" role="tablist" aria-label="Session 回溯视图">
          ${hasReviewerReport ? '<button type="button" class="experience-detail-tab-button is-active" role="tab" aria-selected="true" data-experience-detail-tab="reviewer" onclick="switchExperienceDetailTab(\'reviewer\')">复盘报告</button>' : ''}
          <button type="button" class="experience-detail-tab-button ${hasReviewerReport ? '' : 'is-active'}" role="tab" aria-selected="${hasReviewerReport ? 'false' : 'true'}" data-experience-detail-tab="evidence" onclick="switchExperienceDetailTab('evidence')">证据片段</button>
        </div>
        ${hasReviewerReport ? `<section class="experience-detail-tab-panel experience-detail-report-panel is-active" role="tabpanel" data-experience-detail-panel="reviewer">
          ${renderReviewerReport(session.reviewerReport)}
        </section>` : ''}
        <section class="experience-detail-tab-panel experience-detail-evidence-panel ${hasReviewerReport ? '' : 'is-active'}" role="tabpanel" data-experience-detail-panel="evidence">
        <div class="experience-detail-grid" style="display:grid;grid-template-columns:minmax(0,.6fr) minmax(0,1.4fr);gap:16px;align-items:stretch">
          <section class="experience-detail-left">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">证据链（C1）</h3>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">这块说明本次复盘用了哪些原始上下文：人工用户消息、Skill 注入、工具调用、工具执行结果和过程发现。它只回答“证据从哪里来”。</div>
            ${renderEvidenceChain(evidenceChain)}
            <h3 style="font-size:13px;margin:14px 0 8px;color:var(--text-primary)">规则命中（C2）</h3>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">这块把可数的规则信号列出来，例如用户纠正、人工中断、工具执行失败、用户硬性要求。它不包含 LLM 语义评分，也不自动判断 skill 最终好坏。</div>
            ${renderRuleFindings(shownRuleFindings)}
            <h3 style="font-size:13px;margin:14px 0 8px;color:var(--text-primary)">复盘建议（C3，无 LLM）</h3>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">这块只根据固定规则给“是否值得先看”的建议，例如优先复盘、抽样确认、上下文不足。它不是“符合预期/不符合预期”的最终结论。</div>
            ${renderAssistiveInference(shownInference)}
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.55">
              <div>调用摘要：调用段 ${session.invocationIds.length} · 工具调用 ${indicators.toolCallCount} · 工具执行失败 ${indicators.toolFailureCount}${(indicators.toolCancelledCount ?? 0) > 0 ? ` · 工具调用取消 ${indicators.toolCancelledCount ?? 0}` : ''} · 人工中断 ${indicators.userInterruptionCount}</div>
              <div>复盘分数：${session.reviewPriorityScore}</div>
              <div>关联 invocation：${session.invocationIds.length}</div>
              <div>关联过程发现：${session.relatedObservationIds.length}</div>
              <div style="margin-top:8px">${renderExperienceBasis(shownBasisCodes)}</div>
            </div>
            ${renderJson({ id: session.id, sourceTrace: session.sourceTrace, sourceMetadata: session.sourceMetadata, cwd: session.cwd, sourceSessionStartTimestamp: session.sourceSessionStartTimestamp, sourceSessionEndTimestamp: session.sourceSessionEndTimestamp, sourceSessionDurationMs: session.sourceSessionDurationMs, invocationStartTimestamp: session.startTimestamp, invocationEndTimestamp: session.endTimestamp, sessionStory: session.sessionStory, evidenceChain, ruleFindings: shownRuleFindings, assistiveInference: shownInference, reviewerReport: sanitizeReviewerReportForDisplay(session.reviewerReport), reviewState: reviewState.entries[reviewStateKey('experience_session', session.id)], indicators, relatedObservationIds: session.relatedObservationIds })}
          </section>
          <section class="experience-detail-right">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">C1 上下文时间线片段</h3>
            ${renderTimelinePair(session)}
          </section>
        </div>
        </section>
        </div>
      </td>
    </tr>`;
  }).join('');
  void experienceSkillRows;
  // resolvedReviewSessions 在 ViewModel build 阶段已经按 session.id 预投影。
  // 这里只做查表,避免 render path 上对同一 session 反复 resolve。
  const inboxResolvedSession = (skill: ExperienceSessionSummary): ResolvedObservationReviewSession =>
    resolvedReviewSessions[skill.id];
  const inboxResolvedPriority = (skill: ExperienceSessionSummary): ExperienceReviewPriority =>
    resolvedReviewSessions[skill.id].priority;
  const sessionSkillOrder = new Map((experience?.skills ?? []).map((skill, index) => [skill.skillName, index]));
  const experienceSessionGroups = Array.from((experience?.sessions ?? []).reduce((map, session) => {
    const group = map.get(session.skillName) ?? [];
    group.push(session);
    map.set(session.skillName, group);
    return map;
  }, new Map<string, ExperienceSessionSummary[]>()).entries())
    .sort((a, b) => (sessionSkillOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (sessionSkillOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER));
  const experienceSessionGroupsHtml = experienceSessionGroups.map(([skillName, sessions], groupIndex) => {
    const timestampedSessions = sessions.filter((session) => sessionTimestampedInvocationCount(session) > 0);
    const latest = timestampedSessions.reduce(
      (max, session) => session.endTimestamp > max ? session.endTimestamp : max,
      '',
    );
    const earliestSessionStart = sessions.reduce((min, session) => {
      const value = session.sourceSessionStartTimestamp
        ?? (sessionTimestampedInvocationCount(session) > 0 ? session.startTimestamp : '');
      return value && value < min ? value : min;
    }, '');
    const latestSessionEnd = sessions.reduce((max, session) => {
      const value = session.sourceSessionEndTimestamp
        ?? (sessionTimestampedInvocationCount(session) > 0 ? session.endTimestamp : '');
      return value && value > max ? value : max;
    }, '');
    const reviewFirst = sessions.filter((session) => inboxResolvedPriority(session) === 'review_first').length;
    const sampleReview = sessions.filter((session) => inboxResolvedPriority(session) === 'sample_review').length;
    return `<details id="${e(experienceSkillAnchor(skillName))}" class="experience-session-group" open style="scroll-margin-top:16px">
      <summary>
        <div>
          <span class="experience-session-skill">${e(skillName)}</span>
          <span class="experience-session-meta">${sessions.length} sessions · ${e(sessionTimeLabel)} ${e(
            earliestSessionStart || latestSessionEnd
              ? formatTimeRange(earliestSessionStart, latestSessionEnd)
              : (lang === 'zh' ? '未记录' : 'Not recorded')
          )} · ${e(latestInvocationLabel)} ${e(latest ? formatTimestamp(latest) : (lang === 'zh' ? '未记录' : 'Not recorded'))}</span>
        </div>
        <div class="experience-session-tags">
          <span style="color:var(--red)">优先复盘 ${reviewFirst}</span>
          <span style="color:var(--yellow)">抽样复盘 ${sampleReview}</span>
        </div>
      </summary>
      <div class="observe-table-wrap" style="width:100%;border-top:1px solid var(--border)">
        <table class="observe-fit-table experience-session-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
          <colgroup>
            <col><col><col><col><col><col><col><col>
          </colgroup>
          <thead><tr>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">复盘优先级</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Session</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">调用摘要</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">用户目标切片</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">报告总览</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">C2 规则判断</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">关键指标</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">${e(sessionTimeRangeLabel)}</th>
            <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">回溯</th>
          </tr></thead>
          <tbody>${renderExperienceSessionRows(sessions, `exp-skill-${groupIndex}`)}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');
  void experienceSessionGroupsHtml;
  const experienceReviewSkillCount = experience?.skills.filter((skill) => skill.reviewFirstSessionCount + skill.sampleReviewSessionCount > 0).length ?? 0;
  void experienceReviewSkillCount;
  const experienceReviewSessionCount = experience?.sessions.filter((session) => inboxResolvedPriority(session) !== 'routine_sample').length ?? 0;
  void experienceReviewSessionCount;
  const experienceReviewFirstSessionCount = experience?.sessions.filter((session) => inboxResolvedPriority(session) === 'review_first').length ?? 0;
  const experienceSampleReviewSessionCount = experience?.sessions.filter((session) => inboxResolvedPriority(session) === 'sample_review').length ?? 0;
  const experienceHardRuleCount = experience?.sessions.reduce((sum, session) =>
    sum + (displayIndicatorsForSession(session).hardRuleTextHitCount ?? 0), 0
  ) ?? 0;
  const experienceFirstHardRuleSession = experience?.sessions.find((session) =>
    (displayIndicatorsForSession(session).hardRuleTextHitCount ?? 0) > 0
  );
  const experienceFirstReviewSession = experienceFirstHardRuleSession
    ?? experience?.sessions.find((session) => displayPriority(displayIndicatorsForSession(session)) !== 'routine_sample');
  const experienceInsightText = experienceReviewFirstSessionCount > 0
    ? `这次 trace 有 ${experienceReviewFirstSessionCount} 个优先复盘 session，建议先看异常证据。`
    : experienceHardRuleCount > 0
      ? `这次 trace 整体未发现明显高风险异常，但有 ${experienceHardRuleCount} 条用户硬性要求值得抽样确认。`
      : experienceSampleReviewSessionCount > 0
        ? `这次 trace 整体未发现明显高风险异常，有 ${experienceSampleReviewSessionCount} 个 session 建议抽样确认。`
        : '这次 trace 未发现明显高风险异常，可以常规抽样。';
  const experienceInsightCta = experienceFirstReviewSession
    ? `<button type="button" class="experience-insight-cta" data-open-experience-session="${e(experienceFirstReviewSession.id)}" data-open-timeline-tag="${experienceFirstHardRuleSession ? 'hard_rule' : ''}">${experienceFirstHardRuleSession ? '看这条用户硬性要求是什么' : '打开建议复盘 session'}</button>`
    : '';
  const reportSessionRanges = reports.flatMap((report) => report.meta.sessionTimeRanges ?? []);
  const reportSessionCount = reportSessionRanges.length > 0
    ? new Set(reportSessionRanges.map((range) => `${range.sessionId}\u0000${range.sourceTrace}`)).size
    : (experience?.meta.sessionCount ?? 0);
  const reportSessionStarts = reportSessionRanges.map((range) => range.startTimestamp).filter((value): value is string => Boolean(value));
  const reportSessionEnds = reportSessionRanges.map((range) => range.endTimestamp).filter((value): value is string => Boolean(value));
  const reportSessionFrom = reportSessionStarts.length > 0 ? reportSessionStarts.reduce((min, value) => value < min ? value : min, reportSessionStarts[0]) : undefined;
  const reportSessionTo = reportSessionEnds.length > 0 ? reportSessionEnds.reduce((max, value) => value > max ? value : max, reportSessionEnds[0]) : undefined;
  const reportSessionDurationMs = durationMsBetween(reportSessionFrom, reportSessionTo);
  const reportSessionRangeLabel = reportSessionFrom || reportSessionTo
    ? formatTimeRange(reportSessionFrom, reportSessionTo, reportSessionDurationMs)
    : '—';
  const experienceTopInsightHtml = experience
    ? `<div class="experience-top-insight">
        <div>
          <strong>复盘建议</strong>
          <span>${e(experienceInsightText)}</span>
        </div>
        ${experienceInsightCta}
      </div>`
    : '';
  void experienceTopInsightHtml;
	  const inboxSessions = (experience?.sessions ?? []).slice();
	  const inboxSiblingsMap = new Map<string, ExperienceSessionSummary[]>();
	  for (const skill of inboxSessions) {
	    const arr = inboxSiblingsMap.get(skill.sessionId) ?? [];
	    arr.push(skill);
	    inboxSiblingsMap.set(skill.sessionId, arr);
	  }
	  for (const arr of inboxSiblingsMap.values()) {
	    arr.sort((a, b) =>
        Number(sessionTimestampedInvocationCount(b) > 0) - Number(sessionTimestampedInvocationCount(a) > 0)
        || a.startTimestamp.localeCompare(b.startTimestamp)
      );
	  }
	  type InboxSkillCard = {
	    skillName: string;
	    sessions: ExperienceSessionSummary[];
	    priority: ExperienceReviewPriority;
	    latestEnd: string;
	  };
	  const inboxSkillsMap = new Map<string, ExperienceSessionSummary[]>();
	  for (const s of inboxSessions) {
	    const arr = inboxSkillsMap.get(s.skillName) ?? [];
	    arr.push(s);
	    inboxSkillsMap.set(s.skillName, arr);
	  }
	  const inboxPriorityRank = (priority: ExperienceReviewPriority): number => priority === 'review_first' ? 0 : priority === 'sample_review' ? 1 : 2;
	  const inboxSkillCards: InboxSkillCard[] = Array.from(inboxSkillsMap.entries()).map(([skillName, sessions]) => {
	    sessions.sort((a, b) =>
        Number(sessionTimestampedInvocationCount(b) > 0) - Number(sessionTimestampedInvocationCount(a) > 0)
        || b.endTimestamp.localeCompare(a.endTimestamp)
      );
	    const priority = sessions.find((s) => inboxResolvedPriority(s) === 'review_first')
	      ? 'review_first'
	      : sessions.find((s) => inboxResolvedPriority(s) === 'sample_review')
	        ? 'sample_review'
	        : 'routine_sample';
	    const latestEnd = sessions
        .filter((session) => sessionTimestampedInvocationCount(session) > 0)
        .reduce((latest, s) => s.endTimestamp > latest ? s.endTimestamp : latest, '');
	    return { skillName, sessions, priority, latestEnd };
	  });
	  inboxSkillCards.sort((a, b) => inboxPriorityRank(a.priority) - inboxPriorityRank(b.priority) || b.latestEnd.localeCompare(a.latestEnd) || a.skillName.localeCompare(b.skillName));
	  const inboxSkillCardReviewed = (card: InboxSkillCard): boolean =>
	    card.sessions.every((s) => Boolean(reviewState.entries[`experience_session:${s.id}`]));
	  const inboxReviewFirstCount = inboxSkillCards.filter((c) => c.priority === 'review_first').length;
	  const inboxSampleCount = inboxSkillCards.filter((c) => c.priority === 'sample_review').length;
	  const inboxReviewedCount = inboxSkillCards.filter(inboxSkillCardReviewed).length;
	  const inboxTotalCount = inboxSkillCards.length;
	  const inboxFormatDuration = (ms?: number): string => {
	    if (!ms || ms <= 0) return '—';
	    const totalSec = Math.round(ms / 1000);
	    if (totalSec < 60) return `${totalSec} 秒`;
	    const min = Math.floor(totalSec / 60);
	    const sec = totalSec % 60;
	    if (min < 60) return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分钟`;
	    const hour = Math.floor(min / 60);
	    return `${hour} 小时 ${min % 60} 分`;
	  };
	  const inboxTopSession = (card: InboxSkillCard): ExperienceSessionSummary | undefined =>
	    card.sessions.find((s) => inboxResolvedPriority(s) === 'review_first')
	    ?? card.sessions.find((s) => inboxResolvedPriority(s) === 'sample_review')
	    ?? card.sessions[0];
	  const inboxSkillGoalLine = (card: InboxSkillCard): string => {
	    const storyGoal = card.sessions.flatMap((s) => s.sessionStory?.goalSlices ?? [])
	      .find((goal) => inboxCleanSnippet(goal.inferredUserGoal));
	    const directGoal = card.sessions.find((s) => inboxCleanSnippet(s.evidenceChain.firstUserMessage?.snippet))?.evidenceChain.firstUserMessage?.snippet;
	    const llmGoal = inboxLlmEnhancedGoalKeywords(card.skillName);
	    const goal = inboxExtractKeyword(storyGoal?.inferredUserGoal ?? directGoal ?? llmGoal, 48);
	    return goal ? `用户目标：${goal}` : '用户目标：未提取';
	  };
	  const inboxSkillMainline = (card: InboxSkillCard): string => {
	    const story = card.sessions.find((s) => s.sessionStory?.skillLinks?.length)?.sessionStory;
	    const links = story?.skillLinks ?? card.sessions.map((s) => ({
	      skillName: s.skillName,
	      role: 'executor' as const,
	    }));
	    const currentLink = links.find((link) => link.skillName === card.skillName);
	    const roleText = currentLink ? inboxSkillRoleLabel(currentLink.role) : '执行';
	    const chain = links
	      .slice(0, 5)
	      .map((link) => `${link.skillName}〔${inboxSkillRoleLabel(link.role)}〕`)
	      .join(' → ');
	    const delivery = story?.finalDeliverySignalCount && story.finalDeliverySignalCount > 0 ? ' → 有结果' : '';
	    return chain ? `${card.skillName}〔${roleText}〕 · 主线：用户目标 → ${chain}${delivery}` : `${card.skillName}〔${roleText}〕 · 未提取到明确执行主线`;
	  };
	  const inboxCardStatus = (card: InboxSkillCard): string => {
	    // 多 session 聚合: 取 goal_satisfaction 中最严重的 status
	    // 优先级: degraded > attention > unknown > ok / not_applicable
	    const goalStatuses = card.sessions
	      .map((s) => s.sessionStory?.answers?.find((a) => a.key === 'goal_satisfaction')?.status)
	      .filter((status): status is ExperienceSessionStoryAnswer['status'] => Boolean(status));
	    if (goalStatuses.includes('degraded')) return '数据有问题';
	    if (goalStatuses.includes('attention')) return '要看一眼';
	    if (goalStatuses.includes('unknown')) return '信息不够';
	    // 全 ok 或 not_applicable: 不输出文案
	    return '';
	  };
	  const inboxAttentionFindingLabelByRuleSource: Record<string, string> = {
	    final_delivery_absent: '没给最终答复',
	    router_user_facing_closure_absent: '下游结果未回传',
	    tool_error_recovery: '工具调用失败',
	    tool_failure_seen: '工具调用失败',
	    session_interrupted: '会话异常断开',
	    session_interrupted_seen: '会话异常断开',
	    expected_tools_missed: '没用上核心工具',
	    user_correction: '用户纠正',
	    user_correction_seen: '用户纠正',
	    user_interruption: '用户手动叫停',
	    user_interruption_seen: '用户手动叫停',
	    negative_feedback: '用户不满',
	    negative_feedback_seen: '用户不满',
	    complex_scope_degraded: '复杂链路',
	  };
	  const inboxAttentionFindingLabel = (ruleSource: string): string =>
	    inboxAttentionFindingLabelByRuleSource[ruleSource] ?? ruleSource;
	  const inboxSessionAttentionFindingLabels = (session: ExperienceSessionSummary): string[] => {
	    const labels: string[] = [];
	    const push = (label: string): void => {
	      if (label && !labels.includes(label)) labels.push(label);
	    };
	    for (const finding of session.reviewerReport?.findings ?? []) {
	      if (finding.level !== 'attention') continue;
	      push(inboxAttentionFindingLabel(finding.ruleSource));
	    }
	    const indicators = displayIndicatorsForSession(session);
	    if (indicators.toolFailureCount > 0) push(inboxAttentionFindingLabel('tool_error_recovery'));
	    if (indicators.userCorrectionCount > 0) push(inboxAttentionFindingLabel('user_correction'));
	    if (indicators.userInterruptionCount > 0) push(inboxAttentionFindingLabel('user_interruption'));
	    if (indicators.sessionInterruptedCount > 0) push(inboxAttentionFindingLabel('session_interrupted'));
	    if (indicators.negativeFeedbackCount > 0) push(inboxAttentionFindingLabel('negative_feedback'));
	    return labels;
	  };
	  const inboxFindingChips = (card: InboxSkillCard): string => {
	    const totalSessions = card.sessions.length;
	    // 多 session 聚合: 按 ruleSource 统计「N/M session 命中」, chip 文案用中性短标签
	    const byRule = new Map<string, { hit: number; body: string }>();
	    for (const session of card.sessions) {
	      const seenInSession = new Set<string>();
	      for (const finding of session.reviewerReport?.findings ?? []) {
	        if (finding.level !== 'attention') continue;
	        if (seenInSession.has(finding.ruleSource)) continue;
	        seenInSession.add(finding.ruleSource);
	        const entry = byRule.get(finding.ruleSource);
	        if (entry) entry.hit += 1;
	        else byRule.set(finding.ruleSource, { hit: 1, body: finding.body });
	      }
	    }
	    if (byRule.size === 0) return '';
	    const sorted = [...byRule.entries()].sort((a, b) => b[1].hit - a[1].hit).slice(0, 3);
	    return `<div class="inbox-card-chips">${sorted.map(([ruleSource, { hit, body }]) => {
	      const label = inboxAttentionFindingLabel(ruleSource);
	      return `<span class="inbox-card-chip is-attention" title="${e(body)}">${hit}/${totalSessions} · ${e(label)}</span>`;
	    }).join('')}</div>`;
	  };
	  const inboxReviewBadge = (card: InboxSkillCard): string => {
	    const verdicts: string[] = [];
	    for (const s of card.sessions) {
	      const v = reviewState.entries[`experience_session:${s.id}`]?.verdict;
	      if (v) verdicts.push(v);
	    }
	    if (verdicts.length === 0) return '';
	    const total = card.sessions.length;
	    if (verdicts.length < total) return `<span class="inbox-card-state is-reviewed">已标注 ${verdicts.length}/${total}</span>`;
	    if (verdicts.every((v) => v === 'real_issue')) return `<span class="inbox-card-state is-agree">已同意</span>`;
	    if (verdicts.every((v) => v === 'not_issue')) return `<span class="inbox-card-state is-reject">已否决</span>`;
	    if (verdicts.every((v) => v === 'needs_more_context')) return `<span class="inbox-card-state is-note">留意见</span>`;
	    return `<span class="inbox-card-state is-reviewed">已处理</span>`;
	  };
	  const inboxPriorityClass = (card: InboxSkillCard): string => {
	    if (card.priority === 'review_first') return 'is-priority-high';
	    if (card.priority === 'sample_review') return 'is-priority-medium';
	    return 'is-priority-low';
	  };
	  const inboxEntrypointShort = (session: ExperienceSessionSummary): string => formatEntrypoint(session.entrypoint) || '未记录';
	  const inboxFormatSessionLabel = (session: ExperienceSessionSummary): string => {
	    const time = sessionTimestampedInvocationCount(session) > 0
        ? observedSessionTimestamp(session, session.endTimestamp).slice(0, 16)
        : '';
	    const entrypoint = inboxEntrypointShort(session);
	    const sessionShort = session.sessionId.length > 10 ? `${session.sessionId.slice(0, 8)}…` : session.sessionId;
	    return [`Session ${sessionShort}`, entrypoint !== '未记录' ? entrypoint : '', time].filter(Boolean).join(' · ') || 'Session 调用记录';
	  };
	  const inboxSessionSearchText = (session: ExperienceSessionSummary): string => [
	    session.id,
	    session.sessionId,
	    session.skillName,
	    session.sourceTrace,
	    session.sourceKind,
	    session.entrypoint,
	    session.cwd,
	    session.startTimestamp,
	    session.endTimestamp,
	    session.sourceSessionStartTimestamp,
	    session.sourceSessionEndTimestamp,
	    session.evidenceChain.firstUserMessage?.snippet,
	    session.reviewerReport?.title,
	    session.sessionStory?.summary,
	    ...(session.sessionStory?.goalSlices ?? []).map((goal) => goal.inferredUserGoal ?? ''),
	  ].filter(Boolean).join(' ');
	  const inboxCard = (card: InboxSkillCard, index: number): string => {
	    const filters: string[] = [card.priority, 'all'];
	    if (inboxSkillCardReviewed(card)) filters.push('reviewed');
	    const topSession = inboxTopSession(card);
	    const duration = inboxFormatDuration(topSession?.sourceSessionDurationMs);
	    const entrypoint = topSession ? inboxEntrypointShort(topSession) : '未记录';
	    const sessionCountChip = card.sessions.length > 1 ? `<span title="${card.skillName} 有 ${card.sessions.length} 次调用记录">${card.sessions.length} 次调用</span>` : '';
	    const goalLine = inboxSkillGoalLine(card);
	    const mainline = inboxSkillMainline(card);
	    const skillSearchText = [card.skillName, goalLine, mainline, inboxCardStatus(card)].join(' ');
	    const sessionSearchText = card.sessions.map(inboxSessionSearchText).join(' ');
	    return `<li class="inbox-card ${inboxPriorityClass(card)} ${index === 0 ? 'is-active' : ''}" data-inbox-card="${e(card.skillName)}" data-inbox-filters="${e(filters.join(' '))}" data-inbox-skill-search="${e(skillSearchText)}" data-inbox-session-search="${e(sessionSearchText)}" onclick="selectInboxCard('${e(card.skillName)}', this)">
	      <div class="inbox-card-row inbox-card-row-title">
	        <span class="inbox-card-priority"></span>
	        <span class="inbox-card-title" title="${e(card.skillName)}">${e(card.skillName)}</span>
	        ${inboxReviewBadge(card)}
	      </div>
	      <div class="inbox-card-goal" title="${e(goalLine)}">${e(goalLine)}</div>
	      <div class="inbox-card-story" title="${e(mainline)}">${e(mainline)}</div>
	      ${inboxFindingChips(card)}
	      <div class="inbox-card-row inbox-card-meta">
	        <span title="这条 session 的执行时长">执行 ${e(duration)}</span>
	        <span title="入口来源">入口 ${e(entrypoint)}</span>
	        ${sessionCountChip}
	      </div>
	    </li>`;
	  };
	  const inboxStatusBadge = (status: ExperienceSessionStoryAnswer['status']): string => {
	    if (status === 'degraded') return '<span class="inbox-answer-status is-degraded">数据有问题</span>';
	    if (status === 'attention') return '<span class="inbox-answer-status is-attention">要看一眼</span>';
	    if (status === 'unknown') return '<span class="inbox-answer-status is-unknown">信息不够</span>';
	    if (status === 'not_applicable') return '<span class="inbox-answer-status is-not-applicable">不适用</span>';
	    return '<span class="inbox-answer-status is-ok">看起来正常</span>';
	  };
	  const inboxSkillRoleLabel = (role: 'router' | 'executor' | 'mixed' | 'unknown'): string => {
	    if (role === 'router') return '路由';
	    if (role === 'executor') return '执行';
	    if (role === 'mixed') return '路由+执行';
	    return '未确定';
	  };
	  const inboxLlmSkillTypeLabel = (type?: ResolvedObservationReviewSession['skillType']): string => {
	    if (type === 'router') return '路由型';
	    if (type === 'delegation') return '委派型';
	    if (type === 'executor') return '执行型';
	    if (type === 'advisory') return '咨询型';
	    if (type === 'workflow_owner') return '流程负责型';
	    return '类型待确认';
	  };
    const inboxSkillTypeSourceText = (resolved: ResolvedObservationReviewSession): string => {
      if (resolved.skillTypeSource === 'frontmatter') return '作者声明';
      if (resolved.skillTypeSource === 'llm') return '模型识别';
      if (resolved.skillTypeSource === 'trace') return '规则推断';
      return '建议声明';
    };
	  const inboxSkillRoleHelpKey = (role: 'router' | 'executor' | 'mixed' | 'unknown'): IndicatorHelpKey => {
	    if (role === 'router') return 'skillRoleRouter';
	    if (role === 'executor') return 'skillRoleExecutor';
	    if (role === 'mixed') return 'skillRoleMixed';
	    return 'skillRoleUnknown';
	  };
	  const inboxLlmSkillTypeHelpKey = (type?: ResolvedObservationReviewSession['skillType']): IndicatorHelpKey => {
	    if (type === 'router') return 'llmSkillTypeRouter';
	    if (type === 'delegation') return 'llmSkillTypeDelegation';
	    if (type === 'executor') return 'llmSkillTypeExecutor';
	    if (type === 'advisory') return 'llmSkillTypeAdvisory';
	    if (type === 'workflow_owner') return 'llmSkillTypeWorkflowOwner';
	    return 'llmSkillTypeUnknown';
	  };
	  const inboxSkillTypeBadge = (label: string, helpKey: IndicatorHelpKey, sourceText?: string): string =>
	    `<button type="button" class="inbox-skill-type-badge" data-metric-key="${helpKey}" onclick="event.stopPropagation();openMetricGuide('${helpKey}')" title="点击查看 skill 类型说明">skill 类型：${e(label)}${sourceText ? ` · ${e(sourceText)}` : ''}</button>`;
	  const inboxFlowItem = (cardSkillName: string, skill: ExperienceSessionSummary, index: number, isCurrent: boolean): string => {
	    const link = skill.sessionStory?.skillLinks?.find((l) => l.skillName === skill.skillName);
	    const roleLabel = link ? inboxSkillRoleLabel(link.role) : '执行';
	    const roleHelpKey = inboxSkillRoleHelpKey(link?.role ?? 'executor');
	    const indicators = displayIndicatorsForSession(skill);
	    const dur = observedSessionRange(skill);
	    const startTime = sessionTimestampedInvocationCount(skill) > 0
        ? skill.startTimestamp.slice(5, 16).replace('T', ' ')
        : '未记录';
	    const resolvedPriority = inboxResolvedPriority(skill);
	    const priorityLabel = resolvedPriority === 'review_first' ? '要看一眼' : resolvedPriority === 'sample_review' ? '抽样' : '常规';
	    const priorityCls = resolvedPriority === 'review_first' ? 'is-priority-high' : resolvedPriority === 'sample_review' ? 'is-priority-medium' : 'is-priority-low';
	    const currentCls = isCurrent ? 'is-current' : '';
	    const tag = isCurrent ? '<span class="inbox-flow-current-tag">当前查看</span>' : '';
	    const sameSkill = skill.skillName === cardSkillName;
	    const jumpAction = sameSkill
	      ? `selectInboxSessionTab('${e(cardSkillName)}', '${e(skill.id)}')`
	      : `selectInboxCardById('${e(skill.skillName)}', '${e(skill.id)}')`;
	    const jumpAttrs = isCurrent ? '' : ` data-inbox-jump-card="${e(sameSkill ? skill.id : skill.skillName)}"`;
	    return `<li class="inbox-flow-item ${priorityCls} ${currentCls}">
	      <div class="inbox-flow-time">${e(startTime)}</div>
	      <div class="inbox-flow-rail"><span class="inbox-flow-index">${index + 1}</span></div>
	      <div class="inbox-flow-anchor"${jumpAttrs}${!isCurrent ? ` onclick="${jumpAction}"` : ''} role="button" title="${isCurrent ? '当前查看的调用段' : '点击切换到这个调用段'}">
	        <div class="inbox-flow-body">
	          <div class="inbox-flow-title"><strong>${e(skill.skillName)}</strong>${inboxSkillTypeBadge(roleLabel, roleHelpKey)}<span class="inbox-flow-priority">${priorityLabel}</span>${tag}</div>
	          <div class="inbox-flow-meta">
	            <span>调用段 ${skill.invocationIds.length}</span>
	            <span>工具 ${indicators.toolCallCount}</span>
	            <span>失败 ${indicators.toolFailureCount}</span>
	            ${(indicators.toolCancelledCount ?? 0) > 0 ? `<span>取消 ${indicators.toolCancelledCount ?? 0}</span>` : ''}
	            ${(indicators.toolUnknownCount ?? 0) > 0 ? `<span>状态未知 ${indicators.toolUnknownCount ?? 0}</span>` : ''}
	          </div>
	          <div class="inbox-flow-range">${e(dur)}</div>
	        </div>
	      </div>
	    </li>`;
	  };
	  const inboxRenderSessionFlow = (cardSkillName: string, session: ExperienceSessionSummary, siblings: ExperienceSessionSummary[], summaryText: string): string => {
	    const goalSlices = session.sessionStory?.goalSlices ?? [];
	    const dispatches = session.sessionStory?.subagentDispatches ?? [];
	    const siblingHint = siblings.length > 1 ? `<span class="inbox-section-hint">本 session 共 ${siblings.length} 个能力调用段，下面高亮当前 ${e(session.skillName)}</span>` : '<span class="inbox-section-hint">这条 session 只触发了当前能力</span>';
	    return `<div class="inbox-flow-popover-content">
	      <header class="inbox-flow-popover-head">
	        <strong>Session 执行过程</strong>
	        <span class="inbox-section-summary is-neutral">${e(summaryText)}</span>
	        ${siblingHint}
	      </header>
	      <div class="inbox-flow-popover-body">
	        <ol class="inbox-flow-list inbox-flow-timeline">${siblings.map((sib, index) => inboxFlowItem(cardSkillName, sib, index, sib.id === session.id)).join('')}</ol>
	        ${goalSlices.length > 0 ? `<div class="inbox-flow-slices"><h4>用户目标段</h4>${goalSlices.map((goal) => `<div class="inbox-flow-slice"><strong>目标段 ${goal.order}</strong><span>${e(goal.skillNames.join('、') || '未记录能力')}</span><p>${e(goal.inferredUserGoal ?? (inboxLlmEnhancedGoalKeywords(goal.skillNames[0] ?? session.skillName) || '未提取到明确用户目标'))}</p></div>`).join('')}</div>` : ''}
	        ${dispatches.length > 0 ? `<div class="inbox-flow-dispatches"><h4>子任务分支</h4>${dispatches.map((d) => `<div class="inbox-flow-dispatch"><strong>分支 ${d.order}：${e(d.label)}</strong><span>${d.eventCount} 条事件${d.attachTo?.messageIndex !== undefined ? ` · 挂接 #${d.attachTo.messageIndex}` : ''}</span></div>`).join('')}</div>` : ''}
	      </div>
	    </div>`;
	  };
	  const inboxAnswerEvidenceButtons = (refs: ExperienceEvidenceRef[]): string => {
	    if (!refs || refs.length === 0) return '';
	    const ref = refs[0];
	    const kindLabel = ({
	      user_message: '用户消息',
	      assistant_message: '助手回复',
	      tool_use: '工具调用',
	      tool_result: '工具结果',
	      skill_context: '能力说明',
	      runtime_context: '运行注入',
	      observation: '过程发现',
	    } as Record<string, string>)[ref.kind] ?? ref.kind;
	    return `<div class="inbox-answer-evidence"><button type="button" class="inbox-answer-evidence-link" data-jump-message-index="${ref.messageIndex ?? ''}" data-jump-message-uuid="${e(ref.messageUuid ?? '')}" onclick="inboxJumpToEvidence(this)" title="定位到消息 #${e(String(ref.messageIndex ?? '-'))} · ${e(kindLabel)}">跳转原文</button></div>`;
	  };
	  const inboxPlaceholderRe = /^\s*(?:NO_REPLY(?:_NEEDED)?|END_OF_REPLY|::FORWARD-?OK::|NO_OP|NULL|UNDEFINED|\.\.\.|—|--)\s*$/i;
	  const inboxCronPromptRe = /^\s*\[cron:[^\]]+\]\s*/i;
	  const inboxCleanSnippet = (text?: string): string => {
	    if (!text) return '';
	    let cleaned = text.replace(/\s+/g, ' ').trim();
	    cleaned = cleaned.replace(inboxCronPromptRe, '');
	    if (inboxPlaceholderRe.test(cleaned)) return '';
	    return cleaned;
	  };
	  const inboxExtractKeyword = (text?: string, max = 36): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    if (cleaned.length <= max) return cleaned;
	    return `${cleaned.slice(0, max)}…`;
	  };
	  const inboxExtractGoalKeywords = (text?: string): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    const withoutTags = cleaned
	      .replace(/<command-name>([^<]+)<\/command-name>/gi, ' $1 ')
	      .replace(/<[^>]+>/g, ' ')
	      .replace(/[“”"']/g, ' ')
	      .replace(/\s+/g, ' ')
	      .trim();
	    const candidates: string[] = [];
	    const push = (value?: string): void => {
	      const normalized = (value ?? '').replace(/^[\s:：/]+|[\s:：/。！？,，；;]+$/g, '').trim();
	      if (!normalized || normalized.length < 2) return;
	      if (['这个', '这里', '内容', '当前', '现在', '一下', '能力', '文档', '代码', '需求'].includes(normalized)) return;
	      if (!candidates.includes(normalized)) candidates.push(normalized);
	    };
	    const generationTarget = withoutTags.match(/(?:重新|再次|继续)?\s*(?:生成|创建|写|产出|实现|做|搭建)\s*([A-Za-z0-9_-]*demo|DEMO|Demo|[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}(?:页面|报告|文档|方案|代码|原型|Demo|demo))/i);
	    if (generationTarget) {
	      const target = generationTarget[1].replace(/^一个|^一份|^这个/, '').trim();
	      push(/demo/i.test(target) ? 'Demo生成' : `${target}生成`);
	    }
	    if (/prd|产品需求文档/i.test(withoutTags)) {
	      push(/生成|创建|写|产出|create/i.test(withoutTags) ? 'PRD生成' : 'PRD');
	    }
	    const objectPatterns = [
	      /([\u4e00-\u9fa5A-Za-z0-9_-]{2,18})的(评价|评论|复盘|报告|方案|文档|脚本)/g,
	      /(评价|评论|复盘|review|检查|查看|修改|优化)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,18})/gi,
	      /(run-[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.sh|PR\s*\d+|PRD|session|skill)/gi,
	    ];
	    for (const pattern of objectPatterns) {
	      let match: RegExpExecArray | null;
	      while ((match = pattern.exec(withoutTags))) {
	        if (match.length >= 3) {
	          push(match[1].length <= match[2].length ? `${match[2]}${match[1]}` : `${match[1]}${match[2]}`);
	        } else {
	          push(match[1]);
	        }
	        if (candidates.length >= 2) break;
	      }
	      if (candidates.length >= 2) break;
	    }
	    if (candidates.length === 0) {
	      if (/调用\s*skill|使用\s*skill|skill/i.test(withoutTags)) push('skill调用');
	      else if (/review|评审|评价|复盘|检查/i.test(withoutTags)) push('review');
	      else if (/写代码|代码|实现|修复|开发|code/i.test(withoutTags)) push('代码修改');
	      else if (/看文档|文档|阅读|查看文档|doc/i.test(withoutTags)) push('文档查看');
	      else if (/需求|requirement/i.test(withoutTags)) push('需求分析');
	    }
	    return candidates.slice(0, 2).join(' / ');
	  };
	  const inboxLlmEnhancedGoalKeywords = (skillName: string): string => {
	    const goal = skillDerivedStandards[skillName]?.enhancedReview?.userGoal;
	    const slots = (goal?.slots ?? [])
	      .map((slot) => inboxExtractKeyword(slot, 18))
	      .filter((slot): slot is string => Boolean(slot));
	    if (slots.length > 0) return slots.slice(0, 3).join(' / ');
	    return inboxExtractGoalKeywords(goal?.summary) || inboxExtractKeyword(goal?.expectedOutcome, 36);
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxLlmEnhancedDeclaredGoalKeywords = (skillName: string): string => {
	    const goal = skillDerivedStandards[skillName]?.enhancedReview?.skillDeclaredGoal;
	    const keywords = [
	      ...(goal?.keywords ?? []),
	      ...(goal?.expectedOutcomes ?? []),
	    ]
	      .map((keyword) => inboxExtractKeyword(keyword, 18))
	      .filter((keyword): keyword is string => Boolean(keyword));
	    if (keywords.length > 0) return Array.from(new Set(keywords)).slice(0, 4).join(' / ');
	    return inboxExtractGoalKeywords(goal?.summary);
	  };
	  const inboxExtractCompletionKeywords = (text?: string): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    const candidates: string[] = [];
	    const push = (value: string): void => {
	      if (!candidates.includes(value)) candidates.push(value);
	    };
	    if (/已完成|完成|最终结果|完整结果|结果如下|报告如下/i.test(cleaned)) push('任务完成');
	    if (/已生成|生成如下|直接生成/i.test(cleaned)) push('已生成');
	    if (/已保存|已写入|已创建/i.test(cleaned)) push('已保存');
	    if (/方案路径|产物路径|文档路径|结果文件|输出路径/i.test(cleaned)) push('结果路径');
	    if (/代码|```|tsx?|jsx?|html|css/i.test(cleaned)) push('代码结果');
	    if (/报告|文档|方案/i.test(cleaned)) push('文档结果');
	    return candidates.slice(0, 3).join(' / ') || '未识别到明确完成结果';
	  };
	  const inboxExtractArtifactKeywords = (text?: string): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    const candidates: string[] = [];
	    const push = (value: string): void => {
	      if (!candidates.includes(value)) candidates.push(value);
	    };
	    const pathMatches = cleaned.match(/(?:\/[\w.-]+){2,}\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b|[\w.-]+\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b/gi) ?? [];
	    for (const path of pathMatches.slice(0, 2)) push(path);
	    if (/https?:\/\/\S+/i.test(cleaned)) push('链接');
	    if (/```(?:tsx?|jsx?|html|css|json|markdown)?/i.test(cleaned)) push('代码块');
	    if (/\.(?:png|jpe?g)\b|图片|截图/i.test(cleaned)) push('图片');
	    if (/\.(?:md|pdf|docx?)\b|文档|报告|方案/i.test(cleaned)) push('文档');
	    if (/\.(?:html|tsx?|jsx?)\b|demo|Demo|预览|页面/i.test(cleaned)) push('页面/Demo');
	    if (/\.(?:xlsx?|csv)\b|表格/i.test(cleaned)) push('表格');
	    if (/dashboard|看板/i.test(cleaned)) push('看板');
	    return candidates.slice(0, 3).join(' / ') || '未识别到明确产物';
	  };
	  type ManualCorrectionTarget =
	    | 'goal_keyword_correction'
	    | 'result_artifact_correction'
	    | 'completion_result_correction'
	    | 'deliverable_artifact_correction'
	    | 'skill_relevance_correction'
	    | 'workflow_completion_correction'
	    | 'hardrule_execution_correction'
	    | 'main_tool_execution_correction';
	  type ManualCorrectionOption = { value: string; label: string };
	  const manualCorrectionLabel = (raw?: string): string => {
	    if (!raw) return '';
	    try {
	      const parsed = JSON.parse(raw) as { label?: unknown; value?: unknown };
	      if (typeof parsed.label === 'string' && parsed.label.trim()) return parsed.label;
	      if (typeof parsed.value === 'string' && parsed.value.trim()) return parsed.value;
	    } catch {
	      return raw;
	    }
	    return raw;
	  };
	  const manualCorrectionEntry = (targetType: ManualCorrectionTarget, targetId: string) =>
	    reviewState.entries[reviewStateKey(targetType, targetId)];
	  const renderManualCorrectionButton = (
	    targetType: ManualCorrectionTarget,
	    targetId: string,
	    label: string,
	    options: ManualCorrectionOption[],
	    kind: 'choice' | 'text' = 'choice',
	  ): string => {
	    const entry = manualCorrectionEntry(targetType, targetId);
	    const current = manualCorrectionLabel(entry?.note);
	    const optionsJson = e(JSON.stringify(options));
	    return `<button type="button"
	      class="manual-correction-button ${current ? 'is-marked' : ''}"
	      data-manual-correction-key="${e(reviewStateKey(targetType, targetId))}"
	      data-manual-correction-target-type="${e(targetType)}"
	      data-manual-correction-target-id="${e(targetId)}"
	      data-manual-correction-kind="${e(kind)}"
	      data-manual-correction-label="${e(label)}"
	      data-manual-correction-current="${e(current)}"
	      data-manual-correction-options="${optionsJson}"
	      onclick="openManualCorrection(this)"
	      title="人工纠正会写入 review-state.json，不修改原始 trace">${e(label)}${current ? `：${e(current)}` : ''}</button>`;
	  };
	  const inboxManualCorrectionControls = (skill: ExperienceSessionSummary, answerKey: string): string => {
	    const baseId = skill.id;
	    const completionResultOptions = [
	      { value: 'completed', label: '有完成反馈' },
	      { value: 'result_feedback', label: '有结果反馈' },
	      { value: 'progress_only', label: '只是过程进展' },
	      { value: 'not_completed', label: '没有完成反馈' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const deliverableArtifactOptions = [
	      { value: 'doc_link', label: '文档链接' },
	      { value: 'demo_url', label: 'Demo 地址' },
	      { value: 'code_block', label: '代码块' },
	      { value: 'file_path', label: '文件路径' },
	      { value: 'uploaded_artifact', label: '上传产物' },
	      { value: 'no_artifact', label: '没有具体产物' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const relevanceOptions = [
	      { value: 'relevant', label: '相关' },
	      { value: 'partial', label: '部分相关' },
	      { value: 'not_relevant', label: '不相关' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const workflowOptions = [
	      { value: 'complete', label: '完整执行' },
	      { value: 'partial', label: '部分执行' },
	      { value: 'not_executed', label: '未执行' },
	      { value: 'wrong_order', label: '顺序错误' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const hardruleOptions = [
	      { value: 'executed', label: '已执行' },
	      { value: 'not_executed', label: '未执行' },
	      { value: 'insufficient', label: '执行不充分' },
	      { value: 'not_applicable', label: '规则不适用' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const mainToolOptions = [
	      { value: 'hit', label: '核心工具命中' },
	      { value: 'missed', label: '核心工具未命中' },
	      { value: 'not_declared', label: '未声明核心工具' },
	      { value: 'not_applicable', label: '不适用' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const buttons = answerKey === 'goal_satisfaction'
	      ? [
	          renderManualCorrectionButton('goal_keyword_correction', `${baseId}:goal_keyword`, '改目标关键词', [], 'text'),
	          renderManualCorrectionButton('completion_result_correction', `${baseId}:completion_result`, '标注有结果', completionResultOptions),
	          renderManualCorrectionButton('deliverable_artifact_correction', `${baseId}:deliverable_artifact`, '标注有产物', deliverableArtifactOptions),
	        ]
	      : answerKey === 'declared_behavior_fit'
	        ? [
	            renderManualCorrectionButton('skill_relevance_correction', `${baseId}:skill_relevance:${skill.skillName}`, '能力是否相关', relevanceOptions),
	            renderManualCorrectionButton('workflow_completion_correction', `${baseId}:workflow_completion:${skill.skillName}`, '标准流程完整性', workflowOptions),
	            renderManualCorrectionButton('hardrule_execution_correction', `${baseId}:hardrule_execution:${skill.skillName}`, '硬性规则执行', hardruleOptions),
	            renderManualCorrectionButton('main_tool_execution_correction', `${baseId}:main_tool_execution:${skill.skillName}`, '核心工具状态', mainToolOptions),
	          ]
	        : [];
	    if (buttons.length === 0) return '';
	    return `<div class="manual-correction-panel">
	      <span class="manual-correction-title">人工纠正</span>
	      <div class="manual-correction-actions">${buttons.join('')}</div>
	    </div>`;
	  };
	  const inboxManualCorrectionButtonGroup = (skill: ExperienceSessionSummary, answerKey: string): string => {
	    const panel = inboxManualCorrectionControls(skill, answerKey);
	    return panel.replace('class="manual-correction-panel"', 'class="manual-correction-panel is-in-review-popover"');
	  };
	  const inboxManualCorrectionActiveCount = (skill: ExperienceSessionSummary): number => {
	    const targetIds = [
	      ['goal_keyword_correction', `${skill.id}:goal_keyword`],
	      ['completion_result_correction', `${skill.id}:completion_result`],
	      ['deliverable_artifact_correction', `${skill.id}:deliverable_artifact`],
	      ['skill_relevance_correction', `${skill.id}:skill_relevance:${skill.skillName}`],
	      ['workflow_completion_correction', `${skill.id}:workflow_completion:${skill.skillName}`],
	      ['hardrule_execution_correction', `${skill.id}:hardrule_execution:${skill.skillName}`],
	      ['main_tool_execution_correction', `${skill.id}:main_tool_execution:${skill.skillName}`],
	    ] as const;
	    return targetIds.filter(([targetType, targetId]) =>
	      manualCorrectionLabel(manualCorrectionEntry(targetType, targetId)?.note)
	    ).length;
	  };
	  const inboxChecklistDetected = (item: ExperienceChecklistItem): boolean => {
	    // 检测到「需要关注或值得展示的事实」: 失败 / 数据问题 / 正向 passed / 主动声明类 passed
	    if (item.status === 'failed' || item.status === 'degraded') return true;
	    if (item.status === 'unknown' && item.contribution === 'informational' && /^看到/.test(item.label)) return true;
	    if (item.status === 'passed') {
	      // passed 时, 看 contribution 区分「主动发现的事实」vs「未发现负向信号」
	      // - blocking / attention contribution + passed = 「负向 item 未命中」, 视为「未发现」
	      // - positive / informational + passed = 「正向 item 命中 / 中性事实成立」, 视为「发现」
	      return item.contribution === 'positive' || item.contribution === 'informational';
	    }
	    return false;
	  };
	  const inboxChecklistStatusClass = (item: ExperienceChecklistItem): string => {
	    if (inboxChecklistDetected(item)) return 'is-detected';
	    return 'is-absent';
	  };
	  const inboxChecklistStatusIcon = (item: ExperienceChecklistItem): string => {
	    return inboxChecklistDetected(item) ? '●' : '○';
	  };
	  const inboxChecklistSourceLabel = (source?: ExperienceChecklistItem['source']): string => {
	    if (source === 'llm_soft') return '模型识别';
	    if (source === 'manual') return '人工';
	    return '规则判定';
	  };
	  const inboxChecklistSourceBadge = (item: ExperienceChecklistItem): string => {
	    if (item.status === 'unknown' || item.status === 'degraded' || item.status === 'not_applicable') return '';
	    return `<em>${e(inboxChecklistSourceLabel(item.source))}</em>`;
	  };
	  const inboxAnswerChecklistFromItems = (items: ExperienceChecklistItem[]): string => {
	    const isCore = (item: ExperienceChecklistItem): boolean =>
	      item.status === 'failed'
	      || item.status === 'degraded'
	      || item.contribution === 'blocking'
	      || (item.contribution === 'attention' && inboxChecklistDetected(item));
	    const renderItems = (groupItems: ExperienceChecklistItem[]): string => groupItems.map((item) => `<span class="inbox-answer-check ${inboxChecklistStatusClass(item)}" title="${e(item.reason)}">
	      <span class="inbox-answer-check-icon">${e(inboxChecklistStatusIcon(item))}</span><span>${e(item.label)}</span>${inboxChecklistSourceBadge(item)}
	    </span>`).join('');
	    const coreItems = items.filter(isCore);
	    const otherItems = items.filter((item) => !coreItems.includes(item));
	    return `<div class="inbox-answer-checklist is-grouped">
	      ${coreItems.length > 0 ? `<div class="inbox-answer-check-group"><strong>核心关注</strong><div>${renderItems(coreItems)}</div></div>` : ''}
	      ${otherItems.length > 0 ? `<div class="inbox-answer-check-group"><strong>其他发现</strong><div>${renderItems(otherItems)}</div></div>` : ''}
	    </div>`;
	  };
	  const inboxAnswerChecklist = (skill: ExperienceSessionSummary, answer: ExperienceSessionStoryAnswer): string => {
	    const answerKey = answer.key;
	    if ((answer.checklistItems ?? []).length > 0) {
	      return inboxAnswerChecklistFromItems(answer.checklistItems);
	    }
	    const goalKeywords = inboxExtractGoalKeywords(skill.evidenceChain?.firstUserMessage?.snippet) || inboxLlmEnhancedGoalKeywords(skill.skillName);
	    const chain = skillChains[skill.skillName];
	    const displayIndicators = displayIndicatorsForSession(skill);
	    const hasGoalKeyword = goalKeywords.length > 0;
	    const hasCompletionResult = displayIndicators.assistantDeliverySignalCount > 0;
	    const hasDeliverableArtifact = displayIndicators.deliverableArtifactSignalCount > 0;
	    const hasSkillDescriptionHit = (skill.evidenceChain?.skillContextCount ?? 0) > 0;
	    const workflowNodes = chain?.runtime.workflowNodes ?? [];
	    const hasCompleteWorkflow = workflowNodes.length > 0 && workflowNodes.every((node) => node.status === 'passed');
	    const hardRuleChecks = chain?.runtime.hardRules ?? [];
	    const hasExecutedHardRules = hardRuleChecks.length > 0 && hardRuleChecks.every((rule) => rule.status === 'passed');
	    const hasExpectedToolMissed = (skill.reviewerReport?.findings ?? []).some((finding) => finding.ruleSource === 'expected_tools_missed');
	    const executionText = skill.reviewerReport?.chainSteps.find((step) => step.label === '执行流程')?.text ?? '';
	    const expectedToolDeclared = hasExpectedToolMissed || /声明的(?:主业|核心)工具/.test(executionText);
	    const hasMainToolHit = expectedToolDeclared && /命中声明的(?:主业|核心)工具/.test(executionText) && !hasExpectedToolMissed;
	    const mainToolLabel = expectedToolDeclared
	      ? hasMainToolHit
	        ? '核心工具命中'
	        : '核心工具未命中'
	      : '未声明核心工具';
	    const hasNegativeFeedback = displayIndicators.negativeFeedbackCount > 0 || displayIndicators.userCorrectionCount > 0;
	    const hasFollowUp = displayIndicators.userFollowUpCount > 0;
	    const hasSupplementContext = displayIndicators.userFollowUpCount > 0 || displayIndicators.userMessageCount > 1;
	    const hasInterruption = displayIndicators.userInterruptionCount > 0;
	    const checks = answerKey === 'goal_satisfaction'
	      ? [
	          { label: `用户目标关键字：${goalKeywords || '未提取到'}`, ok: hasGoalKeyword },
	          { label: '有结果：看到完成态或结果反馈', ok: hasCompletionResult },
	          { label: '有产物：看到链接、路径、代码块或文件', ok: hasDeliverableArtifact },
	          { label: '用户针对结果或产物反复追问', ok: hasFollowUp },
	        ]
	      : answerKey === 'declared_behavior_fit'
	        ? [
	            { label: '能力描述命中用户提问', ok: hasSkillDescriptionHit },
	            { label: '标准流程完整执行', ok: hasCompleteWorkflow },
	            { label: '硬性规则执行', ok: hasExecutedHardRules },
	            { label: mainToolLabel, ok: hasMainToolHit },
	          ]
	        : [
	            { label: '用户有负面反馈如反驳、不满等', ok: hasNegativeFeedback },
	            { label: '用户有追问', ok: hasFollowUp },
	            { label: '用户有重新补充上下文/文档', ok: hasSupplementContext },
	            { label: '用户有中断流程', ok: hasInterruption },
	          ];
	    return `<div class="inbox-answer-checklist">${checks.map((check) => `<span class="inbox-answer-check ${check.ok ? 'is-detected' : 'is-absent'}"><span class="inbox-answer-check-icon">${check.ok ? '●' : '○'}</span>${e(check.label)}</span>`).join('')}</div>`;
	  };
	  const inboxRecognizedGoalText = (skill: ExperienceSessionSummary): string => {
	    const llmGoal = inboxLlmEnhancedGoalKeywords(skill.skillName);
	    if (llmGoal) return llmGoal;
	    const goals = (skill.sessionStory?.goalSlices ?? [])
	      .map((goal) => inboxExtractGoalKeywords(goal.inferredUserGoal))
	      .filter((goal): goal is string => Boolean(goal));
	    if (goals.length > 0) return goals.slice(0, 3).join('；');
	    return inboxExtractGoalKeywords(skill.evidenceChain?.firstUserMessage?.snippet)
	      || '未提取到明确用户目标';
	  };
	  const inboxSignalSnippet = (
	    skill: ExperienceSessionSummary,
	    predicate: (event: ExperienceTimelineEvent) => boolean,
	    fallback: string,
	  ): string => {
	    const events = (skill.timelinePreview ?? []).filter(predicate);
	    const text = inboxCleanSnippet(events.at(-1)?.snippet ?? events.at(-1)?.fullText);
	    if (text) return text;
	    return inboxCleanSnippet(skill.evidenceChain?.lastAssistantMessage?.snippet) ?? fallback;
	  };
	  const inboxRecognizedCompletionText = (skill: ExperienceSessionSummary): string => {
	    const text = inboxSignalSnippet(
	      skill,
	      (event) => event.kind === 'assistant_message' && isAssistantCompletionResultSignal(event),
	      '未识别到明确完成结果',
	    );
	    return inboxExtractCompletionKeywords(text);
	  };
	  const inboxRecognizedArtifactText = (skill: ExperienceSessionSummary): string => {
	    const text = inboxSignalSnippet(
	      skill,
	      (event) => event.kind === 'assistant_message' && isAssistantDeliverableArtifactSignal(event),
	      '未识别到明确产物',
	    );
	    return inboxExtractArtifactKeywords(text);
	  };
	  const inboxAnswerContext = (skill: ExperienceSessionSummary, answer: ExperienceSessionStoryAnswer): string => {
	    if (answer.key !== 'goal_satisfaction') return '';
	    return `<div class="inbox-answer-context">
	      <div><span>目标关键词</span><strong>${e(inboxRecognizedGoalText(skill))}</strong></div>
	      <div><span>结果关键词</span><strong>${e(inboxRecognizedCompletionText(skill))}</strong></div>
	      <div><span>产物关键词</span><strong>${e(inboxRecognizedArtifactText(skill))}</strong></div>
	    </div>`;
	  };
	  const inboxSuggestionKey = (suggestion: ResolvedOwnerSuggestion): string =>
	    [suggestion.checklistItemKey, suggestion.title, suggestion.body, suggestion.acceptanceCriteria].filter(Boolean).join('\u0000');
	  const inboxTextSuggestion = (title: string, body?: string, acceptanceCriteria?: string): ResolvedOwnerSuggestion => ({
	    title,
	    body,
	    acceptanceCriteria,
	  });
	  const inboxSuggestionHasFeedbackContract = (suggestions: ResolvedOwnerSuggestion[]): boolean =>
	    suggestions.some((suggestion) => /feedback|adopt|reject|useful|thumbs?|反馈|采用|弃用|点赞|点踩|简评|评价/i.test(
	      [suggestion.title, suggestion.body, suggestion.acceptanceCriteria].filter(Boolean).join('\n'),
	    ));
	  const inboxFeedbackContractSuggestion = (): ResolvedOwnerSuggestion => inboxTextSuggestion(
	    '补充用户反馈采集点',
	    '在产物交付或人工复盘入口中补充轻量反馈，例如采用 / 弃用、有用 / 无用、点赞 / 点踩或一句话简评。这样线上观测可以把用户反馈关联到具体 session、skill 调用、产物和规则证据。',
	    '下次观测中，反馈记录能回溯到对应 session、artifact 和 skill invocation。',
	  );
    const inboxTypeDeclarationSuggestion = (resolved: ResolvedObservationReviewSession): ResolvedOwnerSuggestion | undefined => {
      if (resolved.skillTypeSource === 'frontmatter') return undefined;
      const frontmatterExample = '示例：在 SKILL.md 顶部 frontmatter 增加 skillType: router / delegation / executor / advisory / workflow_owner 之一。';
      return inboxTextSuggestion(
        '在 SKILL.md frontmatter 声明 skill 类型',
        `当前类型来自规则推断或模型识别，不如作者声明稳定。建议在 SKILL.md frontmatter 中声明 skillType，让观测报告按正确类型生成流程判断和 owner 建议。${frontmatterExample}`,
        'SKILL.md frontmatter 中出现明确 skillType。',
      );
    };
    const inboxTypeFallbackSuggestion = (resolved: ResolvedObservationReviewSession): ResolvedOwnerSuggestion | undefined => {
      if (resolved.skillType === 'router') {
        return inboxTextSuggestion(
          '完善路由型 skill 的下游闭环标准',
          '路由型 skill 需要声明：如何选择下游能力、如何保留用户目标、如何关联下游 session / 产物、用户追问时如何返回状态。',
          '下次观测中能看到路由选择、下游链路关联、下游完成态、用户侧闭环四类证据。',
        );
      }
      if (resolved.skillType === 'delegation') {
        return inboxTextSuggestion(
          '完善委派型 skill 的 child 生命周期标准',
          '委派型 skill 需要声明：child 如何启动、如何追踪 session / ttyd / tmux、父会话不能接手哪些原始任务、异步完成或失败如何通知用户。',
          '下次观测中能看到 child lifecycle、parent boundary、async notification 三类证据。',
        );
      }
      if (resolved.skillType === 'executor') {
        return inboxTextSuggestion(
          '完善执行型 skill 的完成态和产物标准',
          '执行型 skill 需要声明：核心工具或动作是什么、什么算执行完成、标准产物是什么、最后如何明确交付给用户。',
          '下次观测中能看到核心工具命中、最终回复、标准产物路径或链接。',
        );
      }
      if (resolved.skillType === 'advisory') {
        return inboxTextSuggestion(
          '完善咨询型 skill 的结论和证据标准',
          '咨询型 skill 需要声明：结论如何组织、证据如何引用、未知项如何说明、下一步建议如何表达。',
          '下次观测中能看到明确结论、证据来源、未确认项和可执行下一步。',
        );
      }
      if (resolved.skillType === 'workflow_owner') {
        return inboxTextSuggestion(
          '完善流程负责型 skill 的阶段矩阵',
          '流程负责型 skill 需要声明标准阶段、每个阶段的 owner / executor、期望证据、阶段产物、失败信号和用户反馈处理方式。',
          '下次观测中能看到阶段矩阵、阶段责任、阶段产物、阶段反馈和最终流程闭环。',
        );
      }
      return undefined;
    };
    const inboxRuleTypeSuggestions = (skill: ExperienceSessionSummary, resolved: ResolvedObservationReviewSession): ResolvedOwnerSuggestion[] => {
      const out: ResolvedOwnerSuggestion[] = [];
      const typeSuggestion = inboxTypeDeclarationSuggestion(resolved);
      if (typeSuggestion) out.push(typeSuggestion);
      const typeFallbackSuggestion = inboxTypeFallbackSuggestion(resolved);
      if (typeFallbackSuggestion) out.push(typeFallbackSuggestion);
      const indicators = displayIndicatorsForSession(skill);
      const downstreamSignals = canonicalFeedbackSignalsForDisplay(skill).filter((signal) =>
        (signal.type === 'follow_up' || signal.type === 'interruption')
        && (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
          attribution.skillName === skill.skillName && attribution.attributionRole === 'downstream_related'
        )
      );
      if (downstreamSignals.length > 0 && resolved.skillType !== 'router' && resolved.skillType !== 'delegation') {
        const hasInterruption = downstreamSignals.some((signal) => signal.type === 'interruption');
        out.push(inboxTextSuggestion(
          hasInterruption ? '补充下游调用链路的中断处理' : '补充下游调用链路的追问处理',
          hasInterruption
            ? '这次运行出现下游调用链路，且用户在下游链路中手动中断。即使当前 skill 类型未判为路由或委派，也需要声明下游状态回收、停止处理和用户通知规范。'
            : '这次运行出现下游调用链路，且用户对下游进度或结果有追问。即使当前 skill 类型未判为路由或委派，也需要声明下游状态回收和用户追问处理规范。',
          '下次观测中，下游运行中 / 完成 / 失败 / 中断都有明确状态，并能关联到当前 skill 的用户侧闭环。',
        ));
      }
      if (resolved.skillType === 'router') {
        if (indicators.userFollowUpCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0) {
          out.push(inboxTextSuggestion(
            '补充下游调用链路的追问处理',
            '这个路由型 skill 的下游调用链路出现用户追问。建议把下游 session、产物、完成态、失败原因和用户可见状态写清楚。',
            '下次观测中，下游完成 / 失败 / 跑偏能关联到路由能力，并且用户追问时能看到明确状态。',
          ));
        }
      } else if (resolved.skillType === 'delegation') {
        if (indicators.userFollowUpCount > 0 || indicators.userInterruptionCount > 0) {
          out.push(inboxTextSuggestion(
            '补充 child 生命周期和异步通知状态',
            '委派型 skill 需要稳定表达 child 是否已启动、运行中、完成、失败或被停止，避免用户只能通过追问确认进度。',
            'runner / child session / ttyd / cleanup / observer 状态能在报告中形成完整链路。',
          ));
        }
      } else if (resolved.skillType === 'executor') {
        if (indicators.assistantDeliverySignalCount === 0 || indicators.deliverableArtifactSignalCount === 0) {
          out.push(inboxTextSuggestion(
            '补充执行型 skill 的完成态和标准产物',
            '执行型 skill 应明确什么算完成，以及最终产物应该是文件、链接、代码块还是文档路径，避免过程消息被当成结果。',
            '最后回复包含明确完成标记和可回溯产物证据。',
          ));
        }
      } else if (resolved.skillType === 'advisory') {
        if (indicators.userFollowUpCount > 0) {
          out.push(inboxTextSuggestion(
            '补充咨询型 skill 的结论和证据结构',
            '咨询型 skill 被追问时，通常说明结论边界或证据引用不够清楚。建议固定输出结论、证据、未知项和下一步。',
            '下次同类咨询中，用户无需追问即可看到结论和证据来源。',
          ));
        }
      } else if (resolved.skillType === 'workflow_owner') {
        if (indicators.userFollowUpCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0) {
          out.push(inboxTextSuggestion(
            '补充流程阶段的反馈闭环',
            '流程负责型 skill 出现用户追问、纠正或中断时，需要把反馈归到具体阶段，并说明该阶段是已完成、需补救、被跳过还是失败。',
            '下次观测中，用户反馈能定位到具体 workflow 阶段，并生成对应阶段的修复建议。',
          ));
        }
      }
      return out;
    };
	  const inboxBuildSkillActionSuggestions = (skill: ExperienceSessionSummary): ResolvedOwnerSuggestion[] => {
      const resolved = inboxResolvedSession(skill);
	    const llmSuggestions = resolved.ownerSuggestions;
	    const suggestions: ResolvedOwnerSuggestion[] = [
        ...inboxRuleTypeSuggestions(skill, resolved),
        ...llmSuggestions,
      ];
	    const reportSuggestions = skill.reviewerReport?.authorSuggestions ?? [];
	    for (const suggestion of reportSuggestions) {
	      if (/下游|回挂|追问|纠正|中断|异步闭环|结果回传/.test(suggestion)) {
	        suggestions.push(inboxTextSuggestion('补强下游闭环和反馈关联', suggestion));
	      }
	    }
	    if (suggestions.length === 0 && reportSuggestions.length > 0) {
	      suggestions.push(...reportSuggestions.map((suggestion) => inboxTextSuggestion(suggestion)));
	    }
	    const chain = skillChains[skill.skillName];
	    const findings = skill.reviewerReport?.findings ?? [];
      const displayIndicators = displayIndicatorsForSession(skill);
	    const hasFinding = (source: string): boolean => findings.some((finding) => finding.ruleSource === source);
	    const storyAnswers = skill.sessionStory?.answers ?? [];
	    const goalAnswer = storyAnswers.find((answer) => answer.key === 'goal_satisfaction');
	    if (suggestions.length === 0 && chain && (!chain.healthCheck.hardRules.declared || !chain.healthCheck.workflows.declared)) {
	      suggestions.push(inboxTextSuggestion(
	        '优化标准流程和硬性规则声明',
	        '把执行步骤、检查点、失败降级写成可观测的结构。',
	        'SKILL.md 中能识别到标准 workflow 和 hardRules，报告可按声明流程复盘。',
	      ));
	    }
	    if (suggestions.length === 0 && (
	      hasFinding('final_delivery_absent')
	      || goalAnswer?.status === 'degraded'
	      || goalAnswer?.status === 'attention'
	      || goalAnswer?.status === 'unknown'
	      || displayIndicators.assistantDeliverySignalCount === 0
	    )) {
	      suggestions.push(inboxTextSuggestion(
	        '优化完成情况判断',
	        '明确什么算有结果、什么算有产物，过程进展不要当成完成，并保留可回溯证据。',
	        '能力最后一次回复包含明确完成标记；如有产物，附上代码块、文档链接或文件路径。',
	      ));
	    }
	    if (suggestions.length === 0 && (hasFinding('user_hard_rule') || displayIndicators.hardRuleTextHitCount > 0)) {
	      suggestions.push(inboxTextSuggestion(
	        '沉淀用户硬性要求',
	        '把用户反复提出的硬性要求沉淀到 skill 规则或流程检查点，减少依赖用户临时纠偏。',
	      ));
	    }
	    if (suggestions.length === 0 && (displayIndicators.toolFailureCount > 0 || hasFinding('tool_error_recovery'))) {
	      suggestions.push(inboxTextSuggestion(
	        '补充工具失败恢复路径',
	        '让失败处理也能被 workflow 覆盖；读取失败时先说明缺失文件和影响，再尝试备用路径或让用户确认。',
	      ));
	    }
	    if (suggestions.length === 0 && (
	      displayIndicators.userCorrectionCount > 0
	      || displayIndicators.negativeFeedbackCount > 0
	      || displayIndicators.userFollowUpCount > 0
	    )) {
	      suggestions.push(inboxTextSuggestion(
	        '补强用户满意度判断',
	        '把追问、纠正、负向反馈作为改进输入，而不是只看是否调用完成。',
	        '交付后用户继续纠正或追问时，报告定位到对应用户原文并标记为待复核。',
	      ));
	    }
	    if (!inboxSuggestionHasFeedbackContract(suggestions)) {
	      suggestions.push(inboxFeedbackContractSuggestion());
	    }
	    const deduped: ResolvedOwnerSuggestion[] = [];
	    for (const suggestion of suggestions) {
	      const key = inboxSuggestionKey(suggestion);
	      if (!deduped.some((item) => inboxSuggestionKey(item) === key)) deduped.push(suggestion);
	    }
	    return deduped.slice(0, 4);
	  };
	  const inboxRenderActionSuggestion = (suggestion: ResolvedOwnerSuggestion, index: number): string => {
	    const detailBlocks = [
	      suggestion.checklistItemKey ? `<div class="inbox-action-suggestion-detail"><span>关联检查项</span><p>${e(suggestion.checklistItemLabel ?? suggestion.checklistItemKey)}</p></div>` : '',
	      suggestion.body ? `<div class="inbox-action-suggestion-detail"><span>建议细节</span><p>${e(suggestion.body)}</p></div>` : '',
	      suggestion.acceptanceCriteria ? `<div class="inbox-action-suggestion-detail is-acceptance"><span>验收方式</span><p>${e(suggestion.acceptanceCriteria)}</p></div>` : '',
	    ].filter(Boolean).join('');
	    return `<li class="inbox-action-suggestion-item">
	      <details class="inbox-action-suggestion-card"${index === 0 ? ' open' : ''}>
	        <summary>
	          <span class="inbox-action-suggestion-index">${index + 1}</span>
	          <strong>${e(suggestion.title)}</strong>
	          <em>${detailBlocks ? '查看细节' : '无更多细节'}</em>
	        </summary>
	        ${detailBlocks ? `<div class="inbox-action-suggestion-body">${detailBlocks}</div>` : ''}
	      </details>
	    </li>`;
	  };
	  const inboxRenderSkillActionSummary = (sessions: ExperienceSessionSummary[]): string => {
	    const suggestions: ResolvedOwnerSuggestion[] = [];
	    for (const session of sessions) {
	      for (const suggestion of inboxBuildSkillActionSuggestions(session)) {
	        const key = inboxSuggestionKey(suggestion);
	        if (!suggestions.some((item) => inboxSuggestionKey(item) === key)) suggestions.push(suggestion);
	      }
	    }
	    if (suggestions.length === 0) return '';
	    return `<section class="inbox-skill-summary-suggestions">
	      <details class="inbox-suggestion-block is-action" open>
	        <summary class="inbox-suggestion-title">给 skill 作者的优化建议</summary>
	        <ol class="inbox-action-suggestion-list">${suggestions.slice(0, 5).map(inboxRenderActionSuggestion).join('')}</ol>
	      </details>
	    </section>`;
	  };
	  const inboxAnswerReasonLabel = (reason: ExperienceSessionStoryAnswer['reason']): string => {
	    if (reason === 'data_degraded') return '数据质量不足';
	    if (reason === 'blocking_failed') return '关键项未通过';
	    if (reason === 'attention_accumulated') return '存在复核项';
	    if (reason === 'unknown_dominant') return '未知项较多';
	    if (reason === 'all_passed') return '关键项通过';
	    return '当前不适用';
	  };
	  const inboxDataHealth = (skill: ExperienceSessionSummary, answers: ExperienceSessionStoryAnswer[]): { label: string; className: string; facts: string[] } => {
	    const hasDataDegraded = answers.some((answer) => answer.status === 'degraded' || answer.reason === 'data_degraded');
	    const hasAttention = answers.some((answer) => answer.status === 'attention' || answer.reason === 'blocking_failed' || answer.reason === 'attention_accumulated');
	    const hasUnknown = answers.length === 0 || answers.some((answer) => answer.status === 'unknown' || answer.reason === 'unknown_dominant' || answer.reason === 'not_applicable');
	    const label = hasDataDegraded
	      ? '数据健康度：数据有问题'
	      : hasAttention
	        ? '数据健康度：要看一眼'
	        : hasUnknown
	          ? '数据健康度：信息不够'
	          : '数据健康度：看起来正常';
	    const className = hasDataDegraded
	      ? 'is-degraded'
	      : hasAttention
	        ? 'is-attention'
	        : hasUnknown
	          ? 'is-unknown'
	          : 'is-ok';
	    const facts = [
	      `真实用户消息 ${skill.evidenceChain.userMessageCount}`,
	      `skill 上下文 ${skill.evidenceChain.skillContextCount}`,
	      `助手回复 ${skill.evidenceChain.assistantMessageCount}`,
	      `工具调用 ${skill.evidenceChain.toolUseCount}`,
	    ];
	    return { label, className, facts };
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxRenderDataHealth = (skill: ExperienceSessionSummary, answers: ExperienceSessionStoryAnswer[]): string => {
	    const health = inboxDataHealth(skill, answers);
	    return `<div class="inbox-trust-layer">
	      <span class="inbox-data-health ${health.className}">${e(health.label)}</span>
	      ${health.facts.map((fact) => `<span class="inbox-trust-fact">${e(fact)}</span>`).join('')}
	    </div>`;
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxRenderParentStatuses = (answers: ExperienceSessionStoryAnswer[]): string => {
	    if (answers.length === 0) return '';
	    return `<div class="inbox-parent-status-row">${answers.map((answer) => `<div class="inbox-parent-status ${answer.status === 'degraded' ? 'is-degraded' : answer.status === 'attention' ? 'is-attention' : answer.status === 'unknown' ? 'is-unknown' : answer.status === 'not_applicable' ? 'is-not-applicable' : 'is-ok'}">
	      <span>${e(answer.label)}</span>
	      ${inboxStatusBadge(answer.status)}
	      <em>${e(inboxAnswerReasonLabel(answer.reason))}</em>
	    </div>`).join('')}</div>`;
	  };
	  const inboxRenderTypeSpecificChecklist = (resolved: ResolvedObservationReviewSession): string => {
	    if (resolved.typeSpecificChecklist.length === 0) return '';
	    return `<div class="inbox-review-layer">
	      <div class="inbox-review-layer-title">${e(inboxLlmSkillTypeLabel(resolved.skillType))}检查项</div>
	      ${resolved.typeSpecificSummary ? `<p class="inbox-type-summary">${e(resolved.typeSpecificSummary)}</p>` : ''}
	      ${inboxAnswerChecklistFromItems(resolved.typeSpecificChecklist)}
	    </div>`;
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxRenderSessionSuggestions = (skill: ExperienceSessionSummary): string => {
	    const suggestions = inboxBuildSkillActionSuggestions(skill);
	    if (suggestions.length === 0) return '';
	    return `<div class="inbox-review-suggestions">
	      <div class="inbox-review-layer-title">建议</div>
	      <ol class="inbox-action-suggestion-list is-compact">${suggestions.slice(0, 4).map(inboxRenderActionSuggestion).join('')}</ol>
	    </div>`;
	  };
	  const inboxRenderSessionReviewControl = (session: ExperienceSessionSummary): string => {
	    const reviewEntry = reviewState.entries[`experience_session:${session.id}`];
	    const existingNote = reviewEntry?.reason ?? reviewEntry?.note ?? '';
	    const safeId = e(session.id);
	    const activeCount = (reviewEntry?.verdict ? 1 : 0) + inboxManualCorrectionActiveCount(session);
	    return `<details class="inbox-section-review" data-inbox-detail-actions data-inbox-session-id="${safeId}" onclick="event.stopPropagation()">
	      <summary class="inbox-section-review-button">人工标注${activeCount > 0 ? `(${activeCount})` : ''}</summary>
	      <div class="inbox-section-review-panel">
	        <div class="inbox-detail-actions-row"><strong class="inbox-detail-actions-title">这次跑得怎么样</strong><span class="inbox-detail-actions-meta">针对 ${e(session.skillName)}</span></div>
	        <div class="inbox-detail-actions-buttons">
	          <button type="button" class="inbox-action-button ${reviewEntry?.verdict === 'real_issue' ? 'is-active' : ''}" data-inbox-verdict="real_issue" onclick="setInboxSessionReview('${safeId}', 'real_issue', this)">同意</button>
	          <button type="button" class="inbox-action-button ${reviewEntry?.verdict === 'not_issue' ? 'is-active' : ''}" data-inbox-verdict="not_issue" onclick="setInboxSessionReview('${safeId}', 'not_issue', this)">否决</button>
	          <button type="button" class="inbox-action-button ${reviewEntry?.verdict === 'needs_more_context' ? 'is-active' : ''}" data-inbox-verdict="needs_more_context" onclick="toggleInboxNoteEditor('${safeId}', this)">留意见</button>
	        </div>
	        <div class="inbox-note-editor" data-inbox-note-editor="${safeId}" style="display:${reviewEntry?.verdict === 'needs_more_context' || existingNote ? 'block' : 'none'}">
	          <textarea class="inbox-note-textarea" data-inbox-note-input="${safeId}" placeholder="留下你的意见或补充上下文（保存后会写入 review-state）" rows="3">${e(existingNote)}</textarea>
	          <div class="inbox-note-editor-buttons">
	            <button type="button" class="inbox-note-save" onclick="saveInboxSessionNote('${safeId}', this)">保存意见</button>
	            <button type="button" class="inbox-note-cancel" onclick="closeInboxNoteEditor('${safeId}')">收起</button>
	          </div>
	        </div>
	        <div class="inbox-manual-review-groups">
	          <div class="inbox-manual-review-group">
	            <strong>目标 / 结果 / 产物</strong>
	            ${inboxManualCorrectionButtonGroup(session, 'goal_satisfaction')}
	          </div>
	          <div class="inbox-manual-review-group">
	            <strong>能力 / 流程 / 规则</strong>
	            ${inboxManualCorrectionButtonGroup(session, 'declared_behavior_fit')}
	          </div>
	        </div>
	      </div>
	    </details>`;
	  };
	  const inboxRenderSkillCompletion = (skill: ExperienceSessionSummary): string => {
	    const report = skill.reviewerReport;
	    const resolved = inboxResolvedSession(skill);
	    const answers = resolved.answers;
	    const llmSummary = resolved.reviewerSummary;
	    return `<article class="inbox-skill-block">
	      <header class="inbox-skill-head">
	        <div>
	          <div class="inbox-skill-title-row"><h4>${e(skill.skillName)}</h4>${inboxSkillTypeBadge(inboxLlmSkillTypeLabel(resolved.skillType), inboxLlmSkillTypeHelpKey(resolved.skillType), inboxSkillTypeSourceText(resolved))}</div>
	          <span class="inbox-skill-subtitle">${e(report?.title ?? '常规观测')}</span>
	        </div>
	        ${llmSummary || report?.summary ? `<p class="inbox-skill-summary">${e(cleanReportCopy(llmSummary ?? report?.summary ?? ''))}</p>` : ''}
	      </header>
	      ${inboxRenderTypeSpecificChecklist(resolved)}
	      ${answers.length > 0 ? `<div class="inbox-review-layer">
	        <div class="inbox-review-layer-title">这次跑得怎么样</div>
	        <div class="inbox-answer-grid">
	          ${answers.map((answer) => `<article class="inbox-answer ${answer.status === 'degraded' ? 'is-degraded' : answer.status === 'attention' ? 'is-attention' : answer.status === 'unknown' ? 'is-unknown' : answer.status === 'not_applicable' ? 'is-not-applicable' : 'is-ok'}">
	            <div class="inbox-answer-head"><strong>${e(answer.label)}</strong>${inboxStatusBadge(answer.status)}</div>
	            ${inboxAnswerContext(skill, answer)}
	            ${inboxAnswerChecklist(skill, answer)}
	            ${inboxAnswerEvidenceButtons(answer.evidenceRefs)}
	          </article>`).join('')}
	        </div>
	      </div>` : '<p class="inbox-skill-empty">这条能力调用暂未生成完成情况判断。</p>'}
	    </article>`;
	  };
	  const inboxInvocationsById = new Map<string, ExperienceInvocation>();
	  for (const inv of experience?.invocations ?? []) inboxInvocationsById.set(inv.id, inv);
	  const inboxGetSessionInvocations = (session: ExperienceSessionSummary): ExperienceInvocation[] =>
	    session.invocationIds.map((id) => inboxInvocationsById.get(id)).filter((v): v is ExperienceInvocation => Boolean(v));
	  const inboxGetSessionToolCounts = (session: ExperienceSessionSummary): Record<string, number> => {
	    const out: Record<string, number> = {};
	    for (const inv of inboxGetSessionInvocations(session)) {
	      for (const [k, v] of Object.entries(inv.toolCounts ?? {})) incrementRecordCount(out, k, v);
	    }
	    return out;
	  };
	  const inboxBuildToolDetail = (session: ExperienceSessionSummary): Array<{ name: string; count: number }> => {
	    const counts = inboxGetSessionToolCounts(session);
	    return Object.entries(counts)
	      .map(([name, count]) => ({ name, count }))
	      .sort((a, b) => b.count - a.count);
	  };
	  const inboxBuildToolFailureDetail = (session: ExperienceSessionSummary): Array<{ name: string; count: number }> => {
	    const invocations = inboxGetSessionInvocations(session);
	    const failures: Record<string, number> = {};
	    for (const inv of invocations) {
	      for (const event of inv.timeline) {
	        if (event.kind === 'tool_result' && event.isError && event.toolName) {
	          incrementRecordCount(failures, event.toolName);
	        }
	      }
	    }
	    return Object.entries(failures).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
	  };
	  const inboxMetricCardJson = (detail: Array<{ name: string; count: number }>): string =>
	    e(JSON.stringify(detail));
	  const inboxEpisodeSkillTypeLabel = (type?: string): string => {
	    if (type === 'router') return '路由';
	    if (type === 'delegation') return '委派';
	    if (type === 'executor') return '执行';
	    if (type === 'advisory') return '咨询';
	    return '未确认';
	  };
	  const inboxEpisodeSkillTypeForSegment = (segment: ExperienceSkillSegment): string =>
	    segment.skillType;
	  const inboxEpisodeRoleLabel = (role?: string): string => {
	    if (role === 'main_executor') return '主执行';
	    if (role === 'router') return '路由';
	    if (role === 'delegator') return '调度';
	    if (role === 'supporting') return '辅助';
	    if (role === 'observer') return '观察';
	    return '未确认';
	  };
	  const inboxEpisodeFeedbackLabel = (type?: string): string => {
	    if (type === 'correction') return '纠正';
	    if (type === 'follow_up') return '追问';
	    if (type === 'frustration') return '不满/焦虑';
	    if (type === 'interruption') return '中断';
	    if (type === 'positive') return '正向';
	    return '反馈';
	  };
	  const inboxEpisodeAttributionLabel = (role?: string): string => {
	    if (role === 'primary_fault') return '直接归因';
	    if (role === 'downstream_related') return '下游链路';
	    if (role === 'context_only') return '背景相关';
	    return '关联';
	  };
	  const inboxEpisodeAttributionText = (
	    signal: ExperienceFeedbackSignal,
	    segment: ExperienceSkillSegment,
	    attribution?: ExperienceFeedbackAttribution,
	  ): string => {
	    const signalLabel = inboxEpisodeFeedbackLabel(signal.type);
	    if (attribution?.attributionRole === 'downstream_related') {
	      return `下游调用链路用户有${signalLabel}`;
	    }
	    if (attribution?.attributionRole === 'primary_fault') {
	      if (attribution.reasonCode === 'promise_match') return `直接归因：用户在追问此前承诺的结果`;
	      if (attribution.reasonCode === 'action_match') return `直接归因：用户反馈命中了当前执行动作`;
	      if (attribution.reasonCode === 'object_match') return `直接归因：用户点名了当前能力或产物`;
	      return `直接归因：反馈发生在当前执行窗口`;
	    }
	    if (attribution?.attributionRole === 'context_only') return `背景相关：同一任务上下文里的${signalLabel}`;
	    return `${inboxEpisodeAttributionLabel(attribution?.attributionRole)}：${signalLabel}`;
	  };
	  const inboxEpisodeFeedbackForSegment = (
	    episode: ExperienceEpisode,
	    segmentId: string,
	  ): ExperienceFeedbackSignal[] => episode.feedbackSignals.filter((signal: ExperienceFeedbackSignal) =>
	    (signal.canonicalAttributions ?? signal.attributions).some((attribution) => attribution.skillSegmentId === segmentId)
	  );
	  const inboxRenderEpisodeSegmentTree = (
	    episode: ExperienceEpisode,
	    session: ExperienceSessionSummary,
	  ): string => {
	    const segmentById = new Map(episode.skillSegments.map((segment) => [segment.id, segment]));
	    const childIdsByParentId = new Map<string, string[]>();
	    const parentIdByChildId = new Map<string, string>();
	    for (const edge of episode.orchestrationEdges) {
	      const parentId = edge.parentSkillSegmentId;
	      const childId = edge.executorSkillSegmentId;
	      const edgeKind = edge.edgeKind ?? (childId ? 'internal_skill' : 'external_child_session');
	      if (edgeKind !== 'internal_skill') continue;
	      if (!parentId || !childId || parentId === childId || !segmentById.has(parentId) || !segmentById.has(childId)) continue;
	      const childIds = childIdsByParentId.get(parentId) ?? [];
	      if (!childIds.includes(childId)) childIds.push(childId);
	      childIdsByParentId.set(parentId, childIds);
	      parentIdByChildId.set(childId, parentId);
	    }
	    const orderedChildren = (parentId: string): ExperienceSkillSegment[] => (childIdsByParentId.get(parentId) ?? [])
	      .map((id) => segmentById.get(id))
	      .filter((segment): segment is ExperienceSkillSegment => Boolean(segment))
	      .sort((a, b) => a.order - b.order);
	    const roots = episode.skillSegments
	      .filter((segment) => !parentIdByChildId.has(segment.id))
	      .sort((a, b) => a.order - b.order);
	    const renderSegment = (segment: ExperienceSkillSegment, path: string, depth: number): string => {
	      const segmentSignals = inboxEpisodeFeedbackForSegment(episode, segment.id);
	      const parent = parentIdByChildId.get(segment.id);
	      const parentSegment = parent ? segmentById.get(parent) : undefined;
	      const children = orderedChildren(segment.id);
	      return `<li class="inbox-execution-node ${segment.skillName === session.skillName ? 'is-current' : ''} ${depth > 0 ? 'is-child' : ''}">
	        <div class="inbox-execution-node-main">
	          <span class="inbox-execution-node-index">${e(path)}</span>
	          <div>
	            <strong>${e(segment.skillName)}</strong>
	            <em>${e(inboxEpisodeSkillTypeLabel(inboxEpisodeSkillTypeForSegment(segment)))} · ${e(inboxEpisodeRoleLabel(segment.episodeRole))}${parentSegment ? ` · 由 ${e(parentSegment.skillName)} 调起` : ''}</em>
	          </div>
	        </div>
	        ${segmentSignals.length > 0 ? `<div class="inbox-execution-node-children">
	          ${segmentSignals.map((signal) => {
	            const attribution = (signal.canonicalAttributions ?? signal.attributions).find((item) => item.skillSegmentId === segment.id);
	            return `<div class="inbox-execution-feedback-item">
	              <span>${e(inboxEpisodeFeedbackLabel(signal.type))}</span>
	              <p>${e(signal.text)}</p>
	              <em>${e(inboxEpisodeAttributionText(signal, segment, attribution))}</em>
	            </div>`;
	          }).join('')}
	        </div>` : ''}
	        ${children.length > 0 ? `<ol class="inbox-execution-skill-children">
	          ${children.map((child, childIndex) => renderSegment(child, `${path}.${childIndex + 1}`, depth + 1)).join('')}
	        </ol>` : ''}
	      </li>`;
	    };
	    const rootSegments = roots.length > 0 ? roots : episode.skillSegments;
	    return `<ol class="inbox-execution-timeline">
	      ${rootSegments.map((segment, index) => renderSegment(segment, String(index + 1), 0)).join('')}
	    </ol>`;
	  };
	  const inboxRenderEpisodeOverview = (session: ExperienceSessionSummary): string => {
	    const episodes = session.sessionStory?.episodes ?? [];
	    if (episodes.length === 0) return '<p class="inbox-skill-empty">没有可展示的上下游链路。</p>';
	    return `<div class="inbox-execution-overview-body">
	        <p class="inbox-execution-overview-note">用于看当前 session 里各 skill 片段的关系和用户反馈归因；指标卡仍只统计当前 skill 调用窗口。</p>
	        ${episodes.map((episode, index) => `<details class="inbox-execution-episode"${index === 0 ? ' open' : ''}>
	          <summary class="inbox-execution-episode-head">
	            <strong>用户目标切片 ${episode.order}</strong>
	            <span>${e(episode.primaryGoal ?? '未提取到明确用户目标')}</span>
	          </summary>
	          <div class="inbox-execution-episode-body">
	            ${inboxRenderEpisodeSegmentTree(episode, session)}
	            ${episode.orchestrationEdges.length > 0 ? `<div class="inbox-execution-links">${episode.orchestrationEdges.map((edge) => {
	              const edgeKind = edge.edgeKind ?? (edge.executorSkillSegmentId ? 'internal_skill' : 'external_child_session');
	              const edgeLabel = edgeKind === 'internal_skill' ? '技能链路' : '外部子会话';
	              return `<span>${e(edgeLabel)}：${e(edge.childSessionId ?? '下游执行')} · ${e(edge.status === 'started' ? '已启动' : edge.status === 'completed' ? '已完成' : edge.status === 'failed' ? '失败' : '未知')}</span>`;
	            }).join('')}</div>` : ''}
	          </div>
	        </details>`).join('')}
	      </div>`;
	  };
	  const inboxRenderSkillRuntime = (skill: ExperienceSessionSummary): string => {
	    const report = skill.reviewerReport;
	    const metrics = report?.oneLookMetrics;
	    const templateId = `inbox-skill-chain-${experienceSkillAnchor(skill.skillName)}-${e(skill.id)}`;
	    const evidenceJumpId = `inbox-sec-evidence-${e(skill.id)}`;
	    const toolDetail = inboxBuildToolDetail(skill);
	    const toolFailureDetail = inboxBuildToolFailureDetail(skill);
	    const indicators = displayIndicatorsForSession(skill);
	    const runtimeModel = [
	      skill.sourceMetadata?.provider,
	      skill.sourceMetadata?.model,
	      skill.sourceMetadata?.modelApi,
		    ].filter(Boolean).join(' / ') || '未记录模型';
		    const tokenUsage = metrics?.tokenUsage;
		    const tokenCoverage = tokenUsage?.coverage ?? 0;
		    const tokenDetail: Array<{ name: string; count: number }> = tokenCoverage > 0 ? [
		      { name: '输入 token', count: tokenUsage!.inputTokens },
		      { name: '输出 token', count: tokenUsage!.outputTokens },
		      { name: 'cache 读取', count: tokenUsage!.cacheReadTokens },
		      { name: 'cache 写入', count: tokenUsage!.cacheCreationTokens },
	    ] : [];
	    type MetricCard = {
	      key: string;
	      label: string;
	      value: number;
	      detail: Array<{ name: string; count: number }>;
	      note: string;
	      anomaly: boolean;
	    };
	    const cards: MetricCard[] = !metrics ? [] : [
	      { key: 'toolCall', label: '工具调用', value: indicators.toolCallCount, detail: toolDetail, note: '本次能力调用段内触发的工具调用总数及各类工具的命中分布。', anomaly: false },
	      { key: 'toolFailure', label: '工具失败', value: indicators.toolFailureCount, detail: toolFailureDetail, note: '工具执行返回失败的次数。命中失败可在版块 ④ 看具体上下文。', anomaly: indicators.toolFailureCount > 0 },
	      { key: 'toolCancelled', label: '工具取消', value: indicators.toolCancelledCount ?? 0, detail: [], note: 'runtime 明确取消的工具调用次数。取消与执行失败分开统计。', anomaly: false },
	      { key: 'toolUnknown', label: '状态未知', value: indicators.toolUnknownCount ?? 0, detail: [], note: 'runtime 没有提供可信终态的工具调用次数。这些调用不计入工具成功率或失败率分母。', anomaly: false },
	      { key: 'userMessage', label: '用户消息', value: indicators.userMessageCount, detail: [], note: '本次能力调用段内的真实人工用户消息条数（已剔除 Skill 文档注入和运行时注入）。', anomaly: false },
	      { key: 'userFollowUp', label: '追问', value: indicators.userFollowUpCount, detail: [], note: '按当前 skill 的归因结果统计用户追问 / 补充；点击版块 ④ 可用同名标签定位原文。', anomaly: indicators.userFollowUpCount > 0 },
	      { key: 'userCorrection', label: '纠正', value: indicators.userCorrectionCount, detail: [], note: '用户明确纠正、否决前一轮交付的次数。出现即建议进版块 ④ 看上下文。', anomaly: indicators.userCorrectionCount > 0 },
	      { key: 'userInterruption', label: '人工中断', value: indicators.userInterruptionCount, detail: [], note: '用户在执行过程中主动中断的次数。可能意味着方向跑偏。', anomaly: indicators.userInterruptionCount > 0 },
	      { key: 'negativeFeedback', label: '负向反馈', value: indicators.negativeFeedbackCount, detail: [], note: '用户出现明确负向情绪表达的次数。', anomaly: indicators.negativeFeedbackCount > 0 },
	      { key: 'completionResult', label: '有结果', value: indicators.assistantDeliverySignalCount, detail: [], note: '回答中出现完成态或结果反馈的次数。它表示任务可能执行完成，不等于一定有可打开产物。', anomaly: false },
	      { key: 'deliverableArtifact', label: '有产物', value: indicators.deliverableArtifactSignalCount ?? 0, detail: [], note: '回答中出现文档链接、Demo 地址、文件路径、代码块或上传产物的次数。', anomaly: false },
	      { key: 'progress', label: '过程进展', value: metrics.assistantProgressUpdateCount ?? 0, detail: [], note: '回答中出现"正在 / 仍在 / 进度更新"等过程进展信号的次数。这类不算最终交付。', anomaly: false },
	      { key: 'selfCorrection', label: '自我纠正', value: metrics.selfCorrectionCount ?? indicators.selfCorrectionCount ?? 0, detail: [], note: 'agent 在没有用户介入的情况下发现问题并主动修正执行策略。少量说明有恢复能力，高频说明流程不稳。', anomaly: (metrics.selfCorrectionCount ?? indicators.selfCorrectionCount ?? 0) > 0 },
	      { key: 'repeatedExecution', label: '重复执行', value: metrics.repeatedExecutionCount ?? indicators.repeatedExecutionCount ?? 0, detail: [], note: '同类步骤、工具或流程被重复执行。高频出现时通常对应绕路或 workflow 不清晰。', anomaly: (metrics.repeatedExecutionCount ?? indicators.repeatedExecutionCount ?? 0) > 0 },
	      ...(tokenCoverage > 0 ? [
	        { key: 'tokenInput', label: '输入 token', value: tokenUsage!.inputTokens, detail: tokenDetail, note: `仅累计 trace 已上报 token 的能力调用，覆盖率 ${Math.round(tokenCoverage * 100)}%。`, anomaly: false },
	        { key: 'tokenOutput', label: '输出 token', value: tokenUsage!.outputTokens, detail: tokenDetail, note: `仅累计 trace 已上报 token 的能力调用，覆盖率 ${Math.round(tokenCoverage * 100)}%。`, anomaly: false },
	      ] : []),
	    ];
	    const metricRow = cards.length === 0
	      ? `<div id="inbox-sec-runtime-metrics-${e(skill.id)}"><p class="inbox-skill-empty">这条能力调用没有运行指标。</p></div>`
	      : `<div id="inbox-sec-runtime-metrics-${e(skill.id)}" class="inbox-metric-grid-wrap"><div class="inbox-metric-hint">点击任意指标卡可查看分布详情，红色卡片是检测到的异常。</div><div class="inbox-metric-grid">${cards.map((card) => `<button type="button" class="inbox-metric-card ${card.anomaly ? 'is-anomaly' : ''}" title="点击查看 ${e(card.label)} 详情" data-metric-key="${e(card.key)}" data-metric-label="${e(card.label)}" data-metric-value="${card.value}" data-metric-detail="${inboxMetricCardJson(card.detail)}" data-metric-note="${e(card.note)}" data-metric-anomaly="${card.anomaly ? '1' : '0'}" data-metric-jump="${evidenceJumpId}" onclick="openInboxMetricPopover(this)"><span>${e(card.label)}</span><strong>${card.value}</strong><em class="inbox-metric-card-hint">点击看详情</em></button>`).join('')}</div></div>`;
	    return `<article class="inbox-skill-block">
	      <header class="inbox-skill-head"><div><h4>${e(skill.skillName)}</h4><span class="inbox-skill-subtitle">运行指标 + 规则 / 流程 · 模型：${e(runtimeModel)}</span></div></header>
	      ${metricRow}
	      <details class="inbox-execution-overview inbox-rule-flow-overview" id="inbox-sec-runtime-rules-${e(skill.id)}" open>
	        <summary>流程规则命中</summary>
	        ${renderRuntimeRuleFlow(skill.skillName)}
	      </details>
	      <input type="hidden" data-inbox-skill-chain-template-id="${e(templateId)}">
	    </article>`;
	  };
	  const inboxRenderEvidence = (session: ExperienceSessionSummary, summaryText: string): string => {
	    const indicators = displayIndicatorsForSession(session);
	    const shownRuleFindings = displayRuleFindings(session, indicators);
	    const shownInference = displayAssistiveInference(indicators, session.assistiveInference);
	    const evidenceChain = session.evidenceChain ?? fallbackEvidenceChain(session);
	    const safeId = e(session.id);
	    const evidenceClass = indicators.toolFailureCount > 0 ? 'is-attention' : 'is-neutral';
	    return `<section class="inbox-section is-collapsed" data-inbox-section="evidence" id="inbox-sec-evidence-${safeId}">
	      <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	        <h3>④ 原文回溯</h3>
	        <span class="inbox-section-summary ${evidenceClass}">${e(summaryText)}</span>
	        <span class="inbox-section-hint">展开看当前能力调用段的证据链、规则命中、时间线</span>
	        <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">展开</button>
	      </header>
	      <div class="inbox-section-body">
	        <div class="inbox-evidence-grid">
	          <section>
	            <h4>证据链</h4>
	            ${renderEvidenceChain(evidenceChain)}
	            <h4>规则命中</h4>
	            ${renderRuleFindings(shownRuleFindings)}
	            <h4>复盘建议</h4>
	            ${renderAssistiveInference(shownInference)}
	          </section>
	          <section>
	            ${renderTimelinePair(session)}
	          </section>
	        </div>
	      </div>
	    </section>`;
	  };
	  const inboxRenderSessionContent = (cardSkillName: string, session: ExperienceSessionSummary, isActive: boolean): string => {
	    const siblings = inboxSiblingsMap.get(session.sessionId) ?? [session];
	    const indicators = displayIndicatorsForSession(session);
	    const safeId = e(session.id);
	    const completionAttentionCount = (session.reviewerReport?.findings ?? []).filter((f) => f.level === 'attention').length;
	    const completionSummaryText = completionAttentionCount > 0
	      ? `${completionAttentionCount} 项要看一眼`
	      : '未见高优复盘点';
	    const completionSummaryClass = completionAttentionCount > 0 ? 'is-attention' : 'is-ok';
	    const chainForSkill = skillChains[session.skillName];
	    const runtimeIssues: string[] = [];
	    if (chainForSkill) {
	      if (!chainForSkill.healthCheck.hardRules.declared) runtimeIssues.push('未标准化规则声明');
	      if (!chainForSkill.healthCheck.workflows.declared) runtimeIssues.push('未标准化流程声明');
	    }
	    if (indicators.toolFailureCount > 0) runtimeIssues.push(`工具失败 ${indicators.toolFailureCount} 次`);
	    const cancelledToolOutcomes = indicators.toolCancelledCount ?? 0;
	    const unknownToolOutcomes = indicators.toolUnknownCount ?? 0;
	    const runtimeSummaryText = runtimeIssues.length > 0
	      ? runtimeIssues.join(' · ')
	      : cancelledToolOutcomes > 0 || unknownToolOutcomes > 0
	        ? [
	            cancelledToolOutcomes > 0 ? `${cancelledToolOutcomes} 次工具调用取消` : '',
	            unknownToolOutcomes > 0 ? `${unknownToolOutcomes} 次工具结果状态未知` : '',
	          ].filter(Boolean).join(' · ')
	        : '运行指标无异常';
	    const runtimeSummaryClass = runtimeIssues.length > 0
	      ? 'is-attention'
	      : unknownToolOutcomes > 0 ? 'is-neutral' : 'is-ok';
	    const flowSummaryText = siblings.length > 1 ? `${siblings.length} 个能力调用段` : '单一能力调用段';
	    const flowTemplateId = `inbox-flow-template-${safeId}`;
	    const evidenceSummaryText = `工具 ${indicators.toolCallCount} · 失败 ${indicators.toolFailureCount}${cancelledToolOutcomes > 0 ? ` · 取消 ${cancelledToolOutcomes}` : ''}${unknownToolOutcomes > 0 ? ` · 状态未知 ${unknownToolOutcomes}` : ''} · 用户消息 ${indicators.userMessageCount}`;
	    const navItems = [
	      { id: `inbox-sec-completion-${safeId}`, label: '① 这次跑得怎么样' },
	      { id: `inbox-sec-log-chain-${safeId}`, label: '② 日志上下游链路' },
	      { id: `inbox-sec-runtime-${safeId}`, label: '③ 流程规则执行细节' },
	      { id: `inbox-sec-runtime-metrics-${safeId}`, label: '3.1 指标汇总', sub: true },
	      { id: `inbox-sec-runtime-rules-${safeId}`, label: '3.2 流程规则命中', sub: true },
	      { id: `inbox-sec-evidence-${safeId}`, label: '④ 原文回溯' },
	    ];
	    const navHtml = `<nav class="inbox-detail-nav" aria-label="跳到对应版块">${navItems.map((item) => `<a href="#${item.id}" class="${item.sub ? 'is-sub' : ''}" data-inbox-nav onclick="scrollInboxSectionIntoView('${item.id}', event)">${item.label}</a>`).join('')}</nav>`;
	    return `<article class="inbox-session-pane ${isActive ? 'is-active' : ''}" data-session-pane="${safeId}" data-session-search="${e(inboxSessionSearchText(session))}">
	      <div class="inbox-session-meta">
	        <span>Session <code>${e(session.sessionId)}</code></span>
	        <span>执行 ${e(inboxFormatDuration(session.sourceSessionDurationMs))}</span>
	        <span>入口 ${e(inboxEntrypointShort(session))}</span>
	        <span>调用段 ${session.invocationIds.length}</span>
	        <span>工具调用 ${indicators.toolCallCount}</span>
	        <a href="/conversations/${encodeURIComponent(session.threadId)}${lang === DEFAULT_LANG ? '' : `?lang=${lang}`}" onclick="event.stopPropagation()">${lang === 'zh' ? '查看对话任务' : 'Conversation tasks'}</a>
	      </div>
	      ${navHtml}
	      <template id="${flowTemplateId}">${inboxRenderSessionFlow(cardSkillName, session, siblings, flowSummaryText)}</template>
	      <section class="inbox-section" data-inbox-section="completion" id="inbox-sec-completion-${safeId}">
	        <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	          <h3>① 这次跑得怎么样</h3>
	          <span class="inbox-section-summary ${completionSummaryClass}">${e(completionSummaryText)}</span>
	          <span class="inbox-section-hint">${e(session.skillName)} 是否满足用户目标 / 是否符合 skill 用途 / 用户感受</span>
	          ${inboxRenderSessionReviewControl(session)}
	          <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">收起</button>
	        </header>
	        <div class="inbox-section-body">${inboxRenderSkillCompletion(session)}</div>
	      </section>
	      <section class="inbox-section" data-inbox-section="log-chain" id="inbox-sec-log-chain-${safeId}">
	        <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	          <h3>② 日志上下游链路</h3>
	          <span class="inbox-section-summary is-neutral">${e((session.sessionStory?.episodes?.length ?? 0) > 0 ? `${session.sessionStory?.episodes?.length ?? 0} 个用户目标切片` : '暂无链路')}</span>
	          <span class="inbox-section-hint">按日志还原用户目标切片、skill 片段和反馈归因</span>
	          <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">收起</button>
	        </header>
	        <div class="inbox-section-body">${inboxRenderEpisodeOverview(session)}</div>
	      </section>
	      <section class="inbox-section" data-inbox-section="runtime" id="inbox-sec-runtime-${safeId}">
	        <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	          <h3>③ 流程规则执行细节</h3>
	          <span class="inbox-section-summary ${runtimeSummaryClass}">${e(runtimeSummaryText)}</span>
	          <span class="inbox-section-hint">查看运行指标和能力定义链路</span>
	          <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">收起</button>
	        </header>
	        <div class="inbox-section-body">${inboxRenderSkillRuntime(session)}</div>
	      </section>
	      ${inboxRenderEvidence(session, evidenceSummaryText)}
	    </article>`;
	  };
	  const inboxDetail = (card: InboxSkillCard, index: number): string => {
	    const safeSkill = e(card.skillName);
	    const inboxSessionTabBadges = (session: ExperienceSessionSummary): string => {
	      const labels = inboxSessionAttentionFindingLabels(session);
	      if (labels.length === 0) return '';
	      return `<span class="inbox-session-tab-alerts" title="${e(labels.join(' / '))}">${labels.map((label) => `<span>${e(label)}</span>`).join('')}</span>`;
	    };
	    const sessionTabs = card.sessions.length > 0
	      ? `<div class="inbox-session-tabs" role="tablist" aria-label="切换 ${e(card.skillName)} 的调用记录">${card.sessions.map((s, i) => {
	          const label = inboxFormatSessionLabel(s);
	          const flowTemplateId = `inbox-flow-template-${e(s.id)}`;
	          const resolvedPriority = inboxResolvedPriority(s);
	          const priorityCls = resolvedPriority === 'review_first' ? 'is-priority-high' : resolvedPriority === 'sample_review' ? 'is-priority-medium' : 'is-priority-low';
	          return `<span class="inbox-session-tab-item" data-session-tab-item="${e(s.id)}" data-session-search="${e(inboxSessionSearchText(s))}">
	            <button type="button" class="inbox-session-tab ${priorityCls} ${i === 0 ? 'is-active' : ''}" data-session-tab="${e(s.id)}" onclick="selectInboxSessionTab('${safeSkill}', '${e(s.id)}', this)" title="${e(s.sessionId)}">${e(label)}</button>
	            <button type="button" class="inbox-session-flow-chip" onclick="openInboxSessionFlowPopover('${flowTemplateId}', this, event)" title="查看这条 session 的执行过程">查看过程</button>
	            ${inboxSessionTabBadges(s)}
	          </span>`;
	        }).join('')}</div>`
	      : '';
	    return `<article class="inbox-detail-pane ${index === 0 ? 'is-active' : ''}" data-inbox-detail="${safeSkill}">
	      ${inboxRenderSkillActionSummary(card.sessions)}
	      ${sessionTabs}
	      <div class="inbox-session-panes">${card.sessions.map((s, i) => inboxRenderSessionContent(card.skillName, s, i === 0)).join('')}</div>
	    </article>`;
	  };
	  const inboxCardListHtml = inboxSkillCards.length === 0
	    ? `<li class="inbox-card-empty">没有可展示的观测记录。</li>`
	    : inboxSkillCards.map((card, index) => inboxCard(card, index)).join('');
	  const inboxDetailListHtml = inboxSkillCards.length === 0
	    ? `<article class="inbox-detail-pane is-active inbox-detail-empty-pane">运行 omk observe ingest &lt;sessions-dir&gt; 后这里会展示完整复盘报告。</article>`
	    : inboxSkillCards.map((card, index) => inboxDetail(card, index)).join('');
	  const experienceSection = experience ? `
	    <section class="inbox-shell">
	      <header class="inbox-topbar">
	        <div class="inbox-topbar-meta">
	          <span>${inboxTotalCount} 条复盘</span>
	          <span>${reportSessionCount} 个 session · ${totalSkillInvocations} 次能力调用</span>
	          <span>最近 ingest ${e(latestSeenLabel)}</span>
	        </div>
	        <div class="inbox-chip-bar" role="tablist" aria-label="按状态筛选">
	          <button type="button" class="inbox-chip is-active" data-inbox-filter="all" onclick="setInboxFilter('all', this)">全部 ${inboxTotalCount}</button>
	          <button type="button" class="inbox-chip" data-inbox-filter="review_first" onclick="setInboxFilter('review_first', this)">要看一眼 ${inboxReviewFirstCount}</button>
	          <button type="button" class="inbox-chip" data-inbox-filter="sample_review" onclick="setInboxFilter('sample_review', this)">抽样 ${inboxSampleCount}</button>
	          <button type="button" class="inbox-chip" data-inbox-filter="reviewed" onclick="setInboxFilter('reviewed', this)">已处理 ${inboxReviewedCount}</button>
	        </div>
	        <div class="inbox-search-bar" role="search" aria-label="搜索复盘报告">
	          <label class="inbox-search-field">Skill 搜索
	            <input type="search" data-inbox-skill-search-input placeholder="输入 skill 名 / 目标 / 结论" oninput="applyInboxFilters()">
	          </label>
	          <label class="inbox-search-field">Session 搜索
	            <input type="search" data-inbox-session-search-input placeholder="输入 session id / 入口 / 时间 / 用户目标" oninput="applyInboxFilters()">
	          </label>
	          <button type="button" class="inbox-search-clear" onclick="clearInboxSearch()">清空</button>
	          <span class="inbox-search-count" data-inbox-search-count>${inboxTotalCount} 条复盘</span>
	        </div>
	      </header>
	      <div class="inbox-split">
	        <aside class="inbox-left" aria-label="观测记录列表">
	          <ul class="inbox-card-list" data-inbox-card-list>${inboxCardListHtml}</ul>
	        </aside>
	        <section class="inbox-right" aria-label="观测记录详情"><div class="inbox-no-results" data-inbox-no-results style="display:none">没有匹配的复盘记录。</div>${inboxDetailListHtml}</section>
	      </div>
	    </section>
  ` : '';
	  const empty = items.length === 0 && !experience
	    ? `<p style="color:var(--text-muted);margin-top:24px">${activeSkill ? `当前 skill 没有可展示的调用或过程发现：${e(activeSkill)}` : (lang === 'zh' ? '暂无 inbox item。运行 omk observe ingest <sessions-dir> 生成。' : 'No inbox items. Run omk observe ingest <sessions-dir> first.')}</p>`
	    : '';
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

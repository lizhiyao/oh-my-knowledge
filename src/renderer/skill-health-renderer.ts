/**
 * Skill 健康度日报 renderer (v0.18).
 *
 * 输入: SkillHealthReport (from skill-health-analyzer)
 * 输出: 完整 HTML 文档, 包含:
 *   - 顶部摘要 (trace 源水印 + overall 健康度色带)
 *   - 每 skill 一张 card, 复用 v0.17 A 的 ki-card 左右栏 (coverage + gap)
 *   - 死代码 KB section (所有 skill 都没访问过的 KB 文件)
 *
 * 设计复用:
 *   - layout.ts 的整体 HTML skeleton + CSS (ki-card / ki-col / ki-bar 全部现成)
 *   - 报告视觉和 eval HTML 保持一致，读者无学习成本切换
 */

import type { SkillHealth, SkillHealthReport } from '../observability/skill-health-analyzer.js';
import { confidenceOf, toolStabilityOf } from '../observability/skill-health-analyzer.js';
import type { Lang } from '../types/index.js';
import { COLORS, e, t } from './layout.js';
import { icon } from './icons.js';
import { reportShell } from './report-shell.js';


function fmtTimeRange(from: string, to: string): string {
  if (!from || !to) return '—';
  const fromDate = new Date(from).toISOString().split('T')[0];
  const toDate = new Date(to).toISOString().split('T')[0];
  return fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`;
}

/**
 * 数据来源水印 (spec §六 强制要求) + 低 N 可信度提醒。
 */
function renderWatermark(report: SkillHealthReport, lang: Lang): string {
  const { meta, overall } = report;
  const confidence = overall.confidence ?? confidenceOf(meta.segmentCount);
  const confCaveat = confidence !== 'high'
    ? `<div style="color:var(--text-faint);margin-top:6px">${lang === 'zh'
      ? `⚠ 样本量 ${meta.segmentCount} 段，可信度${confidence === 'underpowered' ? '不足' : '偏低'}，色带仅供参考`
      : `⚠ N=${meta.segmentCount} segments — ${confidence} confidence; band is indicative`}</div>`
    : '';
  const tracePath = e(meta.tracePath);
  const kbPath = meta.kbPath ? e(meta.kbPath) : '—';
  const warning = lang === 'zh'
    ? '本报告仅反映指定时间窗内观察到的 skill 使用情况，不代表 skill 的绝对质量，也不能替代 offline eval 的对照验证。'
    : 'Report reflects only observed skill usage in the given window. Does not imply absolute skill quality, does not replace offline eval.';

  return `<div class="rs-panel" style="background:var(--info-bg);font-size:12px;line-height:1.6">
    <div style="color:var(--text-secondary);margin-bottom:4px;font-weight:600">${lang === 'zh' ? '数据来源' : 'Source'}</div>
    <div style="color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px">trace: ${tracePath}<br>kb: ${kbPath}</div>
    <div style="color:var(--text-muted);margin-top:6px;font-style:italic">${warning}</div>
    ${confCaveat}
  </div>`;
}

/**
 * 每 skill 一张 card (复用 v0.17 A 的 ki-card 结构)。
 */
function renderSkillCard(skill: SkillHealth, variantColor: string, lang: Lang): string {
  const gap = skill.gap;
  const cov = skill.coverage;
  const gapPct = Math.round(gap.gapRate * 100);
  const weightedPct = Math.round(gap.weightedGapRate * 100);
  // Sample-size guard (legacy reports derive from segmentCount): an underpowered skill
  // (very few segments) must not render a hard red gap bar.
  const confidence = skill.confidence ?? confidenceOf(skill.segmentCount);
  const gapColor = confidence === 'underpowered'
    ? 'var(--text-faint)'
    : gapPct >= 30 ? 'var(--red)' : gapPct >= 10 ? 'var(--yellow)' : 'var(--green)';
  const covPct = cov ? Math.round(cov.fileCoverageRate * 100) : 0;
  const covColor = covPct >= 80 ? 'var(--green)' : covPct >= 50 ? 'var(--yellow)' : 'var(--red)';

  // ─── 左栏: 使用量 + coverage ─────────────────────
  const covInner = cov
    ? `
    <div class="ki-col-header">
      <span class="ki-col-title">${lang === 'zh' ? '知识使用' : 'Knowledge used'}</span>
      <span class="ki-col-value" style="color:${covColor}">${covPct}%</span>
    </div>
    <div class="ki-bar" role="progressbar" aria-valuenow="${covPct}" aria-valuemin="0" aria-valuemax="100" aria-label="${lang === 'zh' ? '知识使用' : 'Knowledge used'}">
      <div class="ki-bar-fill" style="width:${Math.max(2, covPct)}%;background:${covColor}"></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted)">
      ${cov.filesCovered} ${lang === 'zh' ? '命中' : 'hit'} · ${cov.filesTotal - cov.filesCovered} ${lang === 'zh' ? '未命中' : 'miss'} · ${cov.grepPatternsUsed} ${lang === 'zh' ? '次搜索' : 'searches'}
    </div>
    `
    : `<div style="color:var(--text-muted);font-size:12px">${lang === 'zh' ? '(未提供 KB, 跳过 coverage)' : '(KB not provided, coverage skipped)'}</div>`;

  // ─── 右栏: gap signals ────────────────────────
  const softShare = gapPct - weightedPct;
  const failureRatePct = Math.round(skill.toolFailureRate * 100);
  const resolvedToolCalls = skill.toolResolvedCount
    ?? Math.max(0, skill.toolCallCount - (skill.toolUnknownCount ?? 0));
  const cancelledToolCalls = skill.toolCancelledCount ?? 0;
  const comparableToolCalls = Math.max(0, resolvedToolCalls - cancelledToolCalls);
  const unknownToolCalls = skill.toolUnknownCount ?? Math.max(0, skill.toolCallCount - resolvedToolCalls);
  const stability = toolStabilityOf(skill.toolFailureRate, comparableToolCalls, skill.toolCallCount);
  const stabilityNote = stability === 'very-unstable'
    ? ` · <span style="color:var(--red)">${lang === 'zh' ? `失败率 ${failureRatePct}%,gap 可能是环境问题` : `failure rate ${failureRatePct}%, gap likely env issue`}</span>`
    : stability === 'unstable'
      ? ` · <span style="color:var(--yellow)">${lang === 'zh' ? `失败率 ${failureRatePct}%,gap 可能含噪声` : `failure rate ${failureRatePct}%, gap may be noisy`}</span>`
      : stability === 'unknown'
        ? ` · <span style="color:var(--text-faint)">${cancelledToolCalls > 0
          ? (lang === 'zh' ? '没有可比较结果，工具调用已取消' : 'no comparable outcomes; calls cancelled')
          : (lang === 'zh' ? '工具结果状态不可测' : 'tool outcomes unavailable')}</span>`
        : '';
  const outcomeEvidenceNote = stability === 'unknown'
    ? ''
    : cancelledToolCalls > 0 || unknownToolCalls > 0
      ? ` · <span style="color:var(--text-faint)">${lang === 'zh'
        ? `${comparableToolCalls}/${skill.toolCallCount} 次结果可比较${cancelledToolCalls > 0 ? `，${cancelledToolCalls} 次取消` : ''}`
        : `${comparableToolCalls}/${skill.toolCallCount} outcomes comparable${cancelledToolCalls > 0 ? `, ${cancelledToolCalls} cancelled` : ''}`}</span>`
      : comparableToolCalls > 0 && comparableToolCalls < 5
        ? ` · <span style="color:var(--text-faint)">${lang === 'zh'
          ? `仅 ${comparableToolCalls} 次结果，结论置信度低`
          : `only ${comparableToolCalls} outcomes, low confidence`}</span>`
        : '';
  const weightedHintBase = softShare >= 10
    ? `<strong>${lang === 'zh' ? '加权盲区' : 'weighted gap'} ${weightedPct}%</strong> · ${softShare}% ${lang === 'zh' ? '为软信号(建议复核)' : 'soft signals (review)'}`
    : `<strong>${lang === 'zh' ? '加权盲区' : 'weighted gap'} ${weightedPct}%</strong> · ${lang === 'zh' ? '以硬证据为主' : 'mostly hard evidence'}`;
  const confNote = confidence !== 'high'
    ? ` · <span style="color:var(--text-faint)">${lang === 'zh'
      ? `${skill.segmentCount} 段，可信度${confidence === 'underpowered' ? '不足，仅供参考' : '偏低'}`
      : `N=${skill.segmentCount}, ${confidence} confidence`}</span>`
    : '';
  const weightedHint = weightedHintBase + stabilityNote + outcomeEvidenceNote + confNote;
  const signalBadges = (Object.entries(gap.byType) as Array<[string, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const label = {
        failed_search: lang === 'zh' ? '搜索未命中' : 'Search miss',
        explicit_marker: lang === 'zh' ? '模型标记缺口' : 'Model-flagged gap',
        hedging: lang === 'zh' ? '表达不确定' : 'Hedging',
        repeated_failure: lang === 'zh' ? '反复未命中' : 'Repeated miss',
      }[k] ?? k;
      return `<span style="display:inline-block;padding:2px 8px;border-radius:var(--radius);background:var(--bg-card);font-size:var(--fs-micro);color:var(--text-secondary);margin:2px 4px 2px 0">${e(label)} × ${n}</span>`;
    })
    .join('');

  const gapInner = `
    <div class="ki-col-header">
      <span class="ki-col-title">${lang === 'zh' ? '知识盲区' : 'Knowledge gaps'}</span>
      <span class="ki-col-value" style="color:${gapColor}">${gapPct}%</span>
    </div>
    <div class="ki-bar" role="progressbar" aria-valuenow="${gapPct}" aria-valuemin="0" aria-valuemax="100" aria-label="${lang === 'zh' ? '知识盲区' : 'Knowledge gaps'}">
      <div class="ki-bar-fill" style="width:${Math.max(2, gapPct)}%;background:${gapColor}"></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${gap.samplesWithGap}/${gap.sampleCount} ${lang === 'zh' ? '段触发信号' : 'segments with signals'}</div>
    <div style="font-size:var(--fs-detail);color:var(--text-secondary);margin-bottom:8px">${weightedHint}</div>
    ${signalBadges ? `<div>${signalBadges}</div>` : ''}
  `;

  // 失败率 badge: 用 skill.stability 决定颜色
  const stabilityColor = stability === 'very-unstable'
    ? 'var(--red)'
    : stability === 'unstable'
      ? 'var(--yellow)'
      : 'var(--text-muted)';
  const failureLabel = skill.toolCallCount > 0 && comparableToolCalls === 0
    ? cancelledToolCalls > 0 && unknownToolCalls === 0
      ? `${cancelledToolCalls} ${lang === 'zh' ? '次取消' : 'cancelled'}`
      : cancelledToolCalls > 0
        ? `${cancelledToolCalls} ${lang === 'zh' ? '次取消' : 'cancelled'} · ${unknownToolCalls} ${lang === 'zh' ? '次状态未知' : 'unknown'}`
      : `${skill.toolCallCount} ${lang === 'zh' ? '次状态未知' : 'unknown outcomes'}`
    : comparableToolCalls > 0
      ? `${skill.toolFailureCount}/${comparableToolCalls} ${lang === 'zh' ? '失败' : 'failed'} (${failureRatePct}%)${cancelledToolCalls > 0 ? ` · ${cancelledToolCalls} ${lang === 'zh' ? '取消' : 'cancelled'}` : ''}`
    : `0 ${lang === 'zh' ? '次工具调用' : 'tool calls'}`;

  // ─── 成本/耗时行(第四轴,skill 维度聚合) ─────────
  // 旧 JSON (加 usage 字段前生成的) 缺此字段,降级为全 0
  const u = skill.usage ?? {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 0, tokenObservedSegmentCount: 0, tokenCoverage: 0, durationMs: 0, numTurns: 0,
    avgTokensPerSegment: 0, avgDurationMsPerSegment: 0,
  };
  const billableTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  const cachedTokens = (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
  const billK = (billableTokens / 1000).toFixed(1);
  const cachedK = (cachedTokens / 1000).toFixed(1);
  const durSec = (u.durationMs / 1000).toFixed(1);
  const avgDurSec = (u.avgDurationMsPerSegment / 1000).toFixed(1);
  const cachedSeg = cachedTokens > 0 ? ` + ${cachedK}k ${lang === 'zh' ? '缓存' : 'cached'}` : '';
  const tokenCoverage = u.tokenCoverage ?? 0;
  const tokenText = tokenCoverage > 0
    ? `${billK}k tokens${cachedSeg}${tokenCoverage < 1 ? ` (${Math.round(tokenCoverage * 100)}% ${lang === 'zh' ? '覆盖' : 'coverage'})` : ''}`
    : lang === 'zh' ? 'tokens —（未观测）' : 'tokens — (unobserved)';
  const usageLine = `${tokenText} · ${durSec}s (${lang === 'zh' ? '均' : 'avg'} ${avgDurSec}s/${lang === 'zh' ? '段' : 'seg'}) · ${u.numTurns} ${lang === 'zh' ? '轮次' : 'turns'}`;

  // ─── Card 结构 ───────────────────────────────
  return `
  <div class="ki-card" style="border-left:3px solid ${variantColor}">
    <div class="ki-card-header">
      <span class="ki-card-title">${e(skill.skillName)}</span>
      <div class="ki-card-meta">
        ${skill.segmentCount} <span data-i18n="analysesSegs">${t('analysesSegs', lang)}</span> · <span style="color:${stabilityColor}">${failureLabel}</span>
        · <a href="/skill-trend/${encodeURIComponent(skill.skillName)}${lang === 'zh' ? '' : `?lang=${lang}`}" data-i18n="viewTrendLink" style="color:var(--accent);text-decoration:none;font-size:11px">${t('viewTrendLink', lang)}</a>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 0 8px;border-bottom:1px solid var(--border);margin-bottom:10px">
      ${usageLine}
    </div>
    <div class="ki-columns">
      <div class="ki-col">${covInner}</div>
      <div class="ki-col">${gapInner}</div>
    </div>
  </div>
  `.trim();
}

/**
 * 死代码 KB section (所有 skill 都没访问过的 KB 文件)。
 * 这是 skill-health 的独家洞察——告诉 KB 维护者哪些文件在生产中是死代码。
 */
function renderDeadKbSection(report: SkillHealthReport, lang: Lang): string {
  const skills = Object.values(report.bySkill);
  if (skills.length === 0) return '';
  const coverages = skills.map((s) => s.coverage).filter((c): c is NonNullable<typeof c> => c !== null);
  if (coverages.length === 0) return '';

  // 所有 skill 的 accessed 集合取并集
  const accessedSet = new Set<string>();
  for (const cov of coverages) {
    for (const entry of cov.entries) {
      if (entry.accessed) accessedSet.add(entry.path);
    }
  }
  const allEntries = coverages[0]?.entries ?? [];
  const dead = allEntries.filter((entry) => !accessedSet.has(entry.path));
  if (dead.length === 0) return '';

  const title = lang === 'zh' ? '死代码 KB (零访问)' : 'Dead KB (never accessed)';
  const desc = lang === 'zh'
    ? `本期共 ${allEntries.length} 个 KB 文件,其中 <strong>${dead.length}</strong> 个在所有 skill 里都没被访问过。建议审视这些文件是否仍有存在价值,或者测评集 / 生产使用场景是否还没覆盖到它们。`
    : `Of ${allEntries.length} KB files this window, <strong>${dead.length}</strong> were never accessed by any skill. Review these for relevance or extend coverage.`;
  const rows = dead.slice(0, 30).map((entry) => {
    const typeTag = `<span style="font-size:10px;padding:1px 4px;border-radius:2px;background:var(--bg-card);color:var(--text-muted);margin-left:4px">${e(entry.type)}</span>`;
    const lines = entry.lineCount ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px">${entry.lineCount}L</span>` : '';
    return `<div style="padding:4px 0;font-size:12px;color:var(--text-muted);text-decoration:line-through;opacity:0.7">✗ <span style="word-break:break-all">${e(entry.path)}</span>${typeTag}${lines}</div>`;
  }).join('');
  const overflow = dead.length > 30
    ? `<div style="font-size:var(--fs-micro);color:var(--text-muted);margin-top:6px">${lang === 'zh' ? '另' : '+'} ${dead.length - 30} ${lang === 'zh' ? '条未展示' : 'more'}</div>`
    : '';

  return `
  <section style="margin-top:28px;padding-top:20px;border-top:1px solid var(--border)">
    <h2>${title}</h2>
    <p class="ki-desc">${desc}</p>
    <div class="ki-card">
      ${rows}
      ${overflow}
    </div>
  </section>
  `.trim();
}

/**
 * 主入口: 生成完整 HTML。
 */
export function renderSkillHealthReport(report: SkillHealthReport, lang: Lang = 'zh'): string {
  const zh = lang === 'zh';
  const { meta, overall } = report;
  const confidence = overall.confidence ?? confidenceOf(meta.segmentCount);
  // 整体健康分 = (1 - 加权盲区) × 100；underpowered 时不给硬分。
  const score = confidence === 'underpowered' ? null : Math.round((1 - overall.weightedGapRate) * 100);
  const scoreLabel = score == null
    ? (zh ? '样本不足' : 'Low N')
    : overall.healthBand === 'green' ? (zh ? '健康' : 'Healthy')
      : overall.healthBand === 'yellow' ? (zh ? '待观察' : 'Watch')
        : (zh ? '需关注' : 'Attention');

  const skillsSorted = Object.values(report.bySkill).sort((a, b) => b.segmentCount - a.segmentCount);
  const cards = skillsSorted
    .map((skill, i) => renderSkillCard(skill, COLORS[i % COLORS.length], lang))
    .join('\n');

  const statsBar = `<div class="rs-stats">
    <div class="rs-stat rs-stat--total"><span class="rs-stat-num">${meta.sessionCount}</span><span class="rs-stat-label">${zh ? '会话' : 'Sessions'}</span></div>
    <div class="rs-stat rs-stat--total"><span class="rs-stat-num">${meta.segmentCount}</span><span class="rs-stat-label">${zh ? '段' : 'Segments'}</span></div>
    <div class="rs-stat rs-stat--total"><span class="rs-stat-num">${meta.toolCallCount}</span><span class="rs-stat-label">${zh ? '工具调用' : 'Tool calls'}</span></div>
    <div class="rs-stat ${overall.weightedGapRate >= 0.3 ? 'rs-stat--fail' : overall.weightedGapRate >= 0.1 ? 'rs-stat--warn' : 'rs-stat--pass'}"><span class="rs-stat-num">${Math.round(overall.weightedGapRate * 100)}%</span><span class="rs-stat-label">${zh ? '加权盲区' : 'Weighted gap'}</span></div>
  </div>`;
  const ingestion = meta.ingestion;
  const ingestionNotice = ingestion && (
    ingestion.malformedRecordCount > 0
    || ingestion.ignoredValueCount > 0
    || ingestion.unknownEventCount > 0
  )
    ? `<div style="margin:12px 0;padding:10px 12px;border:1px solid var(--yellow);border-radius:8px;background:var(--yellow-bg);color:var(--text-secondary);font-size:13px">
        <strong style="color:var(--yellow)">${zh ? '观测输入需要复核' : 'Observation input needs review'}</strong>
        <span style="margin-left:8px">${zh
          ? `${ingestion.malformedRecordCount} 条格式损坏记录，${ingestion.ignoredValueCount} 个非对象值，${ingestion.unknownEventCount} 个未识别事件。`
          : `${ingestion.malformedRecordCount} malformed records, ${ingestion.ignoredValueCount} non-object values, ${ingestion.unknownEventCount} unrecognized events.`}</span>
      </div>`
    : '';
  const timestampedSegmentCount = meta.timestampedSegmentCount
    ?? (meta.timeRange.from && meta.timeRange.to ? meta.segmentCount : 0);
  const timestampCoverage = meta.timestampCoverage
    ?? (meta.segmentCount > 0 ? timestampedSegmentCount / meta.segmentCount : 1);
  const excludedUntimestampedSegmentCount = meta.excludedUntimestampedSegmentCount ?? 0;
  const timestampNotice = timestampCoverage < 1 || excludedUntimestampedSegmentCount > 0
    ? `<div style="margin:12px 0;padding:10px 12px;border:1px solid var(--yellow);border-radius:8px;background:var(--yellow-bg);color:var(--text-secondary);font-size:13px">
        <strong style="color:var(--yellow)">${zh ? '时间范围不完整' : 'Incomplete time coverage'}</strong>
        <span style="margin-left:8px">${zh
          ? `${meta.segmentCount} 个入选片段中，${timestampedSegmentCount} 个具有可观测时间；时间筛选另排除了 ${excludedUntimestampedSegmentCount} 个无时间戳片段。`
          : `${timestampedSegmentCount} of ${meta.segmentCount} selected segments have observed timestamps; time filtering excluded ${excludedUntimestampedSegmentCount} additional untimestamped segments.`}</span>
      </div>`
    : '';

  const body = [
    statsBar,
    ingestionNotice,
    timestampNotice,
    renderWatermark(report, lang),
    `<div class="rs-panel">
      <div class="rs-panel-title">${zh ? '各 skill 健康度' : 'Per-skill health'} <small>${zh ? '按使用量降序' : 'sorted by usage'}</small></div>
      ${cards || `<div class="rs-empty">${zh ? '本期无 skill 数据' : 'No skill data'}</div>`}
    </div>`,
    renderDeadKbSection(report, lang),
  ].filter(Boolean).join('\n');

  return reportShell({
    dim: 'observe',
    icon: '👁',
    kindTitle: zh ? '生产观察报告' : 'Observe Report',
    skillName: zh ? 'Skill 健康度日报' : 'Skill Health Daily',
    metaItems: [
      `${icon('clock', { size: 13 })} ${fmtTimeRange(meta.timeRange.from, meta.timeRange.to)}`,
      `${icon('calendar', { size: 13 })} ${new Date(meta.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
    ],
    score,
    scoreLabel,
    backHref: `/${lang === 'zh' ? '' : '?lang=en'}`,
    backLabel: zh ? '返回工作台' : 'Back to dashboard',
    body,
  }, lang);
}

/**
 * Skill 健康度日报 renderer (v0.18).
 *
 * 输入: SkillHealthReport (from production-analyzer)
 * 输出: 完整 HTML 文档, 包含:
 *   - 顶部摘要 (trace 源水印 + overall 健康度色带)
 *   - 每 skill 一张 card, 复用 v0.17 A 的 ki-card 左右栏 (coverage + gap)
 *   - 死代码 KB section (所有 skill 都没访问过的 KB 文件)
 *
 * 设计复用:
 *   - layout.ts 的整体 HTML skeleton + CSS (ki-card / ki-col / ki-bar 全部现成)
 *   - 报告视觉和 bench HTML 保持一致, 读者无学习成本切换
 */

import type { SkillHealth, SkillHealthReport } from '../observability/production-analyzer.js';
import type { Lang } from '../types.js';
import { COLORS, e, layout } from './layout.js';

const HEALTH_BAND_COLOR: Record<'green' | 'yellow' | 'red', string> = {
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  red: 'var(--red)',
};

const HEALTH_BAND_LABEL: Record<'green' | 'yellow' | 'red', { zh: string; en: string }> = {
  green: { zh: '健康', en: 'Healthy' },
  yellow: { zh: '待观察', en: 'Watch' },
  red: { zh: '需关注', en: 'Attention needed' },
};

function fmtPct(rate: number, digits = 0): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

function fmtTimeRange(from: string, to: string): string {
  if (!from || !to) return '—';
  const fromDate = new Date(from).toISOString().split('T')[0];
  const toDate = new Date(to).toISOString().split('T')[0];
  return fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`;
}

/**
 * 顶部摘要 + 水印 (spec §六 强制要求)。
 */
function renderHeader(report: SkillHealthReport, lang: Lang): string {
  const { meta, overall } = report;
  const bandColor = HEALTH_BAND_COLOR[overall.healthBand];
  const bandLabel = HEALTH_BAND_LABEL[overall.healthBand][lang === 'zh' ? 'zh' : 'en'];
  const tracePath = e(meta.tracePath);
  const kbPath = meta.kbPath ? e(meta.kbPath) : '—';
  const timeRange = fmtTimeRange(meta.timeRange.from, meta.timeRange.to);
  const warning = lang === 'zh'
    ? '本报告仅反映指定时间窗内观察到的 skill 使用情况,不代表 skill 的绝对质量,也不能替代 offline eval 的对照验证。'
    : 'Report reflects only observed skill usage in the given window. Does not imply absolute skill quality, does not replace offline eval.';

  return `
  <h1>${lang === 'zh' ? 'Skill 健康度日报' : 'Skill Health Daily'}</h1>
  <p class="subtitle">${lang === 'zh' ? 'omk · 生产观察' : 'omk · Production Observability'}</p>

  <div class="cards" style="margin-bottom:20px">
    <div class="card" style="flex:0 0 auto;min-width:160px;border-left:4px solid ${bandColor}">
      <div class="card-label">${lang === 'zh' ? '整体健康度' : 'Overall health'}</div>
      <div class="card-value" style="color:${bandColor}">${bandLabel}</div>
      <div class="card-sub">${lang === 'zh' ? '加权盲区' : 'weighted gap'} ${fmtPct(overall.weightedGapRate, 1)} · ${lang === 'zh' ? '原始盲区' : 'raw gap'} ${fmtPct(overall.gapRate, 1)}</div>
    </div>
    <div class="card">
      <div class="card-label">${lang === 'zh' ? '会话 / 段 / 工具调用' : 'Sessions / Segments / Tool calls'}</div>
      <div class="card-value" style="font-size:18px">${meta.sessionCount} / ${meta.segmentCount} / ${meta.toolCallCount}</div>
      <div class="card-sub">${lang === 'zh' ? '工具失败率' : 'tool fail rate'} ${fmtPct(meta.toolFailureRate, 1)} · ${meta.messageCount.toLocaleString()} ${lang === 'zh' ? '条消息' : 'messages'}</div>
    </div>
    <div class="card">
      <div class="card-label">${lang === 'zh' ? '时间窗' : 'Time window'}</div>
      <div class="card-value" style="font-size:18px">${timeRange}</div>
      <div class="card-sub">${lang === 'zh' ? '生成于' : 'generated'} ${new Date(meta.generatedAt).toISOString().split('T')[0]}</div>
    </div>
  </div>

  <div style="padding:10px 14px;background:var(--info-bg);border-left:3px solid var(--accent);border-radius:var(--radius);margin-bottom:20px;font-size:12px;line-height:1.6">
    <div style="color:var(--text-secondary);margin-bottom:4px"><strong>${lang === 'zh' ? '水印' : 'Watermark'}</strong> (spec §六)</div>
    <div style="color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px">
      trace: ${tracePath}<br>
      kb: ${kbPath}
    </div>
    <div style="color:var(--text-muted);margin-top:6px;font-style:italic">${warning}</div>
  </div>
  `.trim();
}

/**
 * 每 skill 一张 card (复用 v0.17 A 的 ki-card 结构)。
 */
function renderSkillCard(skill: SkillHealth, variantColor: string, lang: Lang): string {
  const gap = skill.gap;
  const cov = skill.coverage;
  const gapPct = Math.round(gap.gapRate * 100);
  const weightedPct = Math.round(gap.weightedGapRate * 100);
  const gapColor = gapPct >= 30 ? 'var(--red)' : gapPct >= 10 ? 'var(--yellow)' : 'var(--green)';
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
  const instabilityNote = skill.stability === 'very-unstable'
    ? ` · <span style="color:var(--red)">${lang === 'zh' ? `失败率 ${failureRatePct}%,gap 可能是环境问题` : `failure rate ${failureRatePct}%, gap likely env issue`}</span>`
    : skill.stability === 'unstable'
      ? ` · <span style="color:var(--yellow)">${lang === 'zh' ? `失败率 ${failureRatePct}%,gap 可能含噪声` : `failure rate ${failureRatePct}%, gap may be noisy`}</span>`
      : '';
  const weightedHintBase = softShare >= 10
    ? `<strong>${lang === 'zh' ? '加权盲区' : 'weighted gap'} ${weightedPct}%</strong> · ${softShare}% ${lang === 'zh' ? '为软信号(建议复核)' : 'soft signals (review)'}`
    : `<strong>${lang === 'zh' ? '加权盲区' : 'weighted gap'} ${weightedPct}%</strong> · ${lang === 'zh' ? '以硬证据为主' : 'mostly hard evidence'}`;
  const weightedHint = weightedHintBase + instabilityNote;
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
  const stabilityColor = skill.stability === 'very-unstable'
    ? 'var(--red)'
    : skill.stability === 'unstable'
      ? 'var(--yellow)'
      : 'var(--text-muted)';
  const failureLabel = skill.toolCallCount > 0
    ? `${skill.toolFailureCount}/${skill.toolCallCount} ${lang === 'zh' ? '失败' : 'failed'} (${failureRatePct}%)`
    : `0 ${lang === 'zh' ? '次工具调用' : 'tool calls'}`;

  // ─── Card 结构 ───────────────────────────────
  return `
  <div class="ki-card" style="border-left:3px solid ${variantColor}">
    <div class="ki-card-header">
      <span class="ki-card-title">${e(skill.skillName)}</span>
      <div class="ki-card-meta">
        ${skill.segmentCount} ${lang === 'zh' ? '段' : 'segments'} · <span style="color:${stabilityColor}">${failureLabel}</span>
      </div>
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
  const title = lang === 'zh' ? 'Skill 健康度日报' : 'Skill Health Daily';
  // 按 segmentCount 降序排(使用量大的 skill 在前)
  const skillsSorted = Object.values(report.bySkill).sort((a, b) => b.segmentCount - a.segmentCount);
  const cards = skillsSorted
    .map((skill, i) => renderSkillCard(skill, COLORS[i % COLORS.length], lang))
    .join('\n');

  const body = [
    renderHeader(report, lang),
    `<section style="margin-top:28px">
      <h2>${lang === 'zh' ? '各 skill 健康度' : 'Per-skill health'}</h2>
      <p class="ki-desc">${lang === 'zh' ? '按使用量降序。每个 skill 的 coverage 和 gap 独立统计。' : 'Sorted by usage. Coverage and gap are independently computed per skill.'}</p>
      ${cards}
    </section>`,
    renderDeadKbSection(report, lang),
  ].filter(Boolean).join('\n');

  return layout(title, body, lang);
}

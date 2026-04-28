import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderRunDetail, renderEachRunDetail, renderTrendsPage } from '../renderer/html-renderer.js';
import { renderSkillHealthReport } from '../renderer/skill-health-renderer.js';
import { DEFAULT_LANG, t, layout } from '../renderer/layout.js';
import type { Lang } from '../types/index.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from './job-store.js';
import { createFileStore, queryJob, queryJobList, queryRun, queryRunList, queryTrend } from './report-store.js';
import type { JobStore, ReportStore } from '../types/index.js';
import type { SkillHealthReport } from '../observability/skill-health-analyzer.js';
import type { AddressInfo } from 'node:net';

const DEFAULT_PORT = 7799;
const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');
const DEFAULT_ANALYSES_DIR = join(homedir(), '.oh-my-knowledge', 'analyses');

interface ReportServerOptions {
  port?: number;
  reportsDir?: string;
  analysesDir?: string;
  jobsDir?: string;
  store?: ReportStore;
  jobStore?: JobStore;
}

interface AnalysisListItem {
  id: string;
  generatedAt: string;
  sessionCount: number;
  segmentCount: number;
  skillCount: number;
  healthBand: 'green' | 'yellow' | 'red';
}

function listAnalyses(dir: string): AnalysisListItem[] {
  if (!existsSync(dir)) return [];
  const items: AnalysisListItem[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SkillHealthReport;
      if (!data.meta || !data.overall) continue;
      items.push({
        id: file.replace(/\.json$/, ''),
        generatedAt: data.meta.generatedAt,
        sessionCount: data.meta.sessionCount,
        segmentCount: data.meta.segmentCount,
        skillCount: Object.keys(data.bySkill || {}).length,
        healthBand: data.overall.healthBand,
      });
    } catch { /* skip corrupt */ }
  }
  // 最新在前
  items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  return items;
}

function loadAnalysis(dir: string, id: string): SkillHealthReport | null {
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SkillHealthReport;
  } catch {
    return null;
  }
}

interface SkillTrendPoint {
  analysisId: string;
  generatedAt: string;
  gapRate: number;
  weightedGapRate: number;
  failureRate: number;
  coverageRate: number | null;
  /** input + output only, 计费主成本 */
  billableTokens: number;
  /** cache_read + cache_creation, 通常远大于 billable 但计费权重低 */
  cachedTokens: number;
  totalTokens: number;
  avgTokensPerSegment: number;
  durationMs: number;
  segmentCount: number;
  stability: 'stable' | 'unstable' | 'very-unstable';
}

interface SkillTrendResult {
  skillName: string;
  points: SkillTrendPoint[];
}

/**
 * 扫 analyses/ 所有 JSON,按 skillName 过滤,按时间排序成 trend points。
 */
function querySkillTrend(dir: string, skillName: string): SkillTrendResult {
  const items = listAnalyses(dir);
  const points: SkillTrendPoint[] = [];
  for (const it of items) {
    const report = loadAnalysis(dir, it.id);
    if (!report) continue;
    const h = report.bySkill[skillName];
    if (!h) continue;
    // 旧格式 (加 usage 字段前的 analysis) 用 safe access,缺字段降级为 0/undefined
    const u = h.usage;
    const billable = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
    const cached = (u?.cacheReadTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
    points.push({
      analysisId: it.id,
      generatedAt: report.meta.generatedAt,
      gapRate: h.gap?.gapRate ?? 0,
      weightedGapRate: h.gap?.weightedGapRate ?? 0,
      failureRate: h.toolFailureRate ?? 0,
      coverageRate: h.coverage?.fileCoverageRate ?? null,
      billableTokens: billable,
      cachedTokens: cached,
      totalTokens: u?.totalTokens ?? 0,
      avgTokensPerSegment: u?.avgTokensPerSegment ?? 0,
      durationMs: u?.durationMs ?? 0,
      segmentCount: h.segmentCount ?? 0,
      stability: h.stability ?? 'stable',
    });
  }
  // 最旧在前,便于折线图从左到右展示时间序列
  points.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return { skillName, points };
}

interface SkillDiffRow {
  skillName: string;
  presence: 'both' | 'only-from' | 'only-to';
  fromGap?: number;
  toGap?: number;
  deltaGap?: number;
  fromFailure?: number;
  toFailure?: number;
  deltaFailure?: number;
  fromCoverage?: number | null;
  toCoverage?: number | null;
  deltaCoverage?: number | null;
  fromSegments?: number;
  toSegments?: number;
  deltaSegments?: number;
}

interface SkillDiffResult {
  fromId: string;
  toId: string;
  fromAt: string;
  toAt: string;
  rows: SkillDiffRow[];
}

/**
 * 比较两份 skill health report. `from` 通常是较早的,`to` 是较晚的;
 * 对于每个 skill, 显示前后值和 delta. 缺失一侧时 presence 标记。
 */
function querySkillDiff(dir: string, fromId: string, toId: string): SkillDiffResult | null {
  const from = loadAnalysis(dir, fromId);
  const to = loadAnalysis(dir, toId);
  if (!from || !to) return null;
  const allSkills = new Set<string>([...Object.keys(from.bySkill), ...Object.keys(to.bySkill)]);
  const rows: SkillDiffRow[] = [];
  for (const skill of allSkills) {
    const f = from.bySkill[skill];
    const t = to.bySkill[skill];
    if (f && t) {
      rows.push({
        skillName: skill,
        presence: 'both',
        fromGap: f.gap.weightedGapRate,
        toGap: t.gap.weightedGapRate,
        deltaGap: t.gap.weightedGapRate - f.gap.weightedGapRate,
        fromFailure: f.toolFailureRate,
        toFailure: t.toolFailureRate,
        deltaFailure: t.toolFailureRate - f.toolFailureRate,
        fromCoverage: f.coverage?.fileCoverageRate ?? null,
        toCoverage: t.coverage?.fileCoverageRate ?? null,
        deltaCoverage: (f.coverage?.fileCoverageRate != null && t.coverage?.fileCoverageRate != null)
          ? t.coverage.fileCoverageRate - f.coverage.fileCoverageRate
          : null,
        fromSegments: f.segmentCount,
        toSegments: t.segmentCount,
        deltaSegments: t.segmentCount - f.segmentCount,
      });
    } else if (f) {
      rows.push({ skillName: skill, presence: 'only-from', fromGap: f.gap.weightedGapRate, fromFailure: f.toolFailureRate, fromCoverage: f.coverage?.fileCoverageRate ?? null, fromSegments: f.segmentCount });
    } else if (t) {
      rows.push({ skillName: skill, presence: 'only-to', toGap: t.gap.weightedGapRate, toFailure: t.toolFailureRate, toCoverage: t.coverage?.fileCoverageRate ?? null, toSegments: t.segmentCount });
    }
  }
  // 按 deltaGap 绝对值倒序 (变化大的在前,缺失的放最后)
  rows.sort((a, b) => {
    const aDelta = a.presence === 'both' ? Math.abs(a.deltaGap!) : -1;
    const bDelta = b.presence === 'both' ? Math.abs(b.deltaGap!) : -1;
    return bDelta - aDelta;
  });
  return { fromId, toId, fromAt: from.meta.generatedAt, toAt: to.meta.generatedAt, rows };
}

function fmtDelta(d: number | null | undefined, isPercent = true): string {
  if (d == null) return '—';
  const pct = isPercent ? d * 100 : d;
  const sign = pct > 0 ? '+' : '';
  const color = Math.abs(pct) < 1 ? '#888' : pct > 0 ? '#dc2626' : '#16a34a';
  return `<span style="color:${color}">${sign}${pct.toFixed(isPercent ? 1 : 0)}${isPercent ? '%' : ''}</span>`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

function renderSkillDiffPage(diff: SkillDiffResult, lang: Lang = DEFAULT_LANG): string {
  const { fromId, toId, fromAt, toAt, rows } = diff;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const rowHtml = rows.map((r) => {
    const tag = r.presence === 'only-from' ? `<span style="color:var(--green);font-size:10px;padding:1px 6px;background:var(--green-bg);border-radius:3px" data-i18n="diffTagRemoved">${t('diffTagRemoved', lang)}</span>`
      : r.presence === 'only-to' ? `<span style="color:var(--accent);font-size:10px;padding:1px 6px;background:var(--info-bg);border-radius:3px" data-i18n="diffTagNew">${t('diffTagNew', lang)}</span>`
      : '';
    return `<tr>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${r.skillName} ${tag}</td>
      <td style="padding:8px 10px;text-align:right">${r.fromSegments ?? '—'} → ${r.toSegments ?? '—'} ${r.presence === 'both' ? `(${fmtDelta(r.deltaSegments, false)})` : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromGap)} → ${fmtPct(r.toGap)} ${r.presence === 'both' ? fmtDelta(r.deltaGap) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromFailure)} → ${fmtPct(r.toFailure)} ${r.presence === 'both' ? fmtDelta(r.deltaFailure) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromCoverage)} → ${fmtPct(r.toCoverage)} ${r.presence === 'both' && r.deltaCoverage != null ? fmtDelta(r.deltaCoverage) : ''}</td>
    </tr>`;
  }).join('');
  const body = `
    <main style="max-width:1000px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px">
        <a href="/analyses${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('backToAnalyses', lang)}</a>
        <a href="/analyses/${encodeURIComponent(fromId)}${langQ}" data-i18n="diffNavFrom" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('diffNavFrom', lang)}</a>
        <a href="/analyses/${encodeURIComponent(toId)}${langQ}" data-i18n="diffNavTo" style="color:var(--accent);text-decoration:none">${t('diffNavTo', lang)}</a>
      </nav>
      <h1 data-i18n="skillDiffHeading" style="font-size:20px;margin:8px 0">${t('skillDiffHeading', lang)}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        <span data-i18n="diffNavFrom">${t('diffNavFrom', lang)}</span> <code>${fromId}</code> (${fromAt.slice(0, 19).replace('T', ' ')}) → <span data-i18n="diffNavTo">${t('diffNavTo', lang)}</span> <code>${toId}</code> (${toAt.slice(0, 19).replace('T', ' ')})<br/>
        <span data-i18n="diffSortHint">${t('diffSortHint', lang)}</span>
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSkill">${t('diffColSkill', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSegments">${t('diffColSegments', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColWeightedGap">${t('diffColWeightedGap', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColFailureRate">${t('diffColFailureRate', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColCoverage">${t('diffColCoverage', lang)}</th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </main>`;
  return layout(t('skillDiffHeading', lang), body, lang);
}

function renderSkillTrendPage(trend: SkillTrendResult, lang: Lang = DEFAULT_LANG): string {
  const { skillName, points } = trend;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  if (points.length === 0) {
    const emptyBody = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/analyses${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${skillName}</h1>
      <p style="color:var(--text-muted)" data-i18n="noTrendData">${t('noTrendData', lang)}</p>
    </main>`;
    return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, emptyBody, lang);
  }
  // SVG 折线图: gapRate 主线 + failureRate 辅线, X 轴时间序
  const W = 760, H = 200, PAD = 40;
  const toX = (i: number) => points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const toY = (v: number) => H - PAD - v * (H - 2 * PAD);
  const pathOf = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate') => {
    const usable = points.map((p, i) => ({ x: toX(i), y: p[key] ?? null }));
    let d = '';
    for (const pt of usable) {
      if (pt.y == null) continue;
      d += d ? ` L ${pt.x} ${toY(pt.y as number)}` : `M ${pt.x} ${toY(pt.y as number)}`;
    }
    return d;
  };
  const dots = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate', color: string) =>
    points.map((p, i) => p[key] == null ? '' : `<circle cx="${toX(i)}" cy="${toY(p[key] as number)}" r="3" fill="${color}"/>`).join('');
  const yTicks = [0, 0.5, 1.0].map((v) => `<g><line x1="${PAD}" y1="${toY(v)}" x2="${W - PAD}" y2="${toY(v)}" stroke="var(--border)"/><text x="${PAD - 6}" y="${toY(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${Math.round(v * 100)}%</text></g>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
    ${yTicks}
    <path d="${pathOf('gapRate')}" stroke="#f87171" stroke-width="2" fill="none"/>
    <path d="${pathOf('weightedGapRate')}" stroke="#fbbf24" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
    <path d="${pathOf('failureRate')}" stroke="#a78bfa" stroke-width="2" fill="none"/>
    <path d="${pathOf('coverageRate')}" stroke="#4ade80" stroke-width="2" fill="none"/>
    ${dots('gapRate', '#f87171')}${dots('weightedGapRate', '#fbbf24')}${dots('failureRate', '#a78bfa')}${dots('coverageRate', '#4ade80')}
  </svg>`;
  const legend = `<div style="margin:12px 0;font-size:12px;color:var(--text-secondary)">
    <span style="color:#f87171">● <span data-i18n="trendLegendGap">${t('trendLegendGap', lang)}</span></span> ·
    <span style="color:#fbbf24">◆ <span data-i18n="trendLegendWeighted">${t('trendLegendWeighted', lang)}</span></span> ·
    <span style="color:#a78bfa">● <span data-i18n="trendLegendFailure">${t('trendLegendFailure', lang)}</span></span> ·
    <span style="color:#4ade80">● <span data-i18n="trendLegendCoverage">${t('trendLegendCoverage', lang)}</span></span>
  </div>`;
  const rows = points.map((p) => `<tr>
    <td style="padding:6px 10px;font-family:ui-monospace,monospace;font-size:12px"><a href="/analyses/${encodeURIComponent(p.analysisId)}${langQ}" style="color:var(--accent);text-decoration:none">${p.generatedAt.slice(0, 19).replace('T', ' ')}</a></td>
    <td style="padding:6px 10px;text-align:right">${p.segmentCount}</td>
    <td style="padding:6px 10px;text-align:right;color:#f87171">${Math.round(p.gapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#fbbf24">${Math.round(p.weightedGapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#a78bfa">${Math.round(p.failureRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#4ade80">${p.coverageRate == null ? '—' : Math.round(p.coverageRate * 100) + '%'}</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px" title="input+output only; cache 分开计">${(p.billableTokens / 1000).toFixed(1)}k</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${(p.durationMs / 1000).toFixed(1)}s</td>
  </tr>`).join('');
  const subtitle = `${points.length} <span data-i18n="trendNPoints">${t('trendNPoints', lang)}</span> · <span data-i18n="trendEarliest">${t('trendEarliest', lang)}</span> ${points[0].generatedAt.slice(0, 10)} · <span data-i18n="trendLatest">${t('trendLatest', lang)}</span> ${points[points.length - 1].generatedAt.slice(0, 10)}`;
  const body = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px"><a href="/analyses${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${skillName}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${subtitle}</div>
      ${svg}
      ${legend}
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTimestamp">${t('trendColTimestamp', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColSegs">${t('trendColSegs', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColGap">${t('trendColGap', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColWeighted">${t('trendColWeighted', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColFailure">${t('trendColFailure', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColCoverage">${t('trendColCoverage', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTokens">${t('trendColTokens', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColDuration">${t('trendColDuration', lang)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>`;
  return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, body, lang);
}

function renderAnalysisList(items: AnalysisListItem[], lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const body = items.length === 0
    ? `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/${langQ}" data-i18n="backToEvalReports" style="color:var(--accent);text-decoration:none">${t('backToEvalReports', lang)}</a></nav>
      <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
      <div style="color:var(--text-muted);padding:16px" data-i18n="noAnalyses">${t('noAnalyses', lang)}</div>
    </main>`
    : (() => {
      const rows = items.map((it) => {
        const badgeColor = it.healthBand === 'red' ? 'var(--red)' : it.healthBand === 'yellow' ? 'var(--yellow)' : 'var(--green)';
        const enc = encodeURIComponent(it.id);
        return `<li style="padding:10px 14px;border-bottom:1px solid var(--border);list-style:none;display:flex;align-items:center;gap:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="from" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesFromLabel">${t('analysesFromLabel', lang)}</span></label>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="to" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesToLabel">${t('analysesToLabel', lang)}</span></label>
          <a href="/analyses/${enc}${langQ}" style="color:var(--accent);text-decoration:none;flex:1;font-family:ui-monospace,monospace">${it.id}</a>
          <span style="color:var(--text-muted);font-size:12px">${it.sessionCount} <span data-i18n="analysesSessions">${t('analysesSessions', lang)}</span> · ${it.segmentCount} <span data-i18n="analysesSegs">${t('analysesSegs', lang)}</span> · ${it.skillCount} <span data-i18n="analysesSkills">${t('analysesSkills', lang)}</span></span>
        </li>`;
      }).join('');
      return `
      <main style="max-width:900px;margin:0 auto;padding:24px">
        <nav style="margin-bottom:12px"><a href="/${langQ}" data-i18n="backToEvalReports" style="color:var(--accent);text-decoration:none">${t('backToEvalReports', lang)}</a></nav>
        <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
        <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-surface);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
          <span data-i18n="analysesCompareHint">${t('analysesCompareHint', lang)}</span>
          <a id="compare-btn" style="margin-left:8px;padding:4px 10px;background:var(--accent);color:white;text-decoration:none;border-radius:3px;opacity:0.4;pointer-events:none" data-i18n="analysesCompareBtn">${t('analysesCompareBtn', lang)}</a>
        </div>
        <ul style="padding:0;margin:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">${rows}</ul>
      </main>
      <script>
        function updateCompare() {
          var f = document.querySelector('input[name=from]:checked');
          var t2 = document.querySelector('input[name=to]:checked');
          var btn = document.getElementById('compare-btn');
          if (f && t2 && f.value !== t2.value) {
            btn.href = '/analyses-diff?from=' + f.value + '&to=' + t2.value + '&lang=' + (document.documentElement.dataset.lang || '${DEFAULT_LANG}');
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
          } else {
            btn.removeAttribute('href');
            btn.style.opacity = '0.4';
            btn.style.pointerEvents = 'none';
          }
        }
      </script>`;
    })();
  return layout(t('skillHealthTitle', lang), body, lang);
}

interface ReportServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createReportServer({ port, reportsDir = DEFAULT_REPORTS_DIR, analysesDir = DEFAULT_ANALYSES_DIR, jobsDir = DEFAULT_JOBS_DIR, store, jobStore }: ReportServerOptions = {}): ReportServer {
  let server: Server | null = null;
  let serverUrl: string | null = null;

  // Use provided store or default to file store
  const reportStore: ReportStore = store || createFileStore(reportsDir);
  const resolvedJobStore: JobStore = jobStore || createFileJobStore(jobsDir);

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const path = parsed.pathname;
      const langParam = parsed.searchParams.get('lang');
      const lang: Lang = langParam === 'en' ? 'en' : langParam === 'zh' ? 'zh' : DEFAULT_LANG;

      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'omk-bench' }));
        return;
      }

      if (path === '/api/shutdown' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Graceful shutdown after response sent
        setTimeout(() => { if (server) server.close(); }, 100);
        return;
      }

      if (path === '/api/reports') {
        const runs = await queryRunList(reportStore);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
        return;
      }

      if (path === '/api/analyses') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listAnalyses(analysesDir)));
        return;
      }

      if (path === '/analyses') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderAnalysisList(listAnalyses(analysesDir), lang));
        return;
      }

      const analysisDetailMatch = path.match(/^\/analyses\/(.+)$/);
      if (analysisDetailMatch) {
        const id = decodeURIComponent(analysisDetailMatch[1]);
        const report = loadAnalysis(analysesDir, id);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillHealthReport(report, lang));
        return;
      }

      const analysisApiMatch = path.match(/^\/api\/analyses\/(.+)$/);
      if (analysisApiMatch) {
        const id = decodeURIComponent(analysisApiMatch[1]);
        const report = loadAnalysis(analysesDir, id);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'analysis not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      const skillTrendApiMatch = path.match(/^\/api\/skill-trend\/(.+)$/);
      if (skillTrendApiMatch) {
        const skillName = decodeURIComponent(skillTrendApiMatch[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(querySkillTrend(analysesDir, skillName)));
        return;
      }

      const skillTrendPageMatch = path.match(/^\/skill-trend\/(.+)$/);
      if (skillTrendPageMatch) {
        const skillName = decodeURIComponent(skillTrendPageMatch[1]);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillTrendPage(querySkillTrend(analysesDir, skillName), lang));
        return;
      }

      if (path === '/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing from/to query params');
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId);
        if (!diff) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillDiffPage(diff, lang));
        return;
      }

      if (path === '/api/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing from/to query params' }));
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId);
        if (!diff) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'analysis not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diff));
        return;
      }

      if (path === '/api/jobs') {
        const limitParam = parsed.searchParams.get('limit');
        const jobs = await queryJobList(resolvedJobStore, {
          status: parsed.searchParams.get('status') || undefined,
          reportId: parsed.searchParams.get('reportId') || undefined,
          project: parsed.searchParams.get('project') || undefined,
          owner: parsed.searchParams.get('owner') || undefined,
          tag: parsed.searchParams.get('tag') || undefined,
          limit: limitParam ? Number(limitParam) : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jobs));
        return;
      }

      const jobApiMatch = path.match(/^\/api\/job\/(.+)$/);
      if (jobApiMatch) {
        const job = await queryJob(resolvedJobStore, decodeURIComponent(jobApiMatch[1]));
        if (!job) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'job not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(job));
        return;
      }

      const reportApiMatch = path.match(/^\/api\/reports\/(.+)$/);
      if (reportApiMatch) {
        const id = decodeURIComponent(reportApiMatch[1]);

        if (req.method === 'DELETE') {
          const removed = await reportStore.remove(id);
          if (!removed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'report not found' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
          return;
        }

        const report = await queryRun(reportStore, id);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'report not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      // Trends API
      const trendsApiMatch = path.match(/^\/api\/trends\/(.+)$/);
      if (trendsApiMatch) {
        const variantName = decodeURIComponent(trendsApiMatch[1]);
        const trend = await queryTrend(reportStore, variantName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variant: trend.variant, points: trend.points }));
        return;
      }

      // Trends page
      const trendsPageMatch = path.match(/^\/trends\/(.+)$/);
      if (trendsPageMatch) {
        const variantName = decodeURIComponent(trendsPageMatch[1]);
        const trend = await queryTrend(reportStore, variantName);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderTrendsPage(variantName, trend.runs));
        return;
      }

      const reportPageMatch = path.match(/^\/reports\/(.+)$/);
      if (reportPageMatch) {
        const report = await queryRun(reportStore, decodeURIComponent(reportPageMatch[1]));
        res.writeHead(report ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(report?.each ? renderEachRunDetail(report) : renderRunDetail(report));
        return;
      }

      if (path === '/') {
        const runs = await reportStore.list();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderRunList(runs));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: getErrorMessage(err) }));
    }
  }

  async function start(): Promise<string> {
    if (server) return serverUrl!;
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    if (!existsSync(analysesDir)) mkdirSync(analysesDir, { recursive: true });
    if (!existsSync(jobsDir)) mkdirSync(jobsDir, { recursive: true });

    const p = port || Number(process.env.OMK_BENCH_PORT || DEFAULT_PORT);
    const host = '127.0.0.1';

    const boot = (listenPort: number): Promise<Server> => new Promise((resolve, reject) => {
      const srv = createServer(handleRequest);
      srv.once('error', reject);
      srv.listen(listenPort, host, () => resolve(srv));
    });

    try {
      server = await boot(p);
    } catch {
      // Port occupied — check if it's an existing omk service
      const url = `http://${host}:${p}`;
      let isOmk = false;
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        const data = await res.json() as { service?: string };
        isOmk = data.service === 'omk-bench';
      } catch { /* not reachable or not omk */ }

      if (isOmk) {
        // Shut down old omk service, then take over the port
        try { await fetch(`${url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 500));
        try {
          server = await boot(p);
        } catch {
          throw new Error(`port ${p} is still in use; close it manually and retry: lsof -ti:${p} | xargs kill`);
        }
      } else {
        throw new Error(
          `port ${p} is already in use by another process.\n` +
          `  inspect: lsof -i:${p}\n` +
          `  release: lsof -ti:${p} | xargs kill\n` +
          `  or pick another port: omk bench report --port 8080`
        );
      }
    }

    const addr = server!.address() as AddressInfo;
    serverUrl = `http://${host}:${addr.port}`;
    return serverUrl;
  }

  async function stop(): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverUrl = null;
  }

  function getUrl(): string | null {
    return serverUrl;
  }

  return { start, stop, getUrl };
}

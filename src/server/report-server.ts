import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderRunDetail, renderEachRunDetail, renderTrendsPage } from '../renderer/html-renderer.js';
import { renderSkillHealthReport } from '../renderer/skill-health-renderer.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from './job-store.js';
import { createFileStore, queryJob, queryJobList, queryRun, queryRunList, queryTrend } from './report-store.js';
import type { JobStore, ReportStore } from '../types.js';
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
    points.push({
      analysisId: it.id,
      generatedAt: report.meta.generatedAt,
      gapRate: h.gap?.gapRate ?? 0,
      weightedGapRate: h.gap?.weightedGapRate ?? 0,
      failureRate: h.toolFailureRate ?? 0,
      coverageRate: h.coverage?.fileCoverageRate ?? null,
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

function renderSkillDiffPage(diff: SkillDiffResult): string {
  const { fromId, toId, fromAt, toAt, rows } = diff;
  const rowHtml = rows.map((r) => {
    const tag = r.presence === 'only-from' ? `<span style="color:#16a34a;font-size:10px;padding:1px 6px;background:#ecfdf5;border-radius:3px">removed</span>`
      : r.presence === 'only-to' ? `<span style="color:#0366d6;font-size:10px;padding:1px 6px;background:#eff6ff;border-radius:3px">new</span>`
      : '';
    return `<tr>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${r.skillName} ${tag}</td>
      <td style="padding:8px 10px;text-align:right">${r.fromSegments ?? '—'} → ${r.toSegments ?? '—'} ${r.presence === 'both' ? `(${fmtDelta(r.deltaSegments, false)})` : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromGap)} → ${fmtPct(r.toGap)} ${r.presence === 'both' ? fmtDelta(r.deltaGap) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromFailure)} → ${fmtPct(r.toFailure)} ${r.presence === 'both' ? fmtDelta(r.deltaFailure) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromCoverage)} → ${fmtPct(r.toCoverage)} ${r.presence === 'both' && r.deltaCoverage != null ? fmtDelta(r.deltaCoverage) : ''}</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Skill Health Diff</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 auto;padding:24px;max-width:1000px}nav a{color:#0366d6;text-decoration:none;margin-right:12px}h1{font-size:20px;margin:8px 0}.meta{color:#888;font-size:13px;margin-bottom:20px}table{border-collapse:collapse;width:100%;font-size:13px}thead th{text-align:left;padding:10px;border-bottom:2px solid #eee;font-weight:600}tr:nth-child(even) td{background:#fafafa}</style></head><body><nav><a href="/analyses">← Reports</a><a href="/analyses/${encodeURIComponent(fromId)}">from</a><a href="/analyses/${encodeURIComponent(toId)}">to</a></nav><h1>Skill Health Diff</h1><div class="meta">from <code>${fromId}</code> (${fromAt.slice(0, 19).replace('T', ' ')}) → to <code>${toId}</code> (${toAt.slice(0, 19).replace('T', ' ')})<br/>按 gap 变化量排序;绿色=改善,红色=恶化</div><table><thead><tr><th>Skill</th><th style="text-align:right">Segments</th><th style="text-align:right">Weighted gap</th><th style="text-align:right">Failure rate</th><th style="text-align:right">Coverage</th></tr></thead><tbody>${rowHtml}</tbody></table></body></html>`;
}

function renderSkillTrendPage(trend: SkillTrendResult): string {
  const { skillName, points } = trend;
  if (points.length === 0) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Skill Trend · ${skillName}</title><style>body{font-family:-apple-system,sans-serif;margin:0 auto;padding:24px;max-width:900px}nav a{color:#0366d6;text-decoration:none}</style></head><body><nav><a href="/analyses">← Skill Health Reports</a></nav><h1>${skillName}</h1><p style="color:#888">No trend data. This skill has not appeared in any analysis report yet.</p></body></html>`;
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
  // Y 轴刻度 (0, 50%, 100%)
  const yTicks = [0, 0.5, 1.0].map((v) => `<g><line x1="${PAD}" y1="${toY(v)}" x2="${W - PAD}" y2="${toY(v)}" stroke="#eee"/><text x="${PAD - 6}" y="${toY(v) + 4}" text-anchor="end" font-size="11" fill="#888">${Math.round(v * 100)}%</text></g>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px;background:#fafafa;border:1px solid #eee;border-radius:6px">
    ${yTicks}
    <path d="${pathOf('gapRate')}" stroke="#dc2626" stroke-width="2" fill="none"/>
    <path d="${pathOf('weightedGapRate')}" stroke="#f59e0b" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
    <path d="${pathOf('failureRate')}" stroke="#7c3aed" stroke-width="2" fill="none"/>
    <path d="${pathOf('coverageRate')}" stroke="#16a34a" stroke-width="2" fill="none"/>
    ${dots('gapRate', '#dc2626')}${dots('weightedGapRate', '#f59e0b')}${dots('failureRate', '#7c3aed')}${dots('coverageRate', '#16a34a')}
  </svg>`;
  const legend = `<div style="margin:12px 0;font-size:12px;color:#555">
    <span style="color:#dc2626">● gap rate</span> ·
    <span style="color:#f59e0b">◆ weighted gap</span> ·
    <span style="color:#7c3aed">● failure rate</span> ·
    <span style="color:#16a34a">● coverage</span>
  </div>`;
  const rows = points.map((p) => `<tr>
    <td style="padding:6px 10px;font-family:ui-monospace,monospace;font-size:12px"><a href="/analyses/${encodeURIComponent(p.analysisId)}" style="color:#0366d6;text-decoration:none">${p.generatedAt.slice(0, 19).replace('T', ' ')}</a></td>
    <td style="padding:6px 10px;text-align:right">${p.segmentCount}</td>
    <td style="padding:6px 10px;text-align:right;color:#dc2626">${Math.round(p.gapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#f59e0b">${Math.round(p.weightedGapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#7c3aed">${Math.round(p.failureRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#16a34a">${p.coverageRate == null ? '—' : Math.round(p.coverageRate * 100) + '%'}</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${(p.totalTokens / 1000).toFixed(1)}k</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${(p.durationMs / 1000).toFixed(1)}s</td>
  </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Skill Trend · ${skillName}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 auto;padding:24px;max-width:900px}nav a{color:#0366d6;text-decoration:none}h1{font-size:20px;margin:8px 0 4px}.sub{color:#888;font-size:13px;margin-bottom:16px}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:12px}thead th{text-align:left;padding:8px 10px;border-bottom:2px solid #eee;color:#555;font-weight:600}tr:nth-child(even) td{background:#fafafa}</style></head><body><nav><a href="/analyses">← Skill Health Reports</a></nav><h1>${skillName}</h1><div class="sub">${points.length} 个时间点 · 最早 ${points[0].generatedAt.slice(0, 10)} · 最新 ${points[points.length - 1].generatedAt.slice(0, 10)}</div>${svg}${legend}<table><thead><tr><th>Timestamp</th><th style="text-align:right">Segs</th><th style="text-align:right">Gap</th><th style="text-align:right">Weighted</th><th style="text-align:right">Failure</th><th style="text-align:right">Coverage</th><th style="text-align:right">Tokens</th><th style="text-align:right">Duration</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function renderAnalysisList(items: AnalysisListItem[]): string {
  if (items.length === 0) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Skill Health Reports</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 auto;padding:24px;max-width:900px}nav a{color:#0366d6;text-decoration:none;margin-right:16px}</style></head><body><nav><a href="/">← Eval reports</a></nav><h1>Skill Health Reports</h1><div style="color:#888;padding:16px">暂无 skill 健康度日报。运行 <code>omk analyze &lt;trace-dir&gt;</code> 生成。</div></body></html>`;
  }
  const rows = items.map((it) => {
    const badgeColor = it.healthBand === 'red' ? '#dc2626' : it.healthBand === 'yellow' ? '#d97706' : '#16a34a';
    const enc = encodeURIComponent(it.id);
    return `<li style="padding:10px 14px;border-bottom:1px solid #eee;list-style:none;display:flex;align-items:center;gap:12px">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
      <label style="font-size:11px;color:#888;display:flex;align-items:center;gap:3px"><input type="radio" name="from" value="${enc}" onchange="updateCompare()"> from</label>
      <label style="font-size:11px;color:#888;display:flex;align-items:center;gap:3px"><input type="radio" name="to" value="${enc}" onchange="updateCompare()"> to</label>
      <a href="/analyses/${enc}" style="color:#0366d6;text-decoration:none;flex:1;font-family:ui-monospace,monospace">${it.id}</a>
      <span style="color:#666;font-size:12px">${it.sessionCount} sessions · ${it.segmentCount} segs · ${it.skillCount} skills</span>
    </li>`;
  }).join('');
  const script = `<script>
    function updateCompare() {
      var f = document.querySelector('input[name=from]:checked');
      var t = document.querySelector('input[name=to]:checked');
      var btn = document.getElementById('compare-btn');
      if (f && t && f.value !== t.value) {
        btn.href = '/analyses-diff?from=' + f.value + '&to=' + t.value;
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
      } else {
        btn.removeAttribute('href');
        btn.style.opacity = '0.4';
        btn.style.pointerEvents = 'none';
      }
    }
  </script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Skill Health Reports</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 auto;padding:24px;max-width:900px}nav a{color:#0366d6;text-decoration:none;margin-right:16px}ul{padding:0;margin:0;border:1px solid #eee;border-radius:6px;overflow:hidden}</style></head><body><nav><a href="/">← Eval reports</a></nav><h1>Skill Health Reports</h1><div style="margin-bottom:12px;padding:8px 12px;background:#f9f9f9;border-radius:4px;font-size:12px;color:#555">选两个报告的 from/to 单选框,点 Compare 生成 diff。 <a id="compare-btn" style="margin-left:8px;padding:4px 10px;background:#0366d6;color:white;text-decoration:none;border-radius:3px;opacity:0.4;pointer-events:none">Compare →</a></div><ul>${rows}</ul>${script}</body></html>`;
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

      if (path === '/api/runs') {
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
        res.end(renderAnalysisList(listAnalyses(analysesDir)));
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
        res.end(renderSkillHealthReport(report));
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
        res.end(renderSkillTrendPage(querySkillTrend(analysesDir, skillName)));
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
        res.end(renderSkillDiffPage(diff));
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

      const runApiMatch = path.match(/^\/api\/run\/(.+)$/);
      if (runApiMatch) {
        const id = decodeURIComponent(runApiMatch[1]);

        if (req.method === 'DELETE') {
          const removed = await reportStore.remove(id);
          if (!removed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'run not found' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
          return;
        }

        const run = await queryRun(reportStore, id);
        if (!run) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'run not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(run));
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

      const runPageMatch = path.match(/^\/run\/(.+)$/);
      if (runPageMatch) {
        const run = await queryRun(reportStore, decodeURIComponent(runPageMatch[1]));
        res.writeHead(run ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(run?.each ? renderEachRunDetail(run) : renderRunDetail(run));
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
          throw new Error(`端口 ${p} 仍被占用，请手动关闭后重试：lsof -ti:${p} | xargs kill`);
        }
      } else {
        throw new Error(
          `端口 ${p} 已被其他程序占用。\n` +
          `  查看占用进程：lsof -i:${p}\n` +
          `  释放端口：lsof -ti:${p} | xargs kill\n` +
          `  或指定其他端口：omk bench report --port 8080`
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

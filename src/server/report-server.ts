import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderRunDetail, renderEachRunDetail, renderTrendsPage } from '../renderer/html-renderer.js';
import { renderSkillHealthReport } from '../renderer/skill-health-renderer.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from './job-store.js';
import { createFileStore, queryJob, queryJobList, queryRun, queryRunList, queryTrend } from './report-store.js';
import type { JobStore, ReportStore } from '../types.js';
import type { SkillHealthReport } from '../observability/production-analyzer.js';
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

function renderAnalysisList(items: AnalysisListItem[]): string {
  const rows = items.length === 0
    ? `<div style="color:#888;padding:16px">暂无 skill 健康度日报。运行 <code>omk analyze &lt;trace-dir&gt;</code> 生成。</div>`
    : items.map((it) => {
        const badgeColor = it.healthBand === 'red' ? '#dc2626' : it.healthBand === 'yellow' ? '#d97706' : '#16a34a';
        return `<li style="padding:10px 14px;border-bottom:1px solid #eee;list-style:none;display:flex;align-items:center;gap:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
          <a href="/analyses/${encodeURIComponent(it.id)}" style="color:#0366d6;text-decoration:none;flex:1;font-family:ui-monospace,monospace">${it.id}</a>
          <span style="color:#666;font-size:12px">${it.sessionCount} sessions · ${it.segmentCount} segs · ${it.skillCount} skills</span>
        </li>`;
      }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Skill Health Reports</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;max-width:900px;margin:0 auto}h1{font-size:20px;margin:0 0 16px}nav{margin-bottom:16px}nav a{color:#0366d6;text-decoration:none;margin-right:16px}ul{padding:0;margin:0;border:1px solid #eee;border-radius:6px;overflow:hidden}</style></head><body><nav><a href="/">← Eval reports</a></nav><h1>Skill Health Reports</h1><ul>${rows}</ul></body></html>`;
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

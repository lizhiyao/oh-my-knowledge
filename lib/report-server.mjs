import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderRunDetail, renderEachRunDetail, renderTrendsPage } from './html-renderer.mjs';
import { createFileStore } from './report-store.mjs';

const DEFAULT_PORT = 7799;
const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

export function createReportServer({ port, reportsDir = DEFAULT_REPORTS_DIR, store } = {}) {
  let server = null;
  let serverUrl = null;

  // Use provided store or default to file store
  const reportStore = store || createFileStore(reportsDir);

  async function handleRequest(req, res) {
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
        const runs = (await reportStore.list()).map((r) => ({ id: r.id, meta: r.meta, summary: r.summary }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
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

        const run = await reportStore.get(id);
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
        const runs = await reportStore.findByVariant(variantName);
        const points = runs.map((r) => {
          const s = r.summary?.[variantName] || {};
          return {
            reportId: r.id,
            timestamp: r.meta?.timestamp,
            avgCompositeScore: s.avgCompositeScore ?? null,
            avgNumTurns: s.avgNumTurns ?? null,
            avgCostPerSample: s.avgCostPerSample ?? null,
            skillHash: r.meta?.skillHashes?.[variantName] || null,
            gitCommitShort: r.meta?.gitInfo?.commitShort || null,
            gitBranch: r.meta?.gitInfo?.branch || null,
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variant: variantName, points }));
        return;
      }

      // Trends page
      const trendsPageMatch = path.match(/^\/trends\/(.+)$/);
      if (trendsPageMatch) {
        const variantName = decodeURIComponent(trendsPageMatch[1]);
        const runs = await reportStore.findByVariant(variantName);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderTrendsPage(variantName, runs));
        return;
      }

      const runPageMatch = path.match(/^\/run\/(.+)$/);
      if (runPageMatch) {
        const run = await reportStore.get(decodeURIComponent(runPageMatch[1]));
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
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  async function start() {
    if (server) return serverUrl;
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

    const p = port || Number(process.env.OMK_BENCH_PORT || DEFAULT_PORT);
    const host = '127.0.0.1';

    const boot = (listenPort) => new Promise((resolve, reject) => {
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
        const data = await res.json();
        isOmk = data?.service === 'omk-bench';
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

    const addr = server.address();
    serverUrl = `http://${host}:${addr.port}`;
    return serverUrl;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
    serverUrl = null;
  }

  function getUrl() {
    return serverUrl;
  }

  return { start, stop, getUrl };
}

import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderRunDetail } from './html-renderer.mjs';
import { createFileStore } from './report-store.mjs';

const DEFAULT_PORT = 7799;
const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

export function createReportServer({ port, reportsDir = DEFAULT_REPORTS_DIR, store } = {}) {
  let server = null;
  let serverUrl = null;

  // Use provided store or default to file store
  const reportStore = store || createFileStore(reportsDir);

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  async function handleRequest(req, res) {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const path = parsed.pathname;

      // POST: feedback endpoint
      const feedbackMatch = path.match(/^\/api\/run\/(.+)\/feedback$/);
      if (feedbackMatch && req.method === 'POST') {
        await handleFeedback(req, res, decodeURIComponent(feedbackMatch[1]));
        return;
      }

      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'omk-bench' }));
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

      const runPageMatch = path.match(/^\/run\/(.+)$/);
      if (runPageMatch) {
        const run = await reportStore.get(decodeURIComponent(runPageMatch[1]));
        res.writeHead(run ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderRunDetail(run));
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

  async function handleFeedback(req, res, runId) {
    try {
      const body = await parseBody(req);
      const { sample_id, variant, rating, comment } = body;

      if (!sample_id || !variant || typeof rating !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing sample_id, variant, or rating' }));
        return;
      }

      // Atomic read-modify-write with retry
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const report = await reportStore.get(runId);
          if (!report) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'run not found' }));
            return;
          }

          const result = (report.results || []).find((r) => r.sample_id === sample_id);
          if (!result) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sample not found' }));
            return;
          }

          if (!result.humanFeedback) result.humanFeedback = [];
          result.humanFeedback.push({
            variant,
            rating: Math.max(1, Math.min(5, rating)),
            comment: comment || '',
            timestamp: new Date().toISOString(),
          });

          await reportStore.save(runId, report);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (err) {
          if (attempt === maxRetries - 1) throw err;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
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
      server = await boot(0);
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

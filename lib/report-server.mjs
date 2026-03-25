import { createServer } from 'node:http';
import { readdir, readFile, writeFile, unlink, access, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderRunList, renderRunDetail } from './html-renderer.mjs';

const DEFAULT_PORT = 7799;
const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

export function createReportServer({ port, reportsDir = DEFAULT_REPORTS_DIR } = {}) {
  let server = null;
  let serverUrl = null;

  async function loadRuns() {
    try {
      await access(reportsDir);
    } catch {
      return [];
    }
    const files = (await readdir(reportsDir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    const runs = [];
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(join(reportsDir, file), 'utf-8'));
        if (data && data.meta) {
          if (!data.id) data.id = file.replace(/\.json$/, '');
          runs.push(data);
        }
      } catch {}
    }
    return runs;
  }

  async function findRun(id) {
    const filePath = join(reportsDir, `${id}.json`);
    try {
      const data = JSON.parse(await readFile(filePath, 'utf-8'));
      if (!data.id) data.id = id;
      return data;
    } catch {
      return null;
    }
  }

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
        const runs = (await loadRuns()).map((r) => ({ id: r.id, meta: r.meta, summary: r.summary }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
        return;
      }

      const runApiMatch = path.match(/^\/api\/run\/(.+)$/);
      if (runApiMatch) {
        const id = decodeURIComponent(runApiMatch[1]);

        // DELETE: remove a report (handles concurrent deletes gracefully)
        if (req.method === 'DELETE') {
          const filePath = join(reportsDir, `${id}.json`);
          try {
            await unlink(filePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            if (err.code === 'ENOENT') {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'run not found' }));
            } else {
              throw err;
            }
          }
          return;
        }

        const run = await findRun(id);
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
        const run = await findRun(decodeURIComponent(runPageMatch[1]));
        res.writeHead(run ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderRunDetail(run));
        return;
      }

      if (path === '/') {
        const runs = await loadRuns();
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

      const filePath = join(reportsDir, `${runId}.json`);

      // Atomic read-modify-write with retry on conflict
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const raw = await readFile(filePath, 'utf-8');
          const report = JSON.parse(raw);
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

          // Write to temp file first, then rename (atomic on most filesystems)
          const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
          await writeFile(tmpPath, JSON.stringify(report, null, 2));
          const { rename } = await import('node:fs/promises');
          await rename(tmpPath, filePath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (err) {
          if (attempt === maxRetries - 1) throw err;
          // Brief pause before retry
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

  return { start, stop, getUrl, loadRuns, findRun };
}

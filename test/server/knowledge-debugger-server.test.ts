import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  buildObservationInboxReport,
  saveObservationInboxReport,
} from '../../src/observability/inbox.js';
import { createReportServer } from '../../src/server/report-server.js';

interface FetchResponse {
  status: number;
  body: string;
}

function fetch(url: string): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Knowledge Debugger task replay server', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-debugger-server-'));
  const observationsDir = join(root, 'observations');
  const reportsDir = join(root, 'reports');
  const jobsDir = join(root, 'jobs');
  const tracePath = join(root, 'rollout-codex.jsonl');
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';
  let experienceSessionId = '';

  beforeAll(async () => {
    mkdirSync(observationsDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(
      tracePath,
      readFileSync(new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url), 'utf-8'),
    );
    const report = buildObservationInboxReport(tracePath);
    assert.ok(report.experience?.sessions[0]);
    saveObservationInboxReport(report, observationsDir);
    experienceSessionId = report.experience.sessions[0].id;
    server = createReportServer({ port: 0, observationsDir, reportsDir, jobsDir });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('links an observed session to a fact-only task replay', async () => {
    const inbox = await fetch(`${baseUrl}/observe-inbox`);
    assert.equal(inbox.status, 200);
    assert.match(inbox.body, new RegExp(`/observe-debugger/${encodeURIComponent(experienceSessionId)}`));
    assert.match(inbox.body, /任务重放/);

    const replay = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}`);
    assert.equal(replay.status, 200);
    assert.match(replay.body, /任务重放/);
    assert.match(replay.body, /事实摘要/);
    assert.match(replay.body, /任务经过/);
    assert.match(replay.body, /本次出现的 Knowledge/);
    assert.match(replay.body, /检查并发布当前版本/);
    assert.match(replay.body, /AGENTS\.md/);
    assert.match(replay.body, /进入任务上下文/);
    assert.match(replay.body, /读取 Skill：release/);
    assert.match(replay.body, /npm publish 返回失败后，AI 回答.*用户随后进行了纠正/);
    assert.match(replay.body, /missing doctor\/eval evidence/);
    assert.match(replay.body, /版本已经可以发布/);
    assert.match(replay.body, /用户纠正/);
    assert.match(replay.body, /data-replay-mode="reading"/);
    assert.match(replay.body, /data-replay-mode="evidence"/);
    assert.match(replay.body, /不代表模型实际采用了它/);
    assert.doesNotMatch(replay.body, /任务事实|Trace 完整性|条可核验记录|查看失败操作|OMK Studio · 任务重放/);
    assert.doesNotMatch(replay.body, /replay-knowledge-link[^>]*><strong>Bash/);
    assert.doesNotMatch(replay.body, /AI (?:使用|采用)了/);
    assert.doesNotMatch(replay.body, /knowledge-gap-form|候选 knowledge|omk sample --from-traces/);
  });

  it('renders English without hidden-reasoning claims and rejects unknown sessions', async () => {
    const replay = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}?lang=en`);
    assert.equal(replay.status, 200);
    assert.match(replay.body, /Task Replay/);
    assert.match(replay.body, /Factual summary/);
    assert.match(replay.body, /Knowledge in this task/);
    assert.match(replay.body, /Observed result/);
    assert.match(replay.body, /User correction/);
    assert.doesNotMatch(replay.body, /hidden (thought|reasoning)|chain of thought/i);
    assert.equal((await fetch(`${baseUrl}/observe-debugger/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/observe-debugger/%E0%A4%A`)).status, 404);
  });
});

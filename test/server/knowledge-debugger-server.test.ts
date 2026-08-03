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
import { buildKnowledgeDebuggerViewModel } from '../../src/observability/knowledge-debugger.js';
import { createReportServer } from '../../src/server/report-server.js';

interface FetchResponse {
  status: number;
  body: string;
}

function fetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Knowledge Debugger server', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-debugger-server-'));
  const observationsDir = join(root, 'observations');
  const reportsDir = join(root, 'reports');
  const jobsDir = join(root, 'jobs');
  const tracePath = join(root, 'rollout-codex.jsonl');
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';
  let experienceSessionId = '';
  let knowledgeEvidenceId = '';

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
    knowledgeEvidenceId = buildKnowledgeDebuggerViewModel(report.experience.sessions[0])
      .knowledgeEvidence.find((item) => item.knowledgeKind === 'skill')?.id ?? '';
    assert.ok(knowledgeEvidenceId);

    server = createReportServer({ port: 0, observationsDir, reportsDir, jobsDir });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('links an observed session to its trace-driven debugger page', async () => {
    const inbox = await fetch(`${baseUrl}/observe-inbox`);
    assert.equal(inbox.status, 200);
    assert.match(inbox.body, new RegExp(`/observe-debugger/${encodeURIComponent(experienceSessionId)}`));

    const debuggerPage = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}`);
    assert.equal(debuggerPage.status, 200);
    assert.match(debuggerPage.body, /Knowledge 调试/);
    assert.match(debuggerPage.body, /AGENTS\.md/);
    assert.match(debuggerPage.body, /Release/);
    assert.match(debuggerPage.body, /不代表模型一定采用了这些内容/);
    assert.match(debuggerPage.body, /观测事实/);
    assert.match(debuggerPage.body, /用户诊断/);
    assert.match(debuggerPage.body, /系统推断/);
    assert.match(debuggerPage.body, /受控证据/);
    assert.match(debuggerPage.body, /href="#event-/);

    const englishPage = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}?lang=en`);
    assert.equal(englishPage.status, 200);
    assert.match(englishPage.body, /No automatic root-cause claim in MVP/);
    assert.doesNotMatch(englishPage.body, /hidden (thought|reasoning)|chain of thought/i);
  });

  it('persists a gap only when its evidence belongs to the selected session', async () => {
    const response = await fetch(`${baseUrl}/api/observe-debugger/gaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experienceSessionId,
        gapKind: 'stale',
        knowledgeEvidenceId,
        note: '发布流程已经过时。',
        candidateKnowledge: '发布前必须先通过 doctor 和 eval。',
      }),
    });
    assert.equal(response.status, 201);
    const payload = JSON.parse(response.body);
    assert.equal(payload.entry.targetType, 'knowledge_gap');
    assert.equal(payload.entry.experienceSessionId, experienceSessionId);
    assert.equal(payload.entry.knowledgeEvidenceId, knowledgeEvidenceId);
    assert.equal(payload.entry.gapKind, 'stale');
    assert.equal(payload.entry.candidateKnowledge, '发布前必须先通过 doctor 和 eval。');

    const persisted = JSON.parse(readFileSync(join(observationsDir, 'review-state.json'), 'utf-8'));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(Object.values(persisted.entries).length, 1);

    const updatedPage = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}`);
    assert.match(updatedPage.body, /待复核候选/);
    assert.match(updatedPage.body, /omk sample --from-traces --observations-dir/);
    assert.match(updatedPage.body, /--gap knowledge-gap:/);

    const invalidEvidence = await fetch(`${baseUrl}/api/observe-debugger/gaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experienceSessionId,
        gapKind: 'missing',
        knowledgeEvidenceId: 'knowledge:from-another-session',
        note: '不应写入。',
      }),
    });
    assert.equal(invalidEvidence.status, 400);
    assert.equal(JSON.parse(invalidEvidence.body).error, 'knowledge evidence does not belong to session');
  });

  it('rejects unknown sessions and cross-origin writes', async () => {
    assert.equal((await fetch(`${baseUrl}/observe-debugger/missing`)).status, 404);
    const crossOrigin = await fetch(`${baseUrl}/api/observe-debugger/gaps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        experienceSessionId,
        gapKind: 'missing',
        note: '不应写入。',
      }),
    });
    assert.equal(crossOrigin.status, 403);
  });
});

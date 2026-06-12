import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createReportServer } from '../../src/server/report-server.js';

const TEST_DIR = join(tmpdir(), `omk-test-reports-${Date.now()}`);
const JOBS_DIR = join(tmpdir(), `omk-test-jobs-${Date.now()}`);
const OBSERVATIONS_DIR = join(tmpdir(), `omk-test-observations-${Date.now()}`);
// 隔离 analyses / doctors dir,避免读取 home dir 的真实 SkillHealthReport / doctor report
// 导致 fixture skill 意外携带 observe / doctor snapshot(本地 / CI 漂移)。
const ANALYSES_DIR = join(tmpdir(), `omk-test-analyses-${Date.now()}`);
const DOCTORS_DIR = join(tmpdir(), `omk-test-doctors-${Date.now()}`);
const MANAGED_DIR = join(tmpdir(), `omk-test-managed-${Date.now()}`);

// 受管记录 fixture:git+url 源 → probeSourceState 直接 reachable + record.contentHash,零文件 IO、跨机稳定。
// install + 两版本证据(NOISE→PROGRESS) + promote(当前内容)→ 行状态应为 promoted。
const MANAGED_RECORD = {
  recordKind: 'managed-artifact',
  schemaVersion: 2,
  id: 'skill-review-smoke',
  name: 'review',
  kind: 'skill',
  source: { sourceKind: 'git', locator: 'git+https://example.com/r@abc123:review', url: 'https://example.com/r', ref: 'abc123', isDirectorySkill: true },
  contentHash: 'hashV2smoke',
  installedAt: '2026-03-01T00:00:00.000Z',
  distribution: [],
  evidence: [
    { reportId: 'r1', contentHash: 'hashV1smoke', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'NOISE', sampleCoverage: { count: 6, hash: 'sh1' }, comparability: { cliVersion: '0.37.0' } },
    { reportId: 'test-run-001', contentHash: 'hashV2smoke', recordedAt: '2026-03-05T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: 'sh2' }, comparability: { cliVersion: '0.37.0' } },
  ],
  decisions: [
    { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: 'hashV2smoke', reportId: 'test-run-001' },
  ],
};

const SAMPLE_REPORT = {
  kind: 'evaluation',
  id: 'test-run-001',
  meta: {
    variants: ['v1', 'v2'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    sampleCount: 1,
    taskCount: 2,
    totalCostUSD: 0.01,
    timestamp: '2026-03-25T10:00:00.000Z',
  },
  summary: {
    v1: { totalSamples: 1, successCount: 1, errorCount: 0, avgCompositeScore: 4.0 },
    v2: { totalSamples: 1, successCount: 1, errorCount: 0, avgCompositeScore: 4.5 },
  },
  results: [
    {
      sample_id: 's001',
      variants: {
        v1: { ok: true, compositeScore: 4.0 },
        v2: { ok: true, compositeScore: 4.5 },
      },
    },
  ],
};

const SAMPLE_JOB = {
  jobId: 'job-test-run-001',
  status: 'succeeded',
  createdAt: '2026-03-25T10:00:00.000Z',
  updatedAt: '2026-03-25T10:00:02.000Z',
  startedAt: '2026-03-25T10:00:01.000Z',
  finishedAt: '2026-03-25T10:00:02.000Z',
  request: {
    samplesPath: 'eval-samples.json',
    skillDir: 'skills',
    artifacts: [],
    project: 'alpha',
    owner: 'lizhiyao',
    tags: ['smoke', 'nightly'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    judgeExecutor: 'claude',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    blind: false,
  },
  runId: 'test-run-001',
  resultReportId: 'test-run-001',
};

const FAILED_JOB = {
  jobId: 'job-test-run-002',
  status: 'failed',
  createdAt: '2026-03-25T11:00:00.000Z',
  updatedAt: '2026-03-25T11:00:03.000Z',
  startedAt: '2026-03-25T11:00:01.000Z',
  finishedAt: '2026-03-25T11:00:03.000Z',
  request: {
    samplesPath: 'eval-samples-2.json',
    skillDir: 'skills',
    artifacts: [],
    project: 'beta',
    owner: 'other-user',
    tags: ['regression'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    judgeExecutor: 'claude',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    blind: false,
  },
  runId: 'test-run-002',
  error: 'skill not found',
  errorCategory: 'user',
};

function stripScriptAndStyle(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

interface FetchResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function fetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('report-server', () => {
  let server: ReturnType<typeof createReportServer>;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(JOBS_DIR, { recursive: true });
    mkdirSync(OBSERVATIONS_DIR, { recursive: true });
    mkdirSync(ANALYSES_DIR, { recursive: true });
    mkdirSync(DOCTORS_DIR, { recursive: true });
    mkdirSync(MANAGED_DIR, { recursive: true });
    writeFileSync(join(MANAGED_DIR, 'skill-review-smoke.json'), JSON.stringify(MANAGED_RECORD, null, 2));
    writeFileSync(join(TEST_DIR, 'test-run-001.json'), JSON.stringify(SAMPLE_REPORT, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-001.json'), JSON.stringify(SAMPLE_JOB, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-002.json'), JSON.stringify(FAILED_JOB, null, 2));
    writeFileSync(join(OBSERVATIONS_DIR, '2026-05-07T00-00-00-observe-inbox.json'), JSON.stringify({
      kind: 'observe-inbox',
      schemaVersion: 2,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-07T00:00:00.000Z',
        segmentCount: 2,
        itemCount: 2,
      },
      items: [
        {
          id: 'obs-high',
          skillName: 'audit',
          artifactVersion: 'unknown',
          cwd: '/repo',
          sessionId: 's1',
          sourceTrace: '/tmp/trace/session.jsonl',
          sourceKind: 'claude',
          signalType: 'failed_search',
          signalSubtype: 'hard_miss',
          confidence: 0.9,
          attributionConfidence: 0.85,
          severity: 'high',
          severityReasonCode: 'knowledge_gap_suspected',
          evidence: { tool: 'Grep', query: 'schema' },
          firstSeen: '2026-05-07T00:00:00.000Z',
          lastSeen: '2026-05-07T00:00:00.000Z',
          occurrences: 1,
          recentSessionIds: ['s1'],
          representativeEvidence: [{ tool: 'Grep', query: 'schema' }],
        },
        {
          id: 'obs-noise',
          skillName: 'audit',
          artifactVersion: 'unknown',
          cwd: '/repo',
          sessionId: 's2',
          sourceTrace: '/tmp/trace/session.jsonl',
          sourceKind: 'claude',
          signalType: 'failed_search',
          signalSubtype: 'tool_limit',
          confidence: 0.2,
          attributionConfidence: 0.85,
          severity: 'noise',
          severityReasonCode: 'tool_or_runtime_noise',
          evidence: { tool: 'Read', path: '/repo/large.ts' },
          firstSeen: '2026-05-07T00:00:01.000Z',
          lastSeen: '2026-05-07T00:00:01.000Z',
          occurrences: 1,
          recentSessionIds: ['s2'],
          representativeEvidence: [{ tool: 'Read', path: '/repo/large.ts' }],
        },
      ],
      diagnostics: {
        schemaVersion: 1,
        generatedAt: '2026-05-07T00:00:00.000Z',
        sourceCoverage: { observe: true, doctor: false, eval: false },
        bySkill: {
          audit: [
            {
              id: 'diag-audit-skill-md',
              stableKey: 'skill:audit|type:definition_gap|signal:skill_md_not_found|target:definition:skill_md',
              skillName: 'audit',
              type: 'definition_gap',
              signal: 'skill_md_not_found',
              title: 'SKILL.md was not found',
              severity: 'high',
              audience: 'skill-author',
              lifecycle: 'detected',
              scope: { primary: 'definition', refs: { skillName: 'audit' } },
              occurrences: [{
                id: 'occ-audit-skill-md',
                diagnosisStableKey: 'skill:audit|type:definition_gap|signal:skill_md_not_found|target:definition:skill_md',
                source: 'observe',
                sourceId: 'skill_chain:audit:skill_md_not_found',
                sourceKind: 'skill_chain',
                timestamp: '2026-05-07T00:00:00.000Z',
                severity: 'high',
                evidenceRefs: [],
                producer: 'deterministic_rule',
                payload: {},
              }],
              occurrenceCount: 1,
            },
          ],
        },
      },
    }, null, 2));
    server = createReportServer({ port: 0, reportsDir: TEST_DIR, observationsDir: OBSERVATIONS_DIR, jobsDir: JOBS_DIR, analysesDir: ANALYSES_DIR, doctorsDir: DOCTORS_DIR, managedDir: MANAGED_DIR });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(JOBS_DIR, { recursive: true, force: true });
    rmSync(OBSERVATIONS_DIR, { recursive: true, force: true });
    rmSync(ANALYSES_DIR, { recursive: true, force: true });
    rmSync(DOCTORS_DIR, { recursive: true, force: true });
    rmSync(MANAGED_DIR, { recursive: true, force: true });
  });

  it('GET /managed lists managed skills with link + verdict', async () => {
    const res = await fetch(`${baseUrl}/managed`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.ok(res.body.includes('review'), 'should show skill name');
    assert.ok(res.body.includes('/managed/skill-review-smoke'), 'should link to detail page by stable id');
    assert.ok(res.body.includes('verdict-PROGRESS'), 'current verdict badge');
    assert.ok(res.body.includes('已采用'), 'localized lifecycle label from promote decision (raw token stays in /api/managed)');
    assert.ok(res.body.includes('mh-legend'), 'state/marker legend present for first-time viewers');
  });

  it('GET /api/managed returns versioned envelope', async () => {
    const res = await fetch(`${baseUrl}/api/managed`);
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.schemaVersion, 1);
    assert.ok(Array.isArray(json.rows));
    const row = json.rows.find((r: { name: string }) => r.name === 'review');
    assert.ok(row, 'review row present');
    assert.equal(row.state, 'promoted');
    assert.equal(row.latestVerdict, 'PROGRESS');
  });

  it('GET /managed/<id> renders the decision timeline', async () => {
    const res = await fetch(`${baseUrl}/managed/skill-review-smoke`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.ok(res.body.includes('mh-timeline'), 'timeline present');
    assert.ok(res.body.includes('安装纳管'), 'install event');
    assert.ok(res.body.includes('verdict-PROGRESS') && res.body.includes('verdict-NOISE'), 'both version verdicts');
    assert.ok(res.body.includes('alice'), 'promote actor');
    assert.ok(res.body.includes('/reports/test-run-001'), 'links to evidence report');
  });

  it('GET /managed/<missing> → 404 (zh default, en via ?lang=en)', async () => {
    const zh = await fetch(`${baseUrl}/managed/nope`);
    assert.equal(zh.status, 404);
    assert.ok(zh.body.includes('受管记录不存在'));
    const en = await fetch(`${baseUrl}/managed/nope?lang=en`);
    assert.equal(en.status, 404);
    assert.ok(en.body.includes('managed record not found'));
  });

  it('GET /managed/<malformed %> → 404, not 500', async () => {
    const res = await fetch(`${baseUrl}/managed/%E0%A4%A`);
    assert.equal(res.status, 404, 'bad percent-encoding decodes to no match, not a crash');
  });

  it('EN 页内跳转透传 lang=en —— 列表行 / 返回 / 报告链接都带 lang(P2)', async () => {
    const list = await fetch(`${baseUrl}/managed?lang=en`);
    assert.ok(list.body.includes('/managed/skill-review-smoke?lang=en'), 'list row link carries lang');
    const detail = await fetch(`${baseUrl}/managed/skill-review-smoke?lang=en`);
    assert.ok(detail.body.includes('/managed?lang=en'), 'back-to-list link carries lang');
    assert.ok(detail.body.includes('/reports/test-run-001?lang=en'), 'evidence report link carries lang');
  });

  it('同名跨 kind —— skill/review 与 prompt/review 各有独立 id,都可达(P1)', async () => {
    const dir = join(tmpdir(), `omk-test-managed-xkind-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const mk = (kind: string, id: string) => ({
      recordKind: 'managed-artifact', schemaVersion: 2, id, name: 'review', kind,
      source: { sourceKind: 'git', locator: 'git+https://x@s:review', url: 'https://x', ref: 's', isDirectorySkill: kind === 'skill' },
      contentHash: 'h', installedAt: '2026-03-01T00:00:00.000Z', distribution: [], evidence: [], decisions: [],
    });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(mk('skill', 'id-skill-review')));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(mk('prompt', 'id-prompt-review')));
    const s = createReportServer({ port: 0, reportsDir: TEST_DIR, jobsDir: JOBS_DIR, observationsDir: OBSERVATIONS_DIR, analysesDir: ANALYSES_DIR, doctorsDir: DOCTORS_DIR, managedDir: dir });
    const u = await s.start();
    try {
      assert.equal((await fetch(`${u}/managed/id-skill-review`)).status, 200, 'skill/review reachable');
      assert.equal((await fetch(`${u}/managed/id-prompt-review`)).status, 200, 'prompt/review reachable');
      const listBody = (await fetch(`${u}/managed`)).body;
      assert.ok(listBody.includes('/managed/id-skill-review') && listBody.includes('/managed/id-prompt-review'), 'both rows link to distinct ids');
    } finally {
      await s.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('受管根目录按请求解析 —— 会话中途项目获首条记录后从 global 切回 project,不冻结于启动(P1)', async () => {
    // 复现 reviewer 场景的可控版:local 空 → 解析到 global;local 有记录 → 解析到 local(模拟 resolveManagedDir
    // 的 project→global 回退,但用受控 temp 目录、不碰 homedir,跨机稳定)。注入解析器 = server 持有的是「如何解析」
    // 策略而非冻结 root —— 若 server 在启动时定死,中途新增的 project 记录就永远看不到。
    const projDir = join(tmpdir(), `omk-test-managed-proj-${Date.now()}`);
    const globalDir = join(tmpdir(), `omk-test-managed-glob-${Date.now()}`);
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    const mk = (id: string, name: string) => ({
      recordKind: 'managed-artifact', schemaVersion: 2, id, name, kind: 'skill',
      source: { sourceKind: 'git', locator: 'git+https://x@s:review', url: 'https://x', ref: 's', isDirectorySkill: true },
      contentHash: 'h', installedAt: '2026-03-01T00:00:00.000Z', distribution: [], evidence: [], decisions: [],
    });
    writeFileSync(join(globalDir, 'g.json'), JSON.stringify(mk('id-global-skill', 'global-skill')));
    // local 非空才用 local,否则回退 global —— 即 resolveManagedDir 的口径。
    const resolver = (): string => (readdirSync(projDir).length > 0 ? projDir : globalDir);
    const s = createReportServer({ port: 0, reportsDir: TEST_DIR, jobsDir: JOBS_DIR, observationsDir: OBSERVATIONS_DIR, analysesDir: ANALYSES_DIR, doctorsDir: DOCTORS_DIR, managedDir: resolver });
    const u = await s.start();
    try {
      const before = JSON.parse((await fetch(`${u}/api/managed`)).body);
      assert.deepEqual(before.rows.map((r: { name: string }) => r.name), ['global-skill'], '启动时 local 空 → 解析到 global');
      // 会话中途:项目里首次 install,local 目录获得记录。
      writeFileSync(join(projDir, 'p.json'), JSON.stringify(mk('id-project-skill', 'project-skill')));
      const after = JSON.parse((await fetch(`${u}/api/managed`)).body);
      assert.deepEqual(after.rows.map((r: { name: string }) => r.name), ['project-skill'], '中途 local 获记录 → 同一会话实时切回 project');
    } finally {
      await s.stop();
      rmSync(projDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
  });

  it('GET /api/reports returns run list', async () => {
    const res = await fetch(`${baseUrl}/api/reports`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'test-run-001');
  });

  it('GET /api/jobs returns job list', async () => {
    const res = await fetch(`${baseUrl}/api/jobs`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.deepEqual(data.map((job: { jobId: string }) => job.jobId).sort(), ['job-test-run-001', 'job-test-run-002']);
  });

  it('GET /api/job/:id returns job detail', async () => {
    const res = await fetch(`${baseUrl}/api/job/job-test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.jobId, 'job-test-run-001');
    assert.equal(data.resultReportId, 'test-run-001');
  });

  it('GET /api/jobs supports filtering by status', async () => {
    const res = await fetch(`${baseUrl}/api/jobs?status=failed`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].jobId, 'job-test-run-002');
  });

  it('GET /observe-health 列表入口:underpowered 报告圆点改灰 + 样本不足,high-N red 仍硬红', async () => {
    // underpowered(segmentCount 2,缺 confidence 走 segmentCount 兜底)+ red 健康带。
    const lowN = {
      meta: { generatedAt: '2026-05-09T01:00:00Z', sessionCount: 1, segmentCount: 2, toolCallCount: 1, toolFailureRate: 0, messageCount: 0, tracePath: '/t', kbPath: null, timeRange: { from: '2026-05-09T00:00:00Z', to: '2026-05-09T01:00:00Z' } },
      overall: { gapRate: 0.5, weightedGapRate: 0.5, healthBand: 'red' },
      bySkill: {},
    };
    const highN = {
      ...lowN,
      meta: { ...lowN.meta, segmentCount: 40 },
      overall: { ...lowN.overall, confidence: 'high' },
    };
    writeFileSync(join(ANALYSES_DIR, 'an-lown.json'), JSON.stringify(lowN));
    writeFileSync(join(ANALYSES_DIR, 'an-highn.json'), JSON.stringify(highN));
    try {
      const res = await fetch(`${baseUrl}/observe-health`);
      assert.equal(res.status, 200);
      // 低 N 报告:中性灰圆点 + 「样本不足」,不出现硬红圆点(本列表只有这一种带背景色的圆点)。
      assert.match(res.body, /background:var\(--text-faint\)/);
      assert.match(res.body, /样本不足/);
      // high-N red 报告仍保留硬红圆点。
      assert.match(res.body, /background:var\(--red\)/);
    } finally {
      rmSync(join(ANALYSES_DIR, 'an-lown.json'), { force: true });
      rmSync(join(ANALYSES_DIR, 'an-highn.json'), { force: true });
    }
  });

  it('旧 observe 路由兜底到 observe-* canonical:页面 302、API 307(querystring 透传)', async () => {
    // 改名后旧外链 / 书签 / 已打开页面的旧 fetch 不能 404。helper 用 http.request 不跟随重定向,直接验状态码 + Location。
    // 页面 302(临时);API 307 —— review-state 有 POST/DELETE,302 会被降级成 GET,307 保留 method。
    const cases: Array<[string, number, string]> = [
      ['/analyses', 302, '/observe-health'],
      ['/analyses/some-id?lang=en', 302, '/observe-health/some-id?lang=en'],
      ['/observations', 302, '/observe-inbox'],
      ['/observations/inbox?skill=foo', 302, '/observe-inbox?skill=foo'],
      ['/api/analyses', 307, '/api/observe-health'],
      ['/api/analyses/some-id', 307, '/api/observe-health/some-id'],
      ['/api/observations/inbox?severity=high', 307, '/api/observe-inbox?severity=high'],
      ['/api/observations/show?id=obs-high', 307, '/api/observe-inbox/show?id=obs-high'],
      ['/api/observations/diagnostics', 307, '/api/observe-inbox/diagnostics'],
      ['/api/observations/review-state', 307, '/api/observe-inbox/review-state'],
    ];
    for (const [from, status, to] of cases) {
      const res = await fetch(`${baseUrl}${from}`);
      assert.equal(res.status, status, `${from} should ${status}`);
      assert.equal(res.headers.location, to, `${from} → ${to}`);
    }
  });

  it('GET /api/observe-inbox supports severity and limit query params', async () => {
    const res = await fetch(`${baseUrl}/api/observe-inbox?severity=high&limit=1`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'obs-high');
    assert.equal(data[0].severity, 'high');
  });

  it('GET /api/observe-inbox/diagnostics exposes observe-backed Diagnosis data', async () => {
    const res = await fetch(`${baseUrl}/api/observe-inbox/diagnostics`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sourceCoverage.observe, true);
    assert.equal(data.summary.totalCount, 1);
    assert.equal(data.bySkill.audit[0].signal, 'skill_md_not_found');
  });

  it('GET /api/skills includes diagnosis counts without changing renderer output', async () => {
    const res = await fetch(`${baseUrl}/api/skills`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    const audit = data.entries.find((entry: { skillName: string }) => entry.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.diagnosisCount, 1);
    assert.equal(data.diagnosisSummary.sourceCoverage.observe, true);
  });

  it('Diagnosis-only skill 的 band 被升级,API summary 跟 HTML renderer 口径一致', async () => {
    // audit skill 在 fixture 里只有 observe Diagnosis(high `skill_md_not_found`),没有
    // doctor / eval / observe snapshot。原先 band 一律 gray,summary.gray += 1,renderer
    // 通过 assessHealth 把卡片标红 —— 跨层矛盾。修后 entry.band 应升级为 red,summary.red
    // 包含它,/api/skills 暴露的 band 跟 HTML 视觉一致。
    const res = await fetch(`${baseUrl}/api/skills`);
    const data = JSON.parse(res.body);
    const audit = data.entries.find((entry: { skillName: string }) => entry.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.band, 'red', 'Diagnosis-only skill 的 band 应升级到 red(high severity)');
    assert.ok(data.summary.red >= 1, 'summary.red 应包含 Diagnosis-only red skill');
  });

  it('GET /api/skills/:name/diagnostics returns per-skill diagnostics', async () => {
    const res = await fetch(`${baseUrl}/api/skills/audit/diagnostics`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.skillName, 'audit');
    assert.equal(data.diagnostics.length, 1);
    assert.equal(data.diagnostics[0].signal, 'skill_md_not_found');
  });

  it('GET /api/jobs supports filtering by project and tag', async () => {
    const res = await fetch(`${baseUrl}/api/jobs?project=alpha&tag=nightly`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].jobId, 'job-test-run-001');
  });

  it('GET /api/reports/:id returns run detail', async () => {
    const res = await fetch(`${baseUrl}/api/reports/test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.id, 'test-run-001');
    assert.equal(data.meta.model, 'sonnet');
  });

  it('GET /api/reports/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/reports/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('GET / returns HTML skill list (variants become skill entries)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    // 列表页按 skill 聚合,SAMPLE_REPORT 的 variants v1/v2 各成一个 skill 条目;
    // 点行直接进该 skill 的报告(eval 优先,否则 doctor),不再走中间 hub(/skills 已下线)。
    // 行跳转走 data-href + 事件委托(非内联 onclick,见 skill-list-renderer)。
    assert.ok(res.body.includes('data-href="/reports/') || res.body.includes('data-href="/doctors/'));
    assert.ok(!res.body.includes('data-href="/skills/'));
  });

  it('GET /reports/:id returns HTML detail page', async () => {
    const res = await fetch(`${baseUrl}/reports/test-run-001`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('passes ?lang=en through skill list and detail pages', async () => {
    const list = await fetch(`${baseUrl}/?lang=en`);
    assert.equal(list.status, 200);
    assert.ok(list.body.includes('data-lang="en"'));
    // 列表行链接到报告(reports/doctors)并保留 ?lang=en
    assert.ok(/data-href="\/(reports|doctors)\/[^"]*lang=en/.test(list.body));

    const detail = await fetch(`${baseUrl}/reports/test-run-001?lang=en`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.includes('data-lang="en"'));
    assert.ok(detail.body.includes('Evaluation Report'));
    assert.ok(detail.body.includes('Back to list'));
    assert.ok(!stripScriptAndStyle(detail.body).includes('评测报告'));
  });

  it('DELETE /api/reports/:id removes report', async () => {
    // Create a temp report to delete
    writeFileSync(join(TEST_DIR, 'to-delete.json'), JSON.stringify({ ...SAMPLE_REPORT, id: 'to-delete' }));

    const res = await fetch(`${baseUrl}/api/reports/to-delete`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    // Verify it's gone
    const check = await fetch(`${baseUrl}/api/reports/to-delete`);
    assert.equal(check.status, 404);
  });

  it('DELETE /api/reports/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/reports/nonexistent`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('GET /doctors/:id?skill= 批量 doctor 同 id 多文件时按 skill 选中对应 per-skill 文件', async () => {
    // persistDoctorReport 把批量 doctor 按 skill 拆成多份文件,每份 spread 同一个 report.id;
    // 修复前 loadDoctorReport 只按 id 命中 readdir 顺序的第一份,?skill= 第二个 skill 时
    // 可能渲染第一个 skill 的体检结果。
    const batchId = 'doctor-batch-20260610';
    const mkPerSkill = (skillName: string, ruleId: string) => ({
      kind: 'doctor',
      schemaVersion: '3.0.0',
      id: batchId,
      timestamp: '2026-06-10T10:00:00.000Z',
      cliVersion: '0.0.0-test',
      cwd: '/repo',
      executorName: 'claude',
      model: 'sonnet',
      skills: [{
        skillName,
        skillPath: `/repo/skills/${skillName}`,
        status: 'warn',
        results: [{ ruleId, severity: 'warn', labelKey: 'doctor.rule.test', status: 'warn', message: `${skillName} 警告`, durationMs: 1 }],
      }],
      ruleStats: { pass: 0, warn: 1, fail: 0, skipped: 0, total: 1 },
      totals: { pass: 0, warn: 1, fail: 0 },
      outcome: 'warnings_only',
    });
    writeFileSync(join(DOCTORS_DIR, `batch-skill-one-${batchId}.json`), JSON.stringify(mkPerSkill('batch-skill-one', 'rule-only-in-one'), null, 2));
    writeFileSync(join(DOCTORS_DIR, `batch-skill-two-${batchId}.json`), JSON.stringify(mkPerSkill('batch-skill-two', 'rule-only-in-two'), null, 2));
    try {
      const res = await fetch(`${baseUrl}/doctors/${batchId}?skill=batch-skill-two`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type']!.includes('text/html'));
      assert.ok(res.body.includes('batch-skill-two'), '应渲染 ?skill= 指定 skill 的体检结果');
      assert.ok(res.body.includes('rule-only-in-two'), '应包含第二个 skill 独有的规则');
      assert.ok(!res.body.includes('rule-only-in-one'), '不应渲染另一个 per-skill 文件独有的规则');
      assert.ok(!res.body.includes('batch-skill-one'), '不应回退展示第一个 skill');
    } finally {
      rmSync(join(DOCTORS_DIR, `batch-skill-one-${batchId}.json`), { force: true });
      rmSync(join(DOCTORS_DIR, `batch-skill-two-${batchId}.json`), { force: true });
    }
  });

  it('GET /doctors/:id 不存在时返回 404 + 中文文案(?lang=en 走英文)', async () => {
    const res = await fetch(`${baseUrl}/doctors/no-such-doctor-id`);
    assert.equal(res.status, 404);
    assert.ok(res.body.includes('体检报告不存在'));

    const en = await fetch(`${baseUrl}/doctors/no-such-doctor-id?lang=en`);
    assert.equal(en.status, 404);
    assert.ok(en.body.includes('doctor report not found'));
  });

  it('GET /skills/:name 已下线(hub 不再存在,不做兼容重定向)→ 404', async () => {
    const res = await fetch(`${baseUrl}/skills/v1`);
    assert.equal(res.status, 404);
  });

  it('GET unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  });
});

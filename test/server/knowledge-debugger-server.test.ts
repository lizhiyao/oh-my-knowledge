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
import { createObservationConversationCatalog } from '../../src/observability/conversation-view-model.js';
import { renderKnowledgeDebuggerPage } from '../../src/renderer/knowledge-debugger-renderer.js';
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

describe('Knowledge Debugger task trajectory server', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-debugger-server-'));
  const observationsDir = join(root, 'observations');
  const reportsDir = join(root, 'reports');
  const jobsDir = join(root, 'jobs');
  const tracePath = join(root, 'rollout-codex.jsonl');
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';
  let experienceSessionId = '';
  let threadId = '';
  let turnId = '';
  let debuggerModel: ReturnType<typeof buildKnowledgeDebuggerViewModel>;

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
    threadId = report.experience.sessions[0].threadId;
    turnId = report.experience.sessions[0].turns[0]!.turnId;
    debuggerModel = buildKnowledgeDebuggerViewModel(report.experience.sessions[0], turnId, report.meta.ingestion);
    server = createReportServer({
      port: 0,
      observationsDir,
      reportsDir,
      jobsDir,
      conversationCatalog: createObservationConversationCatalog(observationsDir),
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('links an observed session to a fact-only task trajectory', async () => {
    const inbox = await fetch(`${baseUrl}/observe-inbox`);
    assert.equal(inbox.status, 200);
    assert.match(inbox.body, new RegExp(`/conversations/${encodeURIComponent(threadId)}`));
    assert.match(inbox.body, /查看对话任务/);

    const conversations = await fetch(`${baseUrl}/conversations`);
    assert.equal(conversations.status, 200);
    assert.match(conversations.body, /conversation-app-nav/);
    assert.match(conversations.body, /<h1>对话<\/h1>/);
    assert.match(conversations.body, /class="conversation-page conversation-index-app"/);
    assert.match(conversations.body, /data-page-next/);
    assert.match(conversations.body, new RegExp(`/conversations/${encodeURIComponent(threadId)}`));

    const conversation = await fetch(`${baseUrl}/conversations/${encodeURIComponent(threadId)}`);
    assert.equal(conversation.status, 200);
    assert.match(conversation.body, /检查并发布当前版本/);
    assert.match(conversation.body, new RegExp(`turnId=${encodeURIComponent(turnId)}`));

    const missingTurn = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}`);
    assert.equal(missingTurn.status, 302);

    const replay = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}?turnId=${encodeURIComponent(turnId)}`);
    assert.equal(replay.status, 200);
    assert.match(replay.body, /任务轨迹/);
    assert.match(replay.body, /任务轨迹/);
    assert.match(replay.body, /class="trajectory-meta-source">Codex<\/span>/);
    assert.match(replay.body, /class="trajectory-meta-time">/);
    assert.doesNotMatch(replay.body, /trajectory-eyebrow/);
    assert.match(replay.body, /对话/);
    assert.match(replay.body, /data-lane="conversation" style="--lane-rows:2;/);
    assert.match(replay.body, /data-conversation-role="user" style="[^"]*--event-row:0[^"]*"/);
    assert.match(replay.body, /data-conversation-role="assistant" style="[^"]*--event-row:1[^"]*"/);
    const conversationCards = [...replay.body.matchAll(/<button class="trajectory-event[^"]*"[^>]*data-conversation-role="(?:user|assistant)"[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0]);
    assert.ok(conversationCards.length > 0);
    assert.ok(conversationCards.some((card) => /trajectory-event-kind">用户<\/span>/.test(card)));
    assert.ok(conversationCards.some((card) => /trajectory-event-kind">AI<\/span>/.test(card)));
    assert.ok(conversationCards.some((card) => /trajectory-event-kind">模型思考<\/span>/.test(card)));
    assert.match(replay.body, /检查发布证据/);
    assert.match(replay.body, /内容不可见/);
    assert.match(replay.body, /trajectory-event is-reasoning is-compact/);
    assert.match(replay.body, /trajectory-event is-reasoning is-compact[^>]*aria-label="[0-9:.]+ · 模型思考 · 不可见"/);
    assert.doesNotMatch(replay.body, /ciphertext-must-not-be-rendered|second-ciphertext-must-not-be-rendered/);
    assert.ok(conversationCards.every((card) => !card.includes('trajectory-event-detail')));
    assert.doesNotMatch(replay.body, /trajectory-event-kind">工具结果 ·/);
    assert.doesNotMatch(replay.body, /trajectory-event-kind">[^<]+ · 工具执行/);
    assert.match(replay.body, /has-two-rows \.trajectory-event\[data-event-row="0"\]\{top:25%\}/);
    assert.match(replay.body, /has-two-rows \.trajectory-event\[data-event-row="1"\]\{top:75%\}/);
    assert.match(replay.body, /\.trajectory-event\{[^}]*height:56px/);
    assert.match(replay.body, /\.trajectory-event\.is-compact\{[^}]*width:14px;height:14px/);
    assert.match(replay.body, /\.trajectory-lane\.has-two-rows \.trajectory-event\.is-compact\{top:50%\}/);
    assert.doesNotMatch(replay.body, /trajectory-lane\[data-lane="conversation"\] \.trajectory-track:before/);
    assert.doesNotMatch(replay.body, /trajectory-conversation-links|updateConversationLinks/);
    assert.match(replay.body, /\.trajectory-event-title\{[^}]*-webkit-line-clamp:2/);
    assert.match(replay.body, /\.trajectory-event\.has-detail \.trajectory-event-title\{[^}]*white-space:nowrap/);
    assert.match(replay.body, /\.trajectory-event\.is-primary\{box-shadow:0 0 0 2px var\(--event-ring/);
    assert.match(replay.body, /\.trajectory-event\.is-action\{[^}]*--event-ring:rgba\(217,119,6,\.3\)/);
    assert.match(replay.body, /\.trajectory-event\.is-result\{[^}]*--event-ring:rgba\(31,157,99,\.3\)/);
    assert.match(replay.body, /trajectory-event-head/);
    assert.match(replay.body, /<strong>知识<\/strong><span>何时、从何处出现<\/span>/);
    assert.match(replay.body, /执行/);
    assert.match(replay.body, /结果/);
    assert.match(replay.body, /<strong>结果<\/strong><span>工具返回及调用状态<\/span>/);
    assert.ok(replay.body.indexOf('data-lane="conversation"') < replay.body.indexOf('data-lane="action"'));
    assert.ok(replay.body.indexOf('data-lane="action"') < replay.body.indexOf('data-lane="result"'));
    assert.ok(replay.body.indexOf('data-lane="result"') < replay.body.indexOf('data-lane="knowledge"'));
    assert.match(replay.body, /\.trajectory-link\.is-knowledge\{[^}]*stroke-dasharray:4 4/);
    assert.match(replay.body, /\.trajectory-link\.is-call-result\{[^}]*opacity:\.56/);
    assert.match(replay.body, /\.trajectory-link\.is-active\{[^}]*opacity:1/);
    assert.match(replay.body, /\.trajectory-link\.is-flow\{[^}]*opacity:\.28/);
    assert.match(replay.body, /const updateOperationLinks = \(\) =>/);
    assert.match(replay.body, /if \(!lanes \|\| !operationLinks \|\| shell\.dataset\.mode !== 'semantic'\) return/);
    assert.match(replay.body, /const setLinkActivity = \(activeId = ''\) =>/);
    assert.match(replay.body, /const linksByOperation = new Map\(\)/);
    assert.match(replay.body, /linksByOperation\.clear\(\)/);
    assert.match(replay.body, /activeLinkElements = activeId \? \(linksByOperation\.get\(activeId\) \|\| \[\]\) : \[\]/);
    assert.doesNotMatch(replay.body, /operationLinks\.querySelectorAll\('\[data-link-operations\]'\)/);
    assert.match(replay.body, /const scheduleOperationLinks = \(\) =>/);
    assert.match(replay.body, /if \(pendingLayoutFrame !== undefined\) cancelAnimationFrame\(pendingLayoutFrame\)/);
    assert.match(replay.body, /updateOperationLinks\(\);/);
    assert.match(replay.body, /const path = createFlowPath\(previous\.endCard, operation\.startCard, relatedOperationIds\)/);
    assert.match(replay.body, /path\.getPointAtLength\(pathLength \* progress\)/);
    assert.match(replay.body, /function routingRectPort\(rect, side\)/);
    assert.match(replay.body, /const corridorXs = \[\s*points\.from\.x,\s*points\.to\.x,/);
    assert.match(replay.body, /function routingRoundedPolylinePath\(routePoints, radius = 10\)/);
    assert.match(replay.body, /function createHorizontalObstacleIndex\(rects, bucketSize = 240\)/);
    assert.match(replay.body, /const obstacleIndex = createHorizontalObstacleIndex/);
    assert.match(replay.body, /const route = planFlowRoute\(\{/);
    assert.match(replay.body, /if \(!route\) return undefined/);
    assert.match(replay.body, /path\.setAttribute\('d', route\.d\)/);
    assert.match(replay.body, /window\.__omkTrajectoryMetrics = \{/);
    assert.doesNotMatch(replay.body, /cubicHitsRect/);
    assert.match(replay.body, /data-flow-from/);
    assert.match(replay.body, /data-link-operations/);
    assert.match(replay.body, /\.trajectory-lane\{[^}]*pointer-events:none/);
    assert.match(replay.body, /\.trajectory-event\{[^}]*pointer-events:auto/);
    assert.match(replay.body, /const primaryOperations = operationEntries\.filter/);
    assert.doesNotMatch(replay.body, /cardLane\(from\) === 'conversation' && cardLane\(to\) === 'conversation'/);
    assert.match(replay.body, /const connectionPoints = \(fromRect, toRect\) =>/);
    assert.match(replay.body, /' L ' \+ points\.to\.x \+ ' ' \+ points\.to\.y/);
    assert.match(replay.body, /routeKind: ["']quadratic["']/);
    assert.match(replay.body, /if \(fromLane === toLane\) return (?:undefined|void 0)/);
    assert.ok(replay.body.indexOf('if (direct && lineIsClear') < replay.body.indexOf('for (const candidate of curveCandidates)'));
    assert.ok(replay.body.indexOf('for (const candidate of curveCandidates)') < replay.body.indexOf('const allObstacles = obstacleIndex.all'));
    assert.doesNotMatch(replay.body, /horizontalGap >= 12/);
    assert.match(replay.body, /\.trajectory-link-arrow\{fill:rgba\(99,112,131,\.7\);[^}]*stroke:none/);
    assert.match(replay.body, /card\.addEventListener\('mouseenter', previewOperation, \{ signal: pageLifecycle\.signal \}\)/);
    assert.match(replay.body, /card\.addEventListener\('focus', previewOperation, \{ signal: pageLifecycle\.signal \}\)/);
    assert.match(replay.body, /if \(!currentOperationId\) setLinkActivity\(operationId\)/);
    assert.doesNotMatch(replay.body, /if \(!currentOperationId\) updateOperationLinks\(operationId\)/);
    assert.match(replay.body, /const substantiveOperations = primaryOperations\.filter/);
    assert.match(replay.body, /function planFlowMarkerProgresses\(pathLength, markerCount\)/);
    assert.match(replay.body, /const blockingRects = cards\.filter/);
    assert.match(replay.body, /const reservedCallResultChannels = operationEntries\.flatMap/);
    assert.match(replay.body, /\.\.\.reservedCallResultChannels/);
    assert.match(replay.body, /const markerObstacles = \[\.\.\.blockingRects, \.\.\.reservedCallResultChannels\]/);
    assert.match(replay.body, /const laneBoundaries = \[\.\.\.document\.querySelectorAll\('\.trajectory-lane'\)\]/);
    assert.match(replay.body, /const laneBoundaryClearance = \(y\) =>/);
    assert.match(replay.body, /const markerCollides = \(x, y\) =>/);
    assert.match(replay.body, /const idealProgresses = planFlowMarkerProgresses\(pathLength, markerOperations\.length\)/);
    assert.match(replay.body, /const endpointClearance = Math\.min\(18, pathLength \/ 2\)/);
    assert.match(replay.body, /candidate\.sourceDistance >= endpointClearance/);
    assert.match(replay.body, /candidate\.destinationDistance >= endpointClearance/);
    assert.match(replay.body, /Math\.abs\(candidate\.progress - idealProgress\)/);
    assert.doesNotMatch(replay.body, /compactTemporalPositions/);
    assert.match(replay.body, /Math\.max\(0, 36 - candidate\.clearance\) \* 8/);
    assert.match(replay.body, /Math\.max\(0, 30 - candidate\.boundaryClearance\) \* 10/);
    assert.doesNotMatch(replay.body, /laneDistance\(candidate\.point\.y\)/);
    assert.match(replay.body, /marker\.style\.left = \(lanesRect\.left \+ target\.x - trackRect\.left\) \+ 'px'/);
    assert.match(replay.body, /marker\.style\.top = \(lanesRect\.top \+ target\.y - trackRect\.top\) \+ 'px'/);
    assert.match(replay.body, /const knowledgeSource = operation\.resultCard \|\| operation\.actionCard/);
    assert.match(replay.body, /connectStraight\(knowledgeSource, card, 'knowledge', \[operation\.id\], false\)/);
    assert.match(replay.body, /const source = previous\?\.endCard \|\| next\?\.startCard/);
    assert.doesNotMatch(replay.body, /const source = next\?\.startCard \|\| previous\?\.endCard/);
    const positionedCards = [...replay.body.matchAll(/<button class="trajectory-event ([^"]*)"[^>]*style="--event-x:(-?\d+)px;--event-row:\d+;--event-card-width:(\d+)px" data-trajectory-operation="([^"]+)"/g)]
      .map((match) => ({ classes: match[1], x: Number(match[2]), width: Number(match[3]), operationId: match[4] }));
    const toolOperationId = positionedCards.find((card) => card.classes.includes('is-action'))?.operationId;
    assert.ok(toolOperationId);
    const toolColumnCards = positionedCards.filter((card) => card.operationId === toolOperationId && /is-(action|result|knowledge)/.test(card.classes));
    assert.ok(toolColumnCards.length >= 2);
    const toolColumnCenter = toolColumnCards[0].x + toolColumnCards[0].width / 2;
    assert.ok(toolColumnCards.every((card) => Math.abs(card.x + card.width / 2 - toolColumnCenter) <= 1));
    assert.match(replay.body, /检查并发布当前版本/);
    assert.match(replay.body, /AGENTS\.md/);
    assert.match(replay.body, /项目规则 · 已注入/);
    assert.match(replay.body, /读取 release Skill/);
    assert.match(replay.body, /missing doctor\/eval evidence/);
    assert.match(replay.body, /版本已经可以发布/);
    assert.match(replay.body, /用户纠正/);
    assert.match(replay.body, /data-trajectory-mode="semantic"/);
    assert.match(replay.body, /data-trajectory-mode="normalized"/);
    assert.match(replay.body, /data-trajectory-mode="source"/);
    assert.match(replay.body, /data-short-label="轨迹"/);
    assert.match(replay.body, /data-short-label="事件"/);
    assert.match(replay.body, /data-short-label="日志"/);
    assert.match(replay.body, /\.trajectory-mode button:after\{content:attr\(data-short-label\);font-size:10px\}/);
    assert.match(replay.body, new RegExp(`data-source-records-endpoint="/api/observe-debugger/${encodeURIComponent(experienceSessionId)}/source-records"`));
    assert.match(replay.body, /data-source-records-loaded="false"/);
    assert.match(replay.body, /data-operation-evidence/);
    assert.match(replay.body, /data-evidence-source-event-id="[^"]+"/);
    assert.match(replay.body, /data-evidence-source-line-index="\d+"/);
    assert.match(replay.body, /data-detail-source-line-index="\d+"/);
    assert.match(replay.body, /data-view-evidence/);
    assert.match(replay.body, /查看原始日志/);
    assert.match(replay.body, /const revealEvidence = async \(target\) =>/);
    assert.match(replay.body, /await loadSourceRecords\(\)/);
    assert.match(replay.body, /matchingSourceRow\(sourceLineIndex, traceId\)/);
    assert.match(replay.body, /row\.scrollIntoView/);
    assert.match(replay.body, /is-evidence-target/);
    assert.doesNotMatch(replay.body, /"sourceTrace":/);
    assert.match(replay.body, /const closeInspector = \(shouldScheduleLayout = true\) =>/);
    assert.match(replay.body, /grid-template-columns:minmax\(0,1fr\) 0;align-items:stretch;transition:grid-template-columns/);
    assert.match(replay.body, /shell\.dataset\.inspectorOpen !== 'true'\) beginLayoutTransition\(\)/);
    assert.match(
      replay.body,
      /isScrollTrackingSuppressed: \(\) => shell\.dataset\.layoutTransition === 'true'[\s\S]*shell\.dataset\.inspectorRestoring === 'true'/,
    );
    assert.match(replay.body, /new ResizeObserver\(scheduleOperationLinks\)/);
    assert.match(replay.body, /revealSelectedOperation\(\)/);
    assert.match(replay.body, /if \(!alignFollowingViewport\(\)\) revealSelectedOperation\(\)/);
    assert.match(replay.body, /layoutScrollReleaseTimer = window\.setTimeout\(\(\) =>/);
    assert.match(replay.body, /selectOperation\(restoredOperationId, false\)/);
    assert.doesNotMatch(replay.body, /currentOperationId = id;\s*pauseLiveFollow\(\)/);
    assert.doesNotMatch(replay.body, /isInteractionBlocking/);
    assert.match(replay.body, /replacement\.dataset\.selectedOperationId = selectedOperationId/);
    assert.match(replay.body, /replacement\.dataset\.inspectorRestoring = 'true'/);
    assert.match(replay.body, /data-inspector-restoring="true"/);
    assert.match(replay.body, /replacement\.dataset\.inspectorScrollTop = String\(inspectorScrollTop\)/);
    assert.match(replay.body, /replacement\.dataset\.expandedDetailSourceEventIds = JSON\.stringify/);
    assert.match(replay.body, /if \(shouldScheduleLayout\) scheduleOperationLinks\(\)/);
    assert.match(replay.body, /const setTrajectoryMode = \(mode\) =>/);
    assert.match(replay.body, /if \(mode !== 'semantic'\) closeInspector\(false\)/);
    assert.match(replay.body, /else scheduleOperationLinks\(\)/);
    assert.ok(replay.body.indexOf('shell.dataset.mode = mode') < replay.body.indexOf("if (mode !== 'semantic') closeInspector(false)"));
    assert.doesNotMatch(replay.body, /if \(mode !== 'semantic'\) closeInspector\(\)/);
    assert.match(replay.body, /data-trajectory-facet=/);
    assert.match(replay.body, /aria-label="类型筛选"/);
    assert.doesNotMatch(replay.body, /聚焦类型/);
    assert.match(replay.body, /is-facet-muted/);
    assert.match(replay.body, /data-trajectory-operation="operation-/);
    assert.doesNotMatch(replay.body, /trajectory-overview|任务概览/);
    assert.match(replay.body, /class="trajectory-inspector" aria-live="polite" hidden/);
    assert.match(replay.body, /data-inspector-close/);
    assert.match(replay.body, /data-inspector-open/);
    assert.match(replay.body, /\.trajectory-operation-copy h3\{[^}]*overflow-wrap:anywhere;white-space:normal\}/);
    assert.doesNotMatch(replay.body, /\.trajectory-operation-copy h3\{[^}]*-webkit-line-clamp/);
    assert.doesNotMatch(replay.body, /<button class="trajectory-event[^"]*\bis-related\b/);
    assert.doesNotMatch(replay.body, /<button class="trajectory-event[^"]*\bis-dimmed\b/);
    assert.match(replay.body, /\.trajectory-semantic-panels\{min-height:0;overflow:auto/);
    assert.match(replay.body, /class="trajectory-raw-list"/);
    assert.match(replay.body, /data-trajectory-normalized-event="[^"]+"[^>]*data-trajectory-facets="[^"]*tool:/);
    assert.match(replay.body, /normalizedRows\.forEach/);
    assert.match(replay.body, /row\.hidden = !matches/);
    assert.match(replay.body, /没有符合当前类型筛选的规范化事件/);
    assert.match(replay.body, /按来源顺序排列的规范化事件/);
    assert.match(replay.body, /按来源顺序排列的原始日志/);
    assert.match(replay.body, /不透明加密载荷已省略/);
    assert.doesNotMatch(replay.body, /trajectory-raw-panels|data-trajectory-raw-panel/);
    assert.doesNotMatch(replay.body, /has-grow-field|trajectory-field is-grow/);
    assert.match(replay.body, /class="trajectory-scroll" tabindex="0" aria-label="完整任务时间轴"/);
    assert.doesNotMatch(replay.body, /data-trajectory-scale|data-scale=/);
    assert.match(replay.body, /body\{height:100dvh;min-height:0;overflow:hidden/);
    assert.match(replay.body, /class="trajectory-links"/);
    assert.match(replay.body, /data-link-kind/);
    assert.doesNotMatch(replay.body, /trajectory-operation-band/);
    assert.doesNotMatch(replay.body, /--timeline-width:/);
    assert.match(replay.body, /class="trajectory-boundary-info"/);
    assert.doesNotMatch(replay.body, /class="trajectory-boundary"/);
    assert.match(replay.body, /aria-label="了解三类信息"/);
    assert.match(replay.body, /原始日志 → 规范化事件 → 语义轨迹/);
    assert.match(replay.body, /经脱敏和有界归档后保留的来源日志原文/);
    assert.doesNotMatch(replay.body, /Codex 写入、经脱敏和有界归档/);
    assert.match(replay.body, /不代表模型实际采用了它/);
    assert.match(replay.body, /boundaryInfo\.open = false/);
    assert.match(replay.body, /boundarySummary\?\.focus\(\)/);
    assert.match(replay.body, /boundaryInfo\.contains\(event\.target\)/);
    assert.doesNotMatch(replay.body, /返回观测收件箱|trajectory-pagebar|trajectory-back/);
    assert.doesNotMatch(replay.body, /事实摘要|任务经过|本次出现的 Knowledge|任务事实|Trace 完整性|查看失败操作/);
    assert.doesNotMatch(replay.body, /运行时证据 · 工具返回[^]*<span class="trajectory-event-title">Bash/);
    assert.doesNotMatch(replay.body, /AI (?:使用|采用)了/);
    assert.doesNotMatch(replay.body, /knowledge-gap-form|候选 knowledge|omk sample --from-traces/);

    const sourceRecords = await fetch(`${baseUrl}/api/observe-debugger/${encodeURIComponent(experienceSessionId)}/source-records`);
    assert.equal(sourceRecords.status, 200);
    const sourceArchive = JSON.parse(sourceRecords.body) as {
      status: string;
      recordCount: number;
      records: Array<{ raw: string; redacted: boolean }>;
    };
    assert.equal(sourceArchive.status, 'available');
    assert.equal(sourceArchive.recordCount, sourceArchive.records.length);
    assert.ok(sourceArchive.records.some((record) => record.redacted));
    assert.match(sourceRecords.body, /opaque encrypted content omitted/);
    assert.doesNotMatch(sourceRecords.body, /ciphertext-must-not-be-rendered|second-ciphertext-must-not-be-rendered/);
  });

  it('shows the recorded model on AI cards without labeling user cards', () => {
    const modeledSteps = debuggerModel.steps.map((step) => ({
      ...step,
      events: step.events.map((event) => (
        step.stepKind === 'assistant_message' || step.stepKind === 'model_activity'
          ? { ...event, model: 'gpt-5.4' }
          : event
      )),
    }));
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: modeledSteps,
      summary: { ...debuggerModel.summary, observedModels: ['gpt-5.4'] },
    });

    assert.match(html, /class="trajectory-meta-model" title="gpt-5\.4">gpt-5\.4<\/span>/);
    const conversationCards = [...html.matchAll(/<button class="trajectory-event[^"]*"[^>]*data-conversation-role="(?:user|assistant)"[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0]);
    const assistantCards = conversationCards.filter((card) => card.includes('data-conversation-role="assistant"'));
    const userCards = conversationCards.filter((card) => card.includes('data-conversation-role="user"'));
    assert.ok(assistantCards.length > 0);
    assert.ok(assistantCards.every((card) => /trajectory-event-model" title="gpt-5\.4">gpt-5\.4<\/span>/.test(card)));
    assert.ok(userCards.length > 0);
    assert.ok(userCards.every((card) => !card.includes('trajectory-event-model')));
    assert.match(html, /<span class="trajectory-event-kind">AI<\/span><span class="trajectory-event-model" title="gpt-5\.4">gpt-5\.4<\/span>/);
    assert.match(html, /<span class="trajectory-field-label">模型<\/span><strong class="trajectory-field-value">gpt-5\.4<\/strong>/);
    const assistantGeometry = [...html.matchAll(/<button[^>]*data-conversation-role="assistant"[^>]*style="--event-x:(\d+)px;--event-row:1;--event-card-width:(\d+)px"/g)]
      .map((match) => ({ position: Number(match[1]), width: Number(match[2]) }))
      .sort((left, right) => left.position - right.position);
    assistantGeometry.slice(1).forEach((card, index) => {
      const previous = assistantGeometry[index];
      assert.ok(card.position >= previous.position + previous.width, 'modeled assistant cards must not overlap');
    });
  });

  it('renders one accurate notice for a partial raw-log archive', () => {
    const lazyHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      sourceRecords: {
        status: 'partial',
        recordCount: 1,
        records: [],
        omittedRecordCount: 0,
        byteCount: 128,
        truncated: true,
      },
    }, 'zh', { sourceRecordsEndpoint: '/api/source-records' });
    assert.doesNotMatch(lazyHtml, /<div class="trajectory-record-notice">/);
    assert.match(lazyHtml, /部分原始日志内容已按归档上限截断/);

    const eagerHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      sourceRecords: {
        status: 'partial',
        recordCount: 1,
        records: [{
          sourceIndex: 0,
          traceId: 'trace-partial',
          sourceTrace: 'fixture.jsonl',
          sourceType: 'response_item',
          raw: '{"type":"response_item"}',
          byteCount: 128,
          truncated: true,
          redacted: false,
        }],
        omittedRecordCount: 0,
        byteCount: 128,
        truncated: true,
      },
    });
    assert.equal([...eagerHtml.matchAll(/<div class="trajectory-record-notice">/g)].length, 1);
    assert.match(eagerHtml, /部分原始日志内容已按归档上限截断/);
    assert.doesNotMatch(eagerHtml, /省略 0 条/);
  });

  it('renders safe inline Markdown in trajectory cards', () => {
    const reasoningStep = debuggerModel.steps.find((step) =>
      step.stepKind === 'model_activity' && step.events[0]?.contentVisibility !== 'opaque');
    assert.ok(reasoningStep);
    const markdown = '**Tracing unexpected process respawn**';
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === reasoningStep.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: markdown, snippet: markdown }
              : event),
          }
        : step),
    });

    assert.match(html, /trajectory-event-title"><strong>Tracing unexpected process respawn<\/strong>/);
    assert.doesNotMatch(html, /trajectory-event-title">\*\*/);
    assert.match(html, /title="00:\d{2}\.\d · 模型思考 · Tracing unexpected process respawn"/);
  });

  it('keeps full message content in the inspector while cards remain compact', () => {
    const assistantStep = debuggerModel.steps.find((step) => step.stepKind === 'assistant_message');
    assert.ok(assistantStep);
    const fullContent = `**Complete answer** ${'observable detail '.repeat(24)}DETAIL_END_MARKER`;
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === assistantStep.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: fullContent, snippet: fullContent }
              : event),
          }
        : step),
    });

    const assistantCard = [...html.matchAll(/<button class="trajectory-event[^"]*"[^>]*data-conversation-role="assistant"[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((card) => card.includes('Complete answer'));
    assert.ok(assistantCard);
    assert.doesNotMatch(assistantCard, /DETAIL_END_MARKER/);
    assert.match(html, /<div class="trajectory-field-content"><strong>Complete answer<\/strong>[\s\S]*DETAIL_END_MARKER<\/div>/);
  });

  it('shows observable context content in the inspector and distinguishes missing source content', () => {
    const contextStep = debuggerModel.steps.find((step) => step.stepKind === 'runtime_context');
    assert.ok(contextStep);
    const contextEvent = contextStep.events[0];
    assert.ok(contextEvent);
    const contextContent = Array.from({ length: 12 }, (_value, index) => `context line ${index + 1}`).join('\n');
    const withContent = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      normalizedEvents: debuggerModel.normalizedEvents.map((event) => event.id === contextEvent.id
        ? { ...event, fullText: contextContent, snippet: 'context summary' }
        : event),
      steps: debuggerModel.steps.map((step) => step.id === contextStep.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: contextContent, snippet: 'context summary' }
              : event),
          }
        : step),
    });

    assert.match(withContent, /<span class="trajectory-field-label">上下文内容<\/span>/);
    assert.match(withContent, /源日志已记录可见内容/);
    assert.match(withContent, new RegExp(`data-detail-source-event-id="${contextEvent.id}"`));
    assert.match(withContent, new RegExp(`data-detail-source-line-index="${contextEvent.sourceLineIndex}"`));
    assert.match(withContent, /data-preview-status="已显示 8 \/ 12 行"/);
    assert.match(withContent, /data-expand-label="展开完整内容"/);

    const shortContent = '{"cwd":"/tmp/copyable-execution-context"}';
    const withShortContent = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      normalizedEvents: debuggerModel.normalizedEvents.map((event) => event.id === contextEvent.id
        ? { ...event, fullText: shortContent, snippet: shortContent, runtimeKind: 'execution_context' }
        : event),
      steps: debuggerModel.steps.map((step) => step.id === contextStep.id
        ? {
            ...step,
            title: 'execution_context',
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: shortContent, snippet: shortContent, runtimeKind: 'execution_context' }
              : event),
          }
        : step),
    });
    assert.match(withShortContent, /copyable-execution-context/);
    assert.match(withShortContent, /data-expandable="false"/);
    assert.match(withShortContent, /data-copy-label="复制内容"/);
    assert.match(withShortContent, /data-field-detail-copy aria-label="复制内容"/);

    const withoutContent = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === contextStep.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: undefined, snippet: undefined }
              : event),
          }
        : step),
    });
    assert.match(withoutContent, /源日志未记录上下文内容/);
    assert.match(withoutContent, /当前规范化事件只保留了上下文类型与元数据。/);
  });

  it('distinguishes historical missing results from live pending results', () => {
    const exchange = debuggerModel.steps.find((step) => step.stepKind === 'tool_exchange');
    assert.ok(exchange);
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === exchange.id
        ? { ...step, events: step.events.slice(0, 1) }
        : step),
    });

    assert.match(html, /结果缺失/);
    assert.doesNotMatch(html, /结果获取中/);
    assert.match(html, /trajectory-event is-warning/);
  });

  it('renders English without hidden-reasoning claims and rejects unknown sessions', async () => {
    const replay = await fetch(`${baseUrl}/observe-debugger/${encodeURIComponent(experienceSessionId)}?turnId=${encodeURIComponent(turnId)}&lang=en`);
    assert.equal(replay.status, 200);
    assert.match(replay.body, /Task Trajectory/);
    assert.match(replay.body, /Task trajectory/);
    assert.match(replay.body, /About the three views/);
    assert.match(replay.body, /Conversation/);
    assert.match(replay.body, /Model reasoning/);
    assert.match(replay.body, /Content unavailable/);
    assert.match(replay.body, /Actions/);
    assert.match(replay.body, /Results/);
    assert.match(replay.body, /Tool returns and call status/);
    assert.match(replay.body, /Normalized events/);
    assert.match(replay.body, /Raw logs/);
    assert.match(replay.body, /Source log records retained after redaction and bounded archiving/);
    assert.match(replay.body, /User correction/);
    assert.doesNotMatch(replay.body, /Back to observation inbox/);
    assert.doesNotMatch(replay.body, /hidden (thought|reasoning)|chain of thought/i);
    assert.equal((await fetch(`${baseUrl}/observe-debugger/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/observe-debugger/%E0%A4%A`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/observe-debugger/missing/source-records`)).status, 404);
  });

  it('keeps verbose tool payloads out of the operation heading', () => {
    const exchange = debuggerModel.steps.find((step) =>
      step.stepKind === 'tool_exchange' && step.knowledgeEvidenceIds.length === 0);
    assert.ok(exchange);
    const patchInput = `const patch = "*** Begin Patch\\n*** Add File: /private/tmp/example-client.mjs\\n+${'x'.repeat(600)}\\n*** End Patch";`;
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === exchange.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: patchInput, snippet: patchInput }
              : event),
          }
        : step),
    });

    assert.match(html, /data-title="新增文件：\/private\/tmp\/example-client\.mjs"/);
    assert.doesNotMatch(html, /data-title="const patch/);
    assert.match(html, /class="trajectory-field-detail"[^>]*>const patch =/);
  });

  it('presents long tool results as an explicit expandable preview', () => {
    const exchange = debuggerModel.steps.find((step) =>
      step.stepKind === 'tool_exchange' && step.events.length > 1);
    assert.ok(exchange);
    const result = exchange.events[1];
    assert.ok(result);
    const output = Array.from({ length: 12 }, (_value, index) => `result line ${index + 1}`).join('\n');
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === exchange.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 1
              ? { ...event, fullText: output, snippet: output }
              : event),
          }
        : step),
    });

    assert.match(html, /data-detail-source-event-id="[^"]+"/);
    assert.match(html, /data-preview-status="已显示 8 \/ 12 行"/);
    assert.match(html, /data-full-status="完整内容 · 12 行"/);
    assert.match(html, /data-expand-label="展开完整结果"/);
    assert.match(html, /data-copy-label="复制结果"/);
    const preview = html.match(/data-copy-label="复制结果"[^>]*><code class="trajectory-field-detail" data-field-detail>([\s\S]*?)<\/code>/)?.[1] ?? '';
    assert.match(preview, /result line 1/);
    assert.match(preview, /result line 8/);
    assert.doesNotMatch(preview, /result line 9/);
  });

  it('derives compact operation summaries from observable tool input', () => {
    const exchange = debuggerModel.steps.find((step) =>
      step.stepKind === 'tool_exchange' && step.knowledgeEvidenceIds.length === 0);
    assert.ok(exchange);
    const toolInput = 'const matches = ALL_TOOLS.filter((tool) => /yuque/i.test(tool.name));';
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: debuggerModel.steps.map((step) => step.id === exchange.id
        ? {
            ...step,
            events: step.events.map((event, index) => index === 0
              ? { ...event, fullText: toolInput, snippet: toolInput }
              : event),
          }
        : step),
    });

    assert.match(html, /data-title="筛选可用工具"/);
    assert.doesNotMatch(html, /trajectory-event-title">const matches/);
    assert.match(html, /class="trajectory-field-detail"[^>]*>const matches =/);
  });

  it('derives source-neutral action and result summaries from structured CLI exchanges', () => {
    const exchange = debuggerModel.steps.find((step) =>
      step.stepKind === 'tool_exchange' && step.knowledgeEvidenceIds.length === 0);
    assert.ok(exchange);
    const cases = [
      {
        command: 'node /private/tmp/mcp_client.mjs call provider_doc_detail \'{"doc_id":42}\'',
        payload: { ok: true, data: { id: 42, title: '架构说明' } },
        actionTitle: '读取文档详情',
        resultTitle: '返回：架构说明',
      },
      {
        command: 'node /private/tmp/mcp_client.mjs call provider_book_toc \'{"book_id":7}\'',
        payload: { ok: true, data: [{ id: 1 }, { id: 2 }] },
        actionTitle: '读取知识库目录',
        resultTitle: '返回 2 项',
      },
      {
        command: 'node /private/tmp/mcp_client.mjs create-markdown-doc 7 parent "测试报告" /tmp/report.md',
        payload: { ok: true, data: { id: 43, title: '测试报告' } },
        actionTitle: '创建 Markdown 文档',
        resultTitle: '已创建：测试报告',
      },
      {
        toolName: 'Edit',
        command: '{}',
        payload: {},
        actionTitle: '编辑内容',
        resultTitle: '更新完成',
      },
      {
        toolName: 'wait',
        command: '{"cell_id":"72","yield_time_ms":30000}',
        payload: {},
        actionTitle: '等待后台任务',
        resultTitle: '等待结束',
      },
    ];

    for (const testCase of cases) {
      const wrappedResult = JSON.stringify({
        output: JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(testCase.payload) }],
        }),
      });
      const steps: typeof debuggerModel.steps = debuggerModel.steps.map((step) => step.id === exchange.id
        ? {
            ...step,
            toolStatus: 'success' as const,
            events: step.events.map((event, index) => index === 0
              ? {
                  ...event,
                  toolName: testCase.toolName ?? event.toolName,
                  fullText: JSON.stringify({ command: testCase.command }),
                  snippet: testCase.command,
                }
              : {
                  ...event,
                  isError: false,
                  toolStatus: 'success' as const,
                  fullText: `Script completed\nOutput: ${wrappedResult}`,
                  snippet: wrappedResult,
                }),
          }
        : step);
      assert.equal(steps.find((step) => step.id === exchange.id)?.toolStatus, 'success');
      const html = renderKnowledgeDebuggerPage({
        ...debuggerModel,
        steps,
      });

      assert.match(html, new RegExp(`data-title="${testCase.actionTitle}"`));
      assert.match(html, new RegExp(`trajectory-event-title">${testCase.resultTitle}<`));
      if (testCase.command.startsWith('node ')) {
        assert.match(html, /class="trajectory-field-detail"[^>]*>node \/private\/tmp\/mcp_client\.mjs/);
      } else if (testCase.toolName === 'wait') {
        assert.match(html, /class="trajectory-field-detail"[^>]*>\{&quot;cell_id&quot;/);
      } else {
        assert.match(html, /class="trajectory-field-detail"[^>]*>\{\}/);
      }
    }
  });

  it('renders lifecycle events as task boundaries instead of result cards', () => {
    const baseEvent = debuggerModel.steps[0]?.events[0];
    assert.ok(baseEvent);
    const startTimestamp = debuggerModel.summary.observedStartTimestamp ?? '2026-08-03T00:00:00.000Z';
    const sessionContextTimestamp = new Date(Date.parse(startTimestamp) - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endTimestamp = new Date(Date.parse(startTimestamp) + 10_000).toISOString();
    const sessionContextEvent = {
      ...baseEvent,
      id: 'session-context-before-task',
      kind: 'runtime_context' as const,
      runtimeKind: 'session_context' as const,
      order: -2,
      timestamp: sessionContextTimestamp,
      label: 'session_context',
      fullText: 'session context retained as evidence',
    };
    const startEvent = {
      ...baseEvent,
      id: 'lifecycle-start',
      kind: 'lifecycle' as const,
      order: -1,
      timestamp: startTimestamp,
      label: 'turn_started',
      fullText: 'turn_started',
    };
    const endEvent = {
      ...baseEvent,
      id: 'lifecycle-end',
      kind: 'lifecycle' as const,
      order: 999,
      timestamp: endTimestamp,
      label: 'turn_completed',
      fullText: 'turn_completed',
    };
    const nextTurnTimestamp = new Date(Date.parse(startTimestamp) + 5_000).toISOString();
    const nextTurnEvent = {
      ...baseEvent,
      id: 'lifecycle-next-turn',
      kind: 'lifecycle' as const,
      order: 500,
      timestamp: nextTurnTimestamp,
      label: 'turn_started',
      fullText: 'turn_started',
    };
    const [firstStep, ...remainingSteps] = debuggerModel.steps;
    assert.ok(firstStep);
    const html = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: [
        { id: 'step:session-context-before-task', order: -2, stepKind: 'runtime_context', timestamp: sessionContextTimestamp, title: 'session_context', events: [sessionContextEvent], knowledgeEvidenceIds: [] },
        { id: 'step:lifecycle-start', order: -1, stepKind: 'lifecycle', timestamp: startTimestamp, title: 'turn_started', events: [startEvent], knowledgeEvidenceIds: [] },
        firstStep,
        { id: 'step:lifecycle-next-turn', order: 500, stepKind: 'lifecycle', timestamp: nextTurnTimestamp, title: 'turn_started', events: [nextTurnEvent], knowledgeEvidenceIds: [] },
        ...remainingSteps,
        { id: 'step:lifecycle-end', order: 999, stepKind: 'lifecycle', timestamp: endTimestamp, title: 'turn_completed', events: [endEvent], knowledgeEvidenceIds: [] },
      ],
      summary: { ...debuggerModel.summary, observedStartTimestamp: startTimestamp, observedEndTimestamp: endTimestamp },
    });

    assert.match(html, /class="trajectory-milestone-axis is-start" style="left:4px"/);
    assert.doesNotMatch(html, /class="trajectory-gap-axis"/);
    assert.doesNotMatch(html, /43200 分钟|43200 minutes/);
    assert.match(html, /session context retained as evidence/);
    assert.doesNotMatch(html, /class="trajectory-milestone-line is-start" style="left:4px"/);
    const nextTurnAxis = html.match(/class="trajectory-milestone-axis is-start" style="left:(\d+)px"[^>]*><time>00:05\.0<\/time>/);
    assert.ok(nextTurnAxis);
    assert.notEqual(nextTurnAxis[1], '4');
    assert.match(html, new RegExp(`class="trajectory-milestone-line is-start" style="left:${nextTurnAxis[1]}px"`));
    assert.match(html, /class="trajectory-milestone-axis is-end"/);
    assert.match(html, /class="trajectory-milestone-line is-end"/);
    assert.match(html, /--event-x:16px/);
    assert.doesNotMatch(html, /<button class="trajectory-event[^"]*"[^>]*title="运行状态 · 本轮(?:开始|完成)"/);
  });

  it('lays out dense operations in semantic columns and compresses idle time', () => {
    const regularHtml = renderKnowledgeDebuggerPage(debuggerModel);
    for (const lane of ['action', 'result', 'knowledge']) {
      const laneHtml = regularHtml.match(new RegExp(`<section class="trajectory-lane[^"]*" data-lane="${lane}"[\\s\\S]*?<\\/section>`))?.[0];
      assert.ok(laneHtml);
      const laneCards = [...laneHtml.matchAll(/<button[^>]*style="--event-x:(\d+)px;--event-row:\d+;--event-card-width:(\d+)px"/g)]
        .map((match) => ({ position: Number(match[1]), width: Number(match[2]) }))
        .sort((left, right) => left.position - right.position);
      laneCards.slice(1).forEach((card, index) => {
        const previous = laneCards[index];
        assert.ok(card.position >= previous.position + previous.width, `${lane} cards must not overlap`);
      });
    }
    const compactSequenceSteps = [
      debuggerModel.steps.find((step) => step.stepKind === 'user_request'),
      debuggerModel.steps.find((step) => step.stepKind === 'model_activity' && step.events[0]?.contentVisibility === 'opaque'),
      debuggerModel.steps.find((step) => step.stepKind === 'assistant_message'),
    ].filter((step): step is NonNullable<typeof step> => step !== undefined);
    assert.equal(compactSequenceSteps.length, 3);
    const compactSequenceHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: compactSequenceSteps,
      summary: {
        ...debuggerModel.summary,
        observedStartTimestamp: compactSequenceSteps[0].timestamp,
        observedEndTimestamp: compactSequenceSteps[2].timestamp,
      },
    });
    const compactSequencePositions = [...compactSequenceHtml.matchAll(/<button class="trajectory-event[^"]*"[^>]*style="--event-x:(\d+)px/g)]
      .map((match) => Number(match[1]));
    assert.deepEqual(compactSequencePositions, [16, 154, 188]);
    const compactTickPositions = [...compactSequenceHtml.matchAll(/class="trajectory-tick" style="left:(\d+)px"/g)]
      .map((match) => Number(match[1]));
    const compactGuidePositions = [...compactSequenceHtml.matchAll(/class="trajectory-guide" style="left:(\d+)px"/g)]
      .map((match) => Number(match[1]));
    assert.deepEqual(compactTickPositions, [16, 188]);
    assert.deepEqual(compactGuidePositions, compactTickPositions);
    const sharedTimestamp = compactSequenceSteps[0].timestamp;
    const simultaneousHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: compactSequenceSteps.map((step) => ({
        ...step,
        timestamp: sharedTimestamp,
        events: step.events.map((event) => ({ ...event, timestamp: sharedTimestamp })),
      })),
      summary: {
        ...debuggerModel.summary,
        observedStartTimestamp: sharedTimestamp,
        observedEndTimestamp: sharedTimestamp,
      },
    });
    const simultaneousTickLabels = [...simultaneousHtml.matchAll(/class="trajectory-tick"[^>]*>([^<]+)<\/span>/g)]
      .map((match) => match[1]);
    assert.deepEqual(simultaneousTickLabels, ['00:00.0']);
    const startMs = Date.parse(debuggerModel.summary.observedStartTimestamp ?? '2026-08-03T00:00:00.000Z');
    const scaleTimestamp = (timestamp: string | undefined): string | undefined => {
      if (!timestamp) return undefined;
      return new Date(startMs + (Date.parse(timestamp) - startMs) * 20).toISOString();
    };
    const sparseLongHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      knowledgeEvidence: debuggerModel.knowledgeEvidence.map((item) => ({
        ...item,
        firstSeen: scaleTimestamp(item.firstSeen),
      })),
      steps: debuggerModel.steps.map((step) => ({
        ...step,
        timestamp: scaleTimestamp(step.timestamp),
        events: step.events.map((event) => ({ ...event, timestamp: scaleTimestamp(event.timestamp) })),
      })),
      summary: {
        ...debuggerModel.summary,
        observedEndTimestamp: scaleTimestamp(debuggerModel.summary.observedEndTimestamp),
      },
    });
    assert.doesNotMatch(regularHtml, /class="[^"]*\bis-marker\b/);
    assert.doesNotMatch(sparseLongHtml, /class="[^"]*\bis-marker\b/);

    const exchange = debuggerModel.steps.find((step) => step.stepKind === 'tool_exchange');
    assert.ok(exchange);
    const denseSteps = Array.from({ length: 15 }, (_value, index) => {
      const stepTimestamp = new Date(startMs + 1000 + index * 400).toISOString();
      return {
        ...exchange,
        id: `${exchange.id}-dense-${index}`,
        timestamp: stepTimestamp,
        events: exchange.events.map((event, eventIndex) => ({
          ...event,
          id: `${event.id}-dense-${index}`,
          timestamp: new Date(startMs + 1000 + index * 400 + eventIndex * 150).toISOString(),
        })),
      };
    });
    const denseHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: [...debuggerModel.steps.filter((step) => step.stepKind !== 'tool_exchange'), ...denseSteps],
      summary: {
        ...debuggerModel.summary,
        observedEndTimestamp: new Date(startMs + 7000).toISOString(),
      },
    });
    assert.doesNotMatch(denseHtml, /class="[^"]*\bis-marker\b/);
    assert.doesNotMatch(denseHtml, /class="trajectory-event is-(?:message|knowledge|action|result|failure|warning)[^"]*\bis-compact\b/);
    const adaptiveWidths = new Set([...denseHtml.matchAll(/--event-card-width:(\d+)px/g)].map((match) => Number(match[1])));
    assert.ok(adaptiveWidths.has(118));
    assert.ok(adaptiveWidths.size > 1);
    assert.match(denseHtml, /--event-x:\d+px/);
    assert.match(denseHtml, /\.trajectory-scroll\{min-width:0;min-height:0;overflow-x:auto;overflow-y:hidden/);
    assert.match(denseHtml, /--timeline-detail-width:\d+px/);
    assert.match(denseHtml, /width:max\(100%,var\(--timeline-detail-width\)\)/);
    assert.doesNotMatch(denseHtml, /--timeline-width:/);

    const operationPositions = new Map<string, Set<string>>();
    for (const match of denseHtml.matchAll(/<button[^>]+style="--event-x:(\d+)px[^"]*"[^>]+data-trajectory-operation="(operation-\d+)"/g)) {
      const positions = operationPositions.get(match[2]) ?? new Set<string>();
      positions.add(match[1]);
      operationPositions.set(match[2], positions);
    }
    assert.ok([...operationPositions.values()].some((positions) => positions.size === 1));
    assert.ok([...operationPositions.values()].some((positions) => positions.size > 1));

    const gappedSteps = debuggerModel.steps.map((step, index) => {
      const offsetMs = index < 2 ? index * 1000 : 120_000 + (index - 2) * 1000;
      return {
        ...step,
        timestamp: new Date(startMs + offsetMs).toISOString(),
        events: step.events.map((event, eventIndex) => ({
          ...event,
          timestamp: new Date(startMs + offsetMs + eventIndex * 100).toISOString(),
        })),
      };
    });
    const gappedHtml = renderKnowledgeDebuggerPage({
      ...debuggerModel,
      steps: gappedSteps,
      summary: {
        ...debuggerModel.summary,
        observedEndTimestamp: new Date(startMs + 130_000).toISOString(),
      },
    });
    assert.match(gappedHtml, /class="trajectory-gap-axis"/);
    assert.match(gappedHtml, /无可观测事件/);
    assert.match(gappedHtml, /class="trajectory-gap-band"/);
  });
});

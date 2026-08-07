import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../src/observability/inbox.js';
import { buildKnowledgeDebuggerViewModel } from '../../src/observability/knowledge-debugger.js';
import { renderKnowledgeDebuggerPage } from '../../src/renderer/knowledge-debugger-renderer.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tracePath = join(
  projectRoot,
  'examples/codex-task-trajectory/trace/codex-memory-real-redacted.jsonl',
);

describe('redacted real Codex task trajectory example', () => {
  it('round-trips through Trace IR without retaining source identity or credentials', () => {
    const source = readFileSync(tracePath, 'utf-8');
    assert.doesNotMatch(source, /lizhiyao|\/var\/folders|019fadf0-e822-7bf2-86bb-2af225110d8b/i);
    assert.doesNotMatch(source, /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/);
    assert.doesNotMatch(source, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    assert.match(source, /"kind":"redacted_real_codex_trace"/);

    const report = buildObservationInboxReport(tracePath);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    assert.equal(session.sourceKind, 'codex');
    assert.equal(session.indicators.toolCallCount, 4);
    assert.equal(session.indicators.toolFailureCount, 1);
    assert.equal(session.fullSessionTimeline.length, 12);
    assert.ok(session.fullSessionTimeline.some((event) => (
      event.kind === 'runtime_context' && event.runtimeKind === 'session_context'
    )));

    const model = buildKnowledgeDebuggerViewModel(session, session.turns[0]!.turnId, report.meta.ingestion);
    assert.equal(model.summary.userGoal, 'codex 的 memory 默认是开着的吗？这玩意好分析吗');
    assert.equal(model.steps.filter((step) => step.stepKind === 'tool_exchange').length, 4);
    assert.ok(model.knowledgeEvidence.some((item) =>
      item.knowledgeKind === 'skill' && item.label === 'openai-docs'));

    const html = renderKnowledgeDebuggerPage(model, 'zh');
    assert.match(html, /任务轨迹/);
    assert.match(html, /openai-docs/);
    assert.match(html, /首次命令|Process exited with code 1|失败/);
    assert.match(html, /aria-label="完整任务时间轴"/);
    assert.match(html, /body\{height:100dvh;min-height:0;overflow:hidden/);
    assert.equal((html.match(/<section class="trajectory-lane(?: has-two-rows)?" data-lane=/g) ?? []).length, 4);
    assert.match(html, /aria-label="类型筛选"/);
    assert.match(html, /data-trajectory-facet="knowledge:skill"/);
    assert.match(html, /data-trajectory-facet="tool:bash"/);
    assert.match(html, /data-trajectory-facet="status:failure"/);
    assert.match(html, /data-trajectory-facets="[^"]*knowledge:skill[^"]*"/);
    assert.doesNotMatch(html, /--timeline-width:|class="[^"]*\bis-marker\b/);
    assert.doesNotMatch(html, /返回观测收件箱/);
  });
});

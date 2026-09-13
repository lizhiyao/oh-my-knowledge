import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../src/observability/inbox/index.js';
import { buildKnowledgeDebuggerViewModel } from '../../src/observability/conversation/knowledge-debugger.js';
import { projectReplay } from '../../src/studio/application/replay/projection.js';

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

    const replay = projectReplay(model, 'zh', { pendingToolResults: false });
    assert.deepEqual(
      [...new Set(replay.cards.map((card) => card.lane))].sort(),
      ['action', 'conversation', 'knowledge', 'result'],
    );
    assert.ok(replay.cards.some((card) => card.lane === 'knowledge' && card.title === 'openai-docs'));
    assert.ok(replay.cards.some((card) => card.title.includes('memory 默认是开着的吗')));
    assert.ok(replay.cards.some((card) => card.tone === 'failure'));
    for (const facet of ['knowledge:skill', 'status:failure', 'tool:bash']) {
      assert.ok(replay.facets.some((item) => item.id === facet), facet);
    }
  });
});

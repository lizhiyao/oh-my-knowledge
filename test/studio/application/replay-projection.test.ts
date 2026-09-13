import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
import { buildKnowledgeDebuggerViewModel } from '../../../src/observability/conversation/knowledge-debugger.js';
import type { KnowledgeDebuggerViewModel } from '../../../src/observability/view-models/knowledge-debugger.js';
import type { ExperienceTimelineEvent } from '../../../src/observability/contracts/experience.js';
import type { Lang } from '../../../src/shared/language.js';
import { projectReplay } from '../../../src/studio/application/replay/projection.js';
import { visibleAxisTicks } from '../../../src/studio/application/replay/layout.js';
import type { ReplayCard, ReplayProjection } from '../../../src/studio/view-models/replay.js';

const root = mkdtempSync(join(tmpdir(), 'omk-replay-projection-'));
const tracePath = join(root, 'rollout.jsonl');
type ProjectionStep = KnowledgeDebuggerViewModel['steps'][number];

function project(model: KnowledgeDebuggerViewModel, lang: Lang = 'zh', pendingToolResults = false): ReplayProjection {
  const replay = projectReplay(model, lang, { pendingToolResults });
  replay.axisTicks = visibleAxisTicks(replay);
  return replay;
}

function replaceEvents(model: KnowledgeDebuggerViewModel, stepId: string, events: ExperienceTimelineEvent[]): KnowledgeDebuggerViewModel {
  return { ...model, steps: model.steps.map((step) => (step.id === stepId ? { ...step, events } : step)) };
}

function pickStep(model: KnowledgeDebuggerViewModel, match: (step: ProjectionStep) => boolean): ProjectionStep {
  const step = model.steps.find(match);
  assert.ok(step, 'the fixture must provide the step under test');
  return step;
}

function eventText(event: ExperienceTimelineEvent, value: string): ExperienceTimelineEvent {
  return { ...event, fullText: value, snippet: value };
}

function cardFor(replay: ReplayProjection, lane: ReplayCard['lane'], eventId: string): ReplayCard | undefined {
  return replay.cards.find((card) => card.lane === lane && card.rawId.includes(eventId));
}

function fieldOf(replay: ReplayProjection, operationId: string | undefined, label: string) {
  return replay.operations.find((operation) => operation.id === operationId)?.fields.find((field) => field.label === label);
}

describe('Replay semantic projection', () => {
  let model: KnowledgeDebuggerViewModel;
  let replay: ReplayProjection;

  beforeAll(() => {
    writeFileSync(
      tracePath,
      readFileSync(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url), 'utf-8'),
    );
    const report = buildObservationInboxReport(tracePath);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    model = buildKnowledgeDebuggerViewModel(session, session.turns[0]!.turnId, report.meta.ingestion);
    replay = project(model);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('presents the task as lanes, milestones and an attributed user correction', () => {
    assert.deepEqual(
      [...new Set(replay.cards.map((card) => card.lane))].sort(),
      ['action', 'conversation', 'knowledge', 'result'],
    );
    assert.deepEqual(
      replay.milestones.map((milestone) => [milestone.label, milestone.tone]),
      [['本轮开始', 'start'], ['本轮完成', 'end']],
    );
    assert.deepEqual(replay.cards.filter((card) => /本轮(?:开始|完成)/.test(card.title)), []);
    const correction = replay.cards.find((card) => card.kindLabel === '用户纠正');
    assert.equal(correction?.tone, 'warning');
    assert.equal(correction?.conversationRole, 'user');
    assert.match(correction?.title ?? '', /没有先检查 doctor 和 eval 证据/);
    const failure = replay.cards.find((card) => card.lane === 'result' && card.tone === 'failure');
    assert.equal(failure?.kindLabel, '失败');
    assert.match(failure?.detail ?? '', /Process exited with code 1: missing doctor\/eval evidence/);
    assert.doesNotMatch(JSON.stringify(replay), /ciphertext-must-not-be-rendered|second-ciphertext-must-not-be-rendered/);
  });

  it('marks opaque reasoning as an unreadable compact card instead of exposing payloads', () => {
    const opaque = replay.cards.find((card) => card.compact);
    assert.equal(opaque?.kindLabel, '模型思考');
    assert.equal(opaque?.title, '不可见');
    assert.equal(opaque?.width, 14);
    assert.equal(
      replay.operations.find((operation) => operation.id === opaque?.operationId)?.summary,
      'Trace 记录了模型思考事件，但没有暴露可读内容。',
    );
    assert.equal(fieldOf(replay, opaque?.operationId, '可见性')?.value, '内容不可见');

    const english = project(model, 'en');
    const englishOpaque = english.cards.find((card) => card.compact);
    assert.equal(englishOpaque?.kindLabel, 'Model reasoning');
    assert.equal(englishOpaque?.title, 'Unavailable');
    assert.equal(fieldOf(english, englishOpaque?.operationId, 'Visibility')?.value, 'Content unavailable');
    assert.doesNotMatch(JSON.stringify(english), /hidden (?:thought|reasoning)|chain of thought/i);
  });

  it('labels only the model that the trace recorded on AI cards', () => {
    const modeled = project({
      ...model,
      steps: model.steps.map((step) => (
        step.stepKind === 'assistant_message' || step.stepKind === 'model_activity'
          ? { ...step, events: step.events.map((event) => ({ ...event, model: 'gpt-5.4' })) }
          : step
      )),
      summary: { ...model.summary, observedModels: ['gpt-5.4'] },
    });
    const conversation = modeled.cards.filter((card) => card.lane === 'conversation');
    const assistant = conversation.filter((card) => card.conversationRole === 'assistant');
    const user = conversation.filter((card) => card.conversationRole === 'user');
    assert.ok(assistant.length > 0 && user.length > 0);
    assert.deepEqual([...new Set(assistant.map((card) => card.model))], ['gpt-5.4']);
    assert.ok(user.every((card) => !card.model), 'user cards carry no model attribution');
  });

  it('keeps verbose tool payloads out of card titles and into a bounded operation detail', () => {
    const exchange = pickStep(model, (step) => step.stepKind === 'tool_exchange' && step.knowledgeEvidenceIds.length === 0);
    const call = exchange.events[0]!;
    const patchInput = `const patch = "*** Begin Patch\\n*** Add File: /private/tmp/example-client.mjs\\n+${'x'.repeat(600)}\\n*** End Patch";`;
    const projected = project(replaceEvents(model, exchange.id, exchange.events.map((event, index) => (index === 0 ? eventText(event, patchInput) : event))));
    const action = cardFor(projected, 'action', call.id);
    assert.equal(action?.title, '新增文件：/private/tmp/example-client.mjs');
    const input = fieldOf(projected, action?.operationId, '执行');
    assert.match(input?.detail ?? '', /^\*\*\* Begin Patch|const patch = "\*\*\* Begin Patch/);
    assert.ok((input?.detail ?? '').length < patchInput.length, 'the archived payload stays bounded');
  });

  it('derives source-neutral action and result titles from structured CLI exchanges', () => {
    const exchange = pickStep(model, (step) => step.stepKind === 'tool_exchange' && step.knowledgeEvidenceIds.length === 0);
    const call = exchange.events[0]!;
    const result = exchange.events[1]!;
    const cases = [
      {
        toolName: undefined,
        command: 'node /private/tmp/mcp_client.mjs call provider_doc_detail \'{"doc_id":42}\'',
        payload: { ok: true, data: { id: 42, title: '架构说明' } },
        actionTitle: '读取文档详情',
        resultTitle: '返回：架构说明',
      },
      {
        toolName: undefined,
        command: 'node /private/tmp/mcp_client.mjs call provider_book_toc \'{"book_id":7}\'',
        payload: { ok: true, data: [{ id: 1 }, { id: 2 }] },
        actionTitle: '读取知识库目录',
        resultTitle: '返回 2 项',
      },
      {
        toolName: undefined,
        command: 'node /private/tmp/mcp_client.mjs create-markdown-doc 7 parent "测试报告" /tmp/report.md',
        payload: { ok: true, data: { id: 43, title: '测试报告' } },
        actionTitle: '创建 Markdown 文档',
        resultTitle: '已创建：测试报告',
      },
      { toolName: 'Edit', command: '{}', payload: {}, actionTitle: '编辑内容', resultTitle: '更新完成' },
      { toolName: 'wait', command: '{"cell_id":"72","yield_time_ms":30000}', payload: {}, actionTitle: '等待后台任务', resultTitle: '等待结束' },
    ];

    for (const testCase of cases) {
      const wrapped = JSON.stringify({
        output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(testCase.payload) }] }),
      });
      const events = exchange.events.map((event, index) => index === 0
        ? { ...event, toolName: testCase.toolName ?? event.toolName, fullText: JSON.stringify({ command: testCase.command }), snippet: testCase.command }
        : { ...event, isError: false, toolStatus: 'success' as const, fullText: `Script completed\nOutput: ${wrapped}`, snippet: wrapped });
      const succeeded = replaceEvents(model, exchange.id, events);
      const projected = project({
        ...succeeded,
        steps: succeeded.steps.map((step) => (step.id === exchange.id ? { ...step, toolStatus: 'success' as const } : step)),
      });
      const action = cardFor(projected, 'action', call.id);
      const returned = cardFor(projected, 'result', result.id);
      assert.equal(action?.title, testCase.actionTitle, `action title for ${testCase.command.slice(0, 30)}`);
      assert.equal(returned?.title, testCase.resultTitle, `result title for ${testCase.command.slice(0, 30)}`);
      assert.ok(
        fieldOf(projected, action?.operationId, '执行')?.detail?.includes(testCase.command.slice(0, 20)),
        `the raw input stays reachable for ${testCase.command.slice(0, 30)}`,
      );
    }
  });

  it('keeps long tool content out of cards while the operation detail holds it', () => {
    const exchange = pickStep(model, (step) => step.stepKind === 'tool_exchange' && step.events.length > 1);
    const resultEvent = exchange.events[1]!;
    const output = Array.from({ length: 12 }, (_value, index) => `result line ${index + 1}`).join('\n');
    const projected = project(replaceEvents(model, exchange.id, exchange.events.map((event, index) => (
      index === 1 ? eventText(event, output) : event
    ))));
    const result = cardFor(projected, 'result', resultEvent.id);
    assert.ok(result, 'the result card is projected');
    assert.ok(!result!.title.includes('result line') && !result!.detail.includes('result line 4'), 'the card stays scannable');
    const detail = fieldOf(projected, result?.operationId, '结果')?.detail ?? '';
    assert.match(detail, /result line 1\nresult line 2/);
    assert.match(detail, /result line 12$/);
  });

  it('separates a historical missing result from a live pending one', () => {
    const exchange = pickStep(model, (step) => step.stepKind === 'tool_exchange');
    const call = exchange.events[0]!;
    const callOnly = replaceEvents(model, exchange.id, [call]);
    const historicalReplay = project(callOnly);
    const historicalCard = cardFor(historicalReplay, 'action', call.id);
    const historical = historicalReplay.cards.find((card) => card.lane === 'result' && card.operationId === historicalCard?.operationId);
    assert.equal(historical?.kindLabel, '结果缺失');
    assert.equal(historical?.tone, 'warning');
    const liveReplay = project(callOnly, 'zh', true);
    const liveCard = cardFor(liveReplay, 'action', call.id);
    const live = liveReplay.cards.find((card) => card.lane === 'result' && card.operationId === liveCard?.operationId);
    assert.equal(live?.kindLabel, '获取中');
    assert.equal(live?.tone, 'pending');
  });

  it('aligns one operation across lanes, never overlaps cards, and compresses idle time', () => {
    const centers = new Map<string, Set<number>>();
    for (const card of replay.cards) {
      if (card.lane === 'conversation') continue;
      const bucket = centers.get(card.operationId) ?? new Set<number>();
      bucket.add(card.position + card.width / 2);
      centers.set(card.operationId, bucket);
    }
    assert.ok([...centers.values()].some((bucket) => bucket.size === 1), 'at least one operation shares a column center');
    for (const lane of ['conversation', 'action', 'result', 'knowledge'] as const) {
      const cards = replay.cards.filter((card) => card.lane === lane).sort((left, right) => left.position - right.position);
      cards.slice(1).forEach((card, index) => {
        const previous = cards[index];
        assert.ok(card.position >= previous.position + previous.width, `${lane} cards must not overlap`);
      });
    }

    const startMs = Date.parse(model.summary.observedStartTimestamp ?? '2026-08-03T00:00:00.500Z');
    const gapped = project({
      ...model,
      steps: model.steps.map((step, index) => {
        const offsetMs = index < 2 ? index * 1000 : 120_000 + (index - 2) * 1000;
        return {
          ...step,
          timestamp: new Date(startMs + offsetMs).toISOString(),
          events: step.events.map((event, eventIndex) => ({
            ...event,
            timestamp: new Date(startMs + offsetMs + eventIndex * 100).toISOString(),
          })),
        };
      }),
      summary: { ...model.summary, observedEndTimestamp: new Date(startMs + 130_000).toISOString() },
    });
    assert.deepEqual(gapped.gaps.map((gap) => gap.durationMs), [120_000]);
    const tickLabels = gapped.axisTicks.map((tick) => tick.label);
    assert.ok(
      tickLabels.includes('00:01.0') && tickLabels.some((label) => label.startsWith('02:0')),
      `both sides of the compressed window keep truthful labels: ${tickLabels.join(' ')}`,
    );
    assert.ok(gapped.cards.every((card) => card.position >= 0 && card.position <= gapped.detailWidth));
  });

  it('indexes facets for knowledge, tool and status so the projection stays filterable', () => {
    assert.deepEqual(
      replay.facets.map((facet) => facet.id),
      ['knowledge:project_instruction', 'knowledge:skill', 'tool:bash', 'status:failure'],
    );
    const skillCard = replay.cards.find((card) => card.lane === 'knowledge' && card.facetIds.includes('knowledge:skill'));
    assert.equal(skillCard?.kindLabel, 'Skill · 已读取');
    assert.equal(skillCard?.title, 'release');
  });
});

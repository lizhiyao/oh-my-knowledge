import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadTraceSessions, segmentTraceBySkill, tracesToAnalysisEntries } from '../../../src/observability/trace/index.js';
import { buildObservationExperienceReport, compactObservationExperienceReport, normalizeObservationExperienceReport } from '../../../src/observability/experience.js';
import { jsonl, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('markdown trace loading', () => {
  it('loads agent markdown logs', () => {
    const path = join(fixture.directory, 'agent.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /tmp/agent
**会话 ID**: oc-1
**请求 ID**: r1

### 用户输入
请优先调用 design-coding-create-template skill 处理。

### AI 回复
我会先处理当前模板。
`);
    const sessions = loadTraceSessions(path);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runId, 'oc-1');
    assert.equal(sessions[0].cwd, '/tmp/agent');
    assert.equal(sessions[0].startTimestamp, undefined);
    assert.ok(sessions[0].events.every((event) => event.timestamp === undefined));
    const segs = segmentTraceBySkill(sessions[0]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'design-coding-create-template');
    assert.equal(segs[0].attribution?.source, 'command-name');
  });

  it('normalizes markdown wall-clock timestamps only when an offset is explicit', () => {
    const path = join(fixture.directory, 'agent-with-offset.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55 +08:00] 对话记录 (SDK)
**会话 ID**: offset-session
**请求 ID**: r1

### 用户输入
请调用 audit skill。

### AI 回复
完成。
`);
    const [session] = loadTraceSessions(path);
    assert.ok(session);
    assert.equal(session.startTimestamp, '2026-04-09T08:22:55.000Z');
    assert.ok(session.events.every((event) => event.timestamp === '2026-04-09T08:22:55.000Z'));
  });

  it('does not synthesize wall-clock time for malformed markdown timestamps', () => {
    const path = join(fixture.directory, 'invalid-time.log');
    writeFileSync(path, `---
## [not-a-timestamp] 对话记录 (SDK)
**会话 ID**: invalid-time
**请求 ID**: r1

### 用户输入
请调用 audit skill。

### AI 回复
完成。
`);
    const [session] = loadTraceSessions(path);
    assert.ok(session);
    assert.equal(session.startTimestamp, undefined);
    assert.ok(session.events.every((event) => event.timestamp === undefined));
    const first = segmentTraceBySkill(session);
    const second = segmentTraceBySkill(session);
    assert.deepEqual(
      first.map((segment) => [segment.startTimestamp, segment.endTimestamp]),
      second.map((segment) => [segment.startTimestamp, segment.endTimestamp]),
    );
    assert.deepEqual(
      first.map((segment) => [segment.startTimestamp, segment.endTimestamp]),
      [['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']],
    );
    assert.equal(first[0].timestampObserved, false);
  });

  it('does not borrow a prior segment or session timestamp for untimestamped events', () => {
    const path = join(fixture.directory, 'partial-time.jsonl');
    writeFileSync(path, jsonl([
      {
        type: 'user',
        uuid: 'u0',
        parentUuid: null,
        sessionId: 'partial-time',
        timestamp: '2026-07-25T00:00:00.000Z',
        message: { role: 'user', content: '先讨论别的问题。' },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'u0',
        sessionId: 'partial-time',
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查实现。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'partial-time',
        message: { role: 'assistant', content: [{ type: 'text', text: '检查完成。' }] },
      },
    ]));

    const [session] = loadTraceSessions(path);
    assert.equal(session.startTimestamp, '2026-07-25T00:00:00.000Z');
    const segments = segmentTraceBySkill(session);
    assert.equal(segments.length, 2);
    assert.equal(segments[1].skillName, 'audit');
    assert.equal(segments[1].timestampObserved, false);
    assert.equal(segments[1].startTimestamp, '1970-01-01T00:00:00.000Z');
  });

  it('loads each markdown log block as its own session', () => {
    const path = join(fixture.directory, 'agent.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /repo-a
**会话 ID**: shared-session
**请求 ID**: r-a

### 用户输入
请优先调用 audit skill 处理。

### AI 回复
审计完成。
---
## [2026/04/09 16:25:55] 对话记录 (SDK)
**工作目录**: /repo-b
**会话 ID**: shared-session
**请求 ID**: r-b

### 用户输入
请优先调用 polish skill 处理。

### AI 回复
润色完成。
`);
    const sessions = loadTraceSessions(path);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].runId, 'shared-session');
    assert.equal(sessions[0].cwd, '/repo-a');
    assert.equal(sessions[1].runId, 'shared-session');
    assert.equal(sessions[1].cwd, '/repo-b');
    assert.equal(new Set(sessions.map((session) => session.traceId)).size, 2);
    assert.ok(sessions.every((session) => /^trace:[a-f0-9]{32}$/.test(session.traceId)));

    const segs = sessions.flatMap(segmentTraceBySkill).sort((a, b) => a.skillName.localeCompare(b.skillName));
    assert.deepEqual(segs.map((seg) => [seg.skillName, seg.sessionId, seg.cwd]), [
      ['audit', 'shared-session', '/repo-a'],
      ['polish', 'shared-session', '/repo-b'],
    ]);

    const experience = buildObservationExperienceReport({
      sessions,
      segments: segs,
      items: [],
      generatedAt: '2026-04-09T09:00:00.000Z',
    });
    const invocations = experience.invocations.sort((a, b) => a.skillName.localeCompare(b.skillName));
    assert.deepEqual(
      invocations.map((invocation) => [
        invocation.skillName,
        invocation.sessionId,
        invocation.cwd,
        invocation.timeline.find((event) => event.kind === 'user_message')?.snippet,
      ]),
      [
        ['audit', 'shared-session', '/repo-a', '请优先调用 audit skill 处理。'],
        ['polish', 'shared-session', '/repo-b', '请优先调用 polish skill 处理。'],
      ],
    );
    assert.equal(new Set(invocations.map((invocation) => invocation.sessionGroupKey)).size, 2);
    assert.equal(new Set(invocations.map((invocation) => invocation.id)).size, 2);
    const timelineEventIds = experience.traceTimelines.flatMap((timeline) =>
      [
        ...timeline.tree.main,
        ...timeline.tree.branches.flatMap((branch) => branch.events),
      ].map((event) => event.id)
    );
    assert.equal(new Set(timelineEventIds).size, timelineEventIds.length);
  });

  it('keeps markdown trace identities stable when unrelated blocks are inserted', () => {
    const path = join(fixture.directory, 'stable-agent.log');
    const block = (requestId: string, text: string): string => `---
## [2026/04/09 16:22:55 +08:00] 对话记录 (SDK)
**会话 ID**: shared-session
**请求 ID**: ${requestId}

### 用户输入
${text}

### AI 回复
done
`;
    writeFileSync(path, `${block('r-a', 'A')}${block('r-b', 'B')}`);
    const before = new Map(loadTraceSessions(path).map((session) => [session.label, session.traceId]));

    writeFileSync(path, `${block('r-new', 'new')}${block('r-a', 'A')}${block('r-b', 'B')}`);
    const after = new Map(loadTraceSessions(path).map((session) => [session.label, session.traceId]));

    assert.equal(after.get('stable-agent.log#r-a'), before.get('stable-agent.log#r-a'));
    assert.equal(after.get('stable-agent.log#r-b'), before.get('stable-agent.log#r-b'));
  });

  it('canonicalizes relative and absolute source paths into the same trace identity', () => {
    const path = writeSession(fixture.directory, 'canonical-path.jsonl', [
      { type: 'permission-mode', sessionId: 'canonical-run' },
    ]);
    const absolute = loadTraceSessions(path)[0];
    const relativePath = relative(process.cwd(), path);
    const fromRelative = loadTraceSessions(relativePath)[0];

    assert.equal(fromRelative.traceId, absolute.traceId);
  });

  it('keeps observation attribution physical when markdown blocks reuse session ids and timestamps', () => {
    const path = join(fixture.directory, 'same-session-observations.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /repo
**会话 ID**: shared-session
**请求 ID**: r-a

### 用户输入
不对，请优先调用 audit skill 处理。

### AI 回复
【知识缺口】缺少字段 A。
---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /repo
**会话 ID**: shared-session
**请求 ID**: r-a

### 用户输入
不对，请优先调用 audit skill 处理。

### AI 回复
【知识缺口】缺少字段 B。
`);

    const { sessions, segments } = tracesToAnalysisEntries(path);
    const report = buildObservationExperienceReport({
      sessions,
      segments,
      items: [],
      generatedAt: '2026-04-09T09:00:00.000Z',
    });
    assert.equal(new Set(sessions.map((session) => session.traceId)).size, 2);
    assert.equal(new Set(report.invocations.map((invocation) => invocation.sessionGroupKey)).size, 2);
    assert.equal(
      new Set(report.invocations.flatMap((invocation) =>
        invocation.problemPatterns.flatMap((pattern) => pattern.recentSessionIds)
      )).size,
      2,
    );
    for (const invocation of report.invocations) {
      assert.ok(invocation.traceId);
      assert.equal(
        report.goalSlices.find((slice) => slice.id === invocation.goalSliceId)?.traceId,
        invocation.traceId,
      );
      assert.ok(invocation.timeline.every((event) => event.traceId === invocation.traceId));
      assert.ok(invocation.evidenceRefs.every((ref) => ref.traceId === invocation.traceId));
      assert.ok(invocation.problemPatterns.every((pattern) =>
        pattern.evidenceRefs.every((ref) => ref.traceId === invocation.traceId)
      ));
    }
    assert.ok(report.sessions.every((session) =>
      session.sessionStory?.episodes?.every((episode) =>
        episode.skillSegments.every((segment) =>
          segment.messageRanges?.every((range) => typeof range.traceId === 'string') ?? true
        )
      ) ?? true
    ));
    assert.ok(normalizeObservationExperienceReport(
      compactObservationExperienceReport(structuredClone(report)),
    ));
  });
});

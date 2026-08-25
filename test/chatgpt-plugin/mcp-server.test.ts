import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it } from 'vitest';
import { createChatGptObservationMcpServer } from '../../src/chatgpt-plugin/mcp-server.js';
import { FileObservationCaptureStore } from '../../src/chatgpt-plugin/capture-store.js';
import { FileObservationFeedbackStore } from '../../src/chatgpt-plugin/feedback-store.js';
import { OBSERVATION_CAPTURE_SCOPE } from '../../src/chatgpt-plugin/principal.js';
import { queryObservationInbox } from '../../src/observability/inbox.js';

describe('ChatGPT observation MCP server', () => {
  it('advertises a focused, accurately annotated capture tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chatgpt-mcp-list-'));
    const server = createChatGptObservationMcpServer({ observationsDir: dir });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), [
        'capture_observation',
        'get_observation',
        'record_observation_review',
        'draft_sample_from_observation',
      ]);
      const tool = tools.tools[0];
      assert.ok(tool);
      assert.equal(tool.name, 'capture_observation');
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.equal(tool.inputSchema.required?.includes('confirmedByUser'), true);
      assert.equal(JSON.stringify(tool.inputSchema).includes('tenantId'), false);
      assert.equal(JSON.stringify(tool.inputSchema).includes('principalId'), false);
      assert.ok(tool.outputSchema);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('captures authorized feedback and returns explicit partial coverage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chatgpt-mcp-call-'));
    const server = createChatGptObservationMcpServer({
      observationsDir: dir,
      now: () => new Date('2026-08-24T02:03:04.000Z'),
    });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: 'capture_observation',
        arguments: {
          skillName: 'omk',
          userFeedback: '报告需要解释 coverage: partial。',
          evidenceSnippet: '用户询问 partial 的含义。',
          captureId: 'mcp-call-1',
          confirmedByUser: true,
        },
      });
      assert.notEqual(response.isError, true);
      const structuredContent = response.structuredContent as Record<string, unknown> | undefined;
      assert.deepEqual(structuredContent?.captureCoverage, {
        coverageStatus: 'partial',
        capturePath: 'explicit_tool_call',
        observedEventKinds: ['tool_boundary', 'user_feedback', 'submitted_evidence'],
        unavailableEventKinds: ['full_conversation', 'external_tool_calls', 'hidden_reasoning'],
      });
      assert.equal(queryObservationInbox(dir)[0]?.evidence.userFeedbackSnippet, '报告需要解释 coverage: partial。');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('advertises only the tools allowed by the resolved principal scopes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chatgpt-mcp-scopes-'));
    const server = createChatGptObservationMcpServer({
      principal: {
        tenantId: 'tenant',
        principalId: 'capture-only',
        scopes: [OBSERVATION_CAPTURE_SCOPE],
      },
      captureStore: new FileObservationFeedbackStore({ observationsDir: dir }),
    });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
        'capture_observation',
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps capture-only store adapters backward compatible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chatgpt-mcp-capture-only-'));
    const server = createChatGptObservationMcpServer({
      captureStore: new FileObservationCaptureStore({ observationsDir: dir }),
    });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
        'capture_observation',
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects calls without explicit confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chatgpt-mcp-reject-'));
    const server = createChatGptObservationMcpServer({ observationsDir: dir });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: 'capture_observation',
        arguments: {
          skillName: 'omk',
          userFeedback: '不应落盘。',
          confirmedByUser: false,
        },
      });
      assert.equal(response.isError, true);
      assert.equal(queryObservationInbox(dir).length, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reads, reviews, and drafts without promoting unconfirmed feedback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chatgpt-mcp-feedback-'));
    const server = createChatGptObservationMcpServer({
      observationsDir: dir,
      now: () => new Date('2026-08-24T02:03:04.000Z'),
    });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const captured = await client.callTool({
        name: 'capture_observation',
        arguments: {
          skillName: 'omk',
          userFeedback: '缺少公司内部宿主的通用接入边界。',
          evidenceSnippet: '私有系统只应注入 identity 和 storage。',
          captureId: 'feedback-loop-1',
          confirmedByUser: true,
        },
      });
      const observationId = (captured.structuredContent as { observationId: string }).observationId;

      const beforeReview = await client.callTool({
        name: 'draft_sample_from_observation',
        arguments: { observationId, prompt: '说明公共 OMK 与私有宿主的边界。' },
      });
      assert.equal(beforeReview.isError, true);

      const reviewed = await client.callTool({
        name: 'record_observation_review',
        arguments: { observationId, verdict: 'real_issue', note: '人工确认。' },
      });
      assert.notEqual(reviewed.isError, true);

      const drafted = await client.callTool({
        name: 'draft_sample_from_observation',
        arguments: {
          observationId,
          prompt: '说明公共 OMK 与私有宿主的边界。',
          rubric: '必须明确身份、存储和部署由宿主负责。',
          draftId: 'feedback-loop-draft-1',
        },
      });
      assert.notEqual(drafted.isError, true);
      assert.deepEqual(drafted.structuredContent, {
        draftId: (drafted.structuredContent as { draftId: string }).draftId,
        createdAt: '2026-08-24T02:03:04.000Z',
        created: true,
        status: 'draft',
        observationId,
        sourceEvidence: [{
          captureId: (drafted.structuredContent as { sourceEvidence: Array<{ captureId: string }> })
            .sourceEvidence[0]?.captureId,
          payloadHash: (drafted.structuredContent as { sourceEvidence: Array<{ payloadHash: string }> })
            .sourceEvidence[0]?.payloadHash,
          capturedAt: '2026-08-24T02:03:04.000Z',
        }],
        sample: {
          sample_id: `observation-${observationId.slice(0, 16)}`,
          prompt: '说明公共 OMK 与私有宿主的边界。',
          rubric: '必须明确身份、存储和部署由宿主负责。',
          provenance: 'production-trace',
        },
      });

      const detail = await client.callTool({
        name: 'get_observation',
        arguments: { observationId },
      });
      const detailContent = detail.structuredContent as {
        occurrences: number;
        review?: { verdict: string };
        captureCoverage: { coverageStatus: string };
      };
      assert.equal(detailContent.occurrences, 1);
      assert.equal(detailContent.review?.verdict, 'real_issue');
      assert.equal(detailContent.captureCoverage.coverageStatus, 'partial');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it } from 'vitest';
import { createObservationMcpServer } from '../../src/mcp/mcp-server.js';
import { FileObservationCaptureStore } from '../../src/mcp/capture-store.js';
import { FileObservationFeedbackStore } from '../../src/mcp/feedback-store.js';
import {
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_READ_SCOPE,
} from '../../src/mcp/principal.js';
import {
  MCP_APP_HTML_MIME_TYPE,
  OBSERVATION_REVIEW_RESOURCE_URI,
} from '../../src/mcp/review-component.js';
import { queryObservationInbox } from '../../src/observability/inbox.js';

describe('OMK observation MCP server', () => {
  it('advertises a focused, accurately annotated capture tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-list-'));
    const server = createObservationMcpServer({ observationsDir: dir });
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
        'render_observation_review',
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

      const renderTool = tools.tools.at(-1);
      assert.deepEqual(renderTool?._meta?.ui, {
        resourceUri: OBSERVATION_REVIEW_RESOURCE_URI,
      });
      assert.equal(tools.tools.slice(0, -1).some((item) => item._meta?.ui), false);

      const resources = await client.listResources();
      assert.deepEqual(resources.resources.map((resource) => resource.uri), [
        OBSERVATION_REVIEW_RESOURCE_URI,
      ]);
      const resource = await client.readResource({ uri: OBSERVATION_REVIEW_RESOURCE_URI });
      const component = resource.contents[0];
      assert.equal(component?.mimeType, MCP_APP_HTML_MIME_TYPE);
      assert.equal(component?.uri, OBSERVATION_REVIEW_RESOURCE_URI);
      assert.ok(component && 'text' in component);
      assert.equal(component.text.includes('tools/call'), true);
      assert.equal(component.text.includes('localStorage'), false);
      assert.equal(component.text.includes('innerHTML'), false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('captures authorized feedback and returns explicit partial coverage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-call-'));
    const server = createObservationMcpServer({
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
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-scopes-'));
    const server = createObservationMcpServer({
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
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-capture-only-'));
    const server = createObservationMcpServer({
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

  it('renders a read-only component without advertising review or draft actions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-read-only-'));
    const principal = {
      tenantId: 'tenant',
      principalId: 'reader',
      scopes: [OBSERVATION_READ_SCOPE],
    };
    const store = new FileObservationFeedbackStore({ observationsDir: dir });
    const captured = await store.create(principal, {
      skillName: 'omk',
      userFeedback: '需要展示只读复核卡片。',
      confirmedByUser: true,
      captureSourceKind: 'mcp',
    });
    const server = createObservationMcpServer({ principal, captureStore: store });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
        'get_observation',
        'render_observation_review',
      ]);
      const rendered = await client.callTool({
        name: 'render_observation_review',
        arguments: { observationId: captured.observationId },
      });
      assert.deepEqual(
        (rendered.structuredContent as { actions: Record<string, boolean> }).actions,
        { canReview: false, canDraft: false },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects calls without explicit confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-reject-'));
    const server = createObservationMcpServer({ observationsDir: dir });
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
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-feedback-'));
    const server = createObservationMcpServer({
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

      const rendered = await client.callTool({
        name: 'render_observation_review',
        arguments: {
          observationId,
          candidatePrompt: '说明公共 OMK 与私有宿主的边界。',
          candidateRubric: '必须明确通用能力与宿主责任。',
        },
      });
      assert.notEqual(rendered.isError, true);
      const renderedContent = rendered.structuredContent as {
        observation: { observationId: string; captureCoverage: { coverageStatus: string } };
        actions: { canReview: boolean; canDraft: boolean };
        proposal?: { prompt: string; rubric?: string };
      };
      assert.equal(renderedContent.observation.observationId, observationId);
      assert.equal(renderedContent.observation.captureCoverage.coverageStatus, 'partial');
      assert.deepEqual(renderedContent.actions, { canReview: true, canDraft: true });
      assert.deepEqual(renderedContent.proposal, {
        prompt: '说明公共 OMK 与私有宿主的边界。',
        rubric: '必须明确通用能力与宿主责任。',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

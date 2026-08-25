import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it } from 'vitest';
import { createChatGptObservationMcpServer } from '../../src/chatgpt-plugin/mcp-server.js';
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
      assert.equal(tools.tools.length, 1);
      const [tool] = tools.tools;
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
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  captureExplicitObservation,
  type ExplicitObservationCaptureOptions,
} from '../observability/explicit-capture.js';

const observedEventKindSchema = z.enum([
  'tool_boundary',
  'user_feedback',
  'submitted_evidence',
]);
const unavailableEventKindSchema = z.enum([
  'full_conversation',
  'external_tool_calls',
  'hidden_reasoning',
]);

export type ChatGptObservationMcpServerOptions = ExplicitObservationCaptureOptions;

export function createChatGptObservationMcpServer(
  options: ChatGptObservationMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: 'omk-chatgpt-observation-capture',
    version: '0.1.0',
  });

  server.registerTool('capture_observation', {
    title: 'Capture an explicit OMK observation',
    description: [
      'Record knowledge feedback only after the user explicitly asks to save it.',
      'This captures the submitted feedback and optional evidence at the OMK tool boundary.',
      'It does not capture the full ChatGPT conversation, other tool calls, or hidden reasoning.',
    ].join(' '),
    inputSchema: {
      skillName: z.string().trim().min(1).max(120)
        .describe('OMK knowledge artifact or skill name under review.'),
      userFeedback: z.string().trim().min(1).max(4_000)
        .describe('The user-authorized knowledge issue or feedback to record.'),
      evidenceSnippet: z.string().trim().min(1).max(8_000).optional()
        .describe('Optional user-authorized excerpt supporting the feedback.'),
      artifactVersion: z.string().trim().min(1).max(256).optional(),
      artifactHash: z.string().trim().min(1).max(256).optional(),
      cwd: z.string().trim().min(1).max(2_048).optional(),
      sourceConversationId: z.string().trim().min(1).max(512).optional()
        .describe('Optional opaque conversation identity used only for idempotency; OMK stores a hash.'),
      sourceTurnId: z.string().trim().min(1).max(512).optional()
        .describe('Optional opaque turn identity used only for idempotency; OMK stores a hash.'),
      captureId: z.string().trim().min(1).max(512).optional()
        .describe('Optional stable idempotency key. OMK stores a hash, not this raw value.'),
      confirmedByUser: z.literal(true)
        .describe('Must be true: the user explicitly requested that this feedback be recorded.'),
    },
    outputSchema: {
      observationId: z.string(),
      capturedAt: z.string(),
      created: z.boolean(),
      reviewPath: z.string(),
      captureCoverage: z.object({
        coverageStatus: z.literal('partial'),
        capturePath: z.literal('explicit_tool_call'),
        observedEventKinds: z.array(observedEventKindSchema),
        unavailableEventKinds: z.array(unavailableEventKindSchema),
      }),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    const result = captureExplicitObservation({
      ...input,
      captureSourceKind: 'chatgpt_plugin',
    }, options);
    const structuredContent = {
      observationId: result.observationId,
      capturedAt: result.capturedAt,
      created: result.created,
      reviewPath: result.reviewPath,
      captureCoverage: result.captureCoverage,
    };
    return {
      content: [{
        type: 'text' as const,
        text: result.created
          ? '已记录显式 knowledge observation。覆盖范围为 partial：不包含完整对话、其他工具调用或隐藏推理。'
          : '该 observation 已记录，本次按幂等键返回已有结果。覆盖范围仍为 partial。',
      }],
      structuredContent,
    };
  });

  return server;
}

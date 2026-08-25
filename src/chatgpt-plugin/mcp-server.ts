import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type ExplicitObservationCaptureOptions,
} from '../observability/explicit-capture.js';
import {
  FileObservationCaptureStore,
  type ObservationCaptureStore,
} from './capture-store.js';
import {
  assertObservationCaptureScope,
  LOCAL_OBSERVATION_PRINCIPAL,
  validateObservationPrincipal,
  type ObservationPrincipal,
} from './principal.js';

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

export interface ChatGptObservationToolOptions {
  principal: ObservationPrincipal;
  captureStore: ObservationCaptureStore;
}

export interface ChatGptObservationMcpServerOptions extends ExplicitObservationCaptureOptions {
  principal?: ObservationPrincipal;
  captureStore?: ObservationCaptureStore;
}

export function createChatGptObservationMcpServer(
  options: ChatGptObservationMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: 'omk-chatgpt-observation-capture',
    version: '0.1.0',
  });

  if (options.captureStore && (options.observationsDir || options.now)) {
    throw new Error('注入 captureStore 时不能同时设置 observationsDir 或 now。');
  }
  const principal = validateObservationPrincipal(
    options.principal ?? LOCAL_OBSERVATION_PRINCIPAL,
  );
  const captureStore = options.captureStore ?? new FileObservationCaptureStore({
    observationsDir: options.observationsDir,
    now: options.now,
    partition: options.principal ? 'principal' : 'shared',
  });
  registerChatGptObservationTools(server, { principal, captureStore });

  return server;
}

export function registerChatGptObservationTools(
  server: McpServer,
  options: ChatGptObservationToolOptions,
): void {
  const principal = validateObservationPrincipal(options.principal);

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
    assertObservationCaptureScope(principal);
    const result = await options.captureStore.create(principal, {
      ...input,
      captureSourceKind: 'chatgpt_plugin',
    });
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
}

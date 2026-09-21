import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpDisplayCopy, resolveMcpDisplayLang, type McpDisplayLanguage } from './tool-copy.js';
import { z } from 'zod';
import {
  type ExplicitObservationCaptureOptions,
} from '../observability/inbox/explicit-capture.js';
import {
  type ObservationCaptureStore,
} from './capture-store.js';
import {
  FileObservationFeedbackStore,
  isObservationFeedbackStore,
  ObservationFeedbackStoreError,
} from './feedback-store.js';
import { registerObservationReviewComponent } from './review-component.js';
import {
  assertObservationCaptureScope,
  assertObservationDraftScope,
  assertObservationReadScope,
  assertObservationReviewScope,
  LOCAL_OBSERVATION_PRINCIPAL,
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_READ_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
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
const reviewVerdictSchema = z.enum(['real_issue', 'not_issue', 'needs_more_context']);
const reviewStateVerdictSchema = z.enum([
  'reviewed',
  'real_issue',
  'not_issue',
  'needs_more_context',
]);
const captureCoverageSchema = z.object({
  coverageStatus: z.literal('partial'),
  capturePath: z.literal('explicit_tool_call'),
  observedEventKinds: z.array(observedEventKindSchema),
  unavailableEventKinds: z.array(unavailableEventKindSchema),
});

/** 展示语言：`title`／`description` 给人和宿主 UI 读，必须同语言（见 `tool-copy.ts`）。 */
export interface ObservationMcpToolOptions extends McpDisplayLanguage {
  principal: ObservationPrincipal;
  captureStore: ObservationCaptureStore;
}

export interface ObservationMcpServerOptions extends ExplicitObservationCaptureOptions, McpDisplayLanguage {
  principal?: ObservationPrincipal;
  captureStore?: ObservationCaptureStore;
}

export function createObservationMcpServer(
  options: ObservationMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: 'omk-observation-mcp',
    version: '0.1.0',
  });

  if (options.captureStore && (options.observationsDir || options.now)) {
    throw new Error('注入 captureStore 时不能同时设置 observationsDir 或 now。');
  }
  const principal = validateObservationPrincipal(
    options.principal ?? LOCAL_OBSERVATION_PRINCIPAL,
  );
  const captureStore = options.captureStore ?? new FileObservationFeedbackStore({
    observationsDir: options.observationsDir,
    now: options.now,
    partition: options.principal ? 'principal' : 'shared',
  });
  registerObservationMcpTools(server, { principal, captureStore, lang: options.lang, env: options.env });

  return server;
}

export function registerObservationMcpTools(
  server: McpServer,
  options: ObservationMcpToolOptions,
): void {
  const principal = validateObservationPrincipal(options.principal);
  const lang = resolveMcpDisplayLang(options);

  if (principal.scopes.includes(OBSERVATION_CAPTURE_SCOPE)) {
    server.registerTool('save_observation', {
    ...mcpDisplayCopy('save_observation', lang),
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
      captureCoverage: captureCoverageSchema,
    },
    annotations: {
      title: mcpDisplayCopy('save_observation', lang).title,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    assertObservationCaptureScope(principal);
    const result = await options.captureStore.create(principal, {
      ...input,
      captureSourceKind: 'mcp',
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

  if (!isObservationFeedbackStore(options.captureStore)) return;
  const feedbackStore = options.captureStore;

  if (principal.scopes.includes(OBSERVATION_READ_SCOPE)) {
    server.registerTool('get_observation', {
    ...mcpDisplayCopy('get_observation', lang),
    inputSchema: {
      observationId: z.string().trim().min(1).max(128),
    },
    outputSchema: {
      observationId: z.string(),
      skillName: z.string(),
      artifactVersion: z.string(),
      artifactHash: z.string().optional(),
      cwd: z.string().optional(),
      firstSeen: z.string(),
      lastSeen: z.string(),
      occurrences: z.number().int().positive(),
      captureCoverage: captureCoverageSchema,
      evidence: z.array(z.object({
        captureId: z.string(),
        payloadHash: z.string(),
        capturedAt: z.string(),
        userFeedback: z.string(),
        evidenceSnippet: z.string().optional(),
      })),
      review: z.object({
        verdict: reviewStateVerdictSchema,
        reviewedAt: z.string(),
        note: z.string().optional(),
      }).optional(),
    },
    annotations: {
      title: mcpDisplayCopy('get_observation', lang).title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ observationId }) => {
    assertObservationReadScope(principal);
    const detail = await feedbackStore.get(principal, observationId);
    return {
      content: [{
        type: 'text' as const,
        text: `Observation ${detail.observationId} 共有 ${detail.occurrences} 次显式捕获；覆盖范围为 partial。`,
      }],
      structuredContent: {
        ...detail,
        review: detail.review ? {
          verdict: detail.review.verdict,
          reviewedAt: detail.review.reviewedAt,
          note: detail.review.note,
        } : undefined,
      },
    };
    });
  }

  if (principal.scopes.includes(OBSERVATION_REVIEW_SCOPE)) {
    server.registerTool('record_observation_review', {
    ...mcpDisplayCopy('record_observation_review', lang),
    inputSchema: {
      observationId: z.string().trim().min(1).max(128),
      verdict: reviewVerdictSchema,
      note: z.string().trim().min(1).max(500).optional(),
    },
    outputSchema: {
      observationId: z.string(),
      review: z.object({
        verdict: reviewVerdictSchema,
        reviewedAt: z.string(),
        note: z.string().optional(),
      }),
    },
    annotations: {
      title: mcpDisplayCopy('record_observation_review', lang).title,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    assertObservationReviewScope(principal);
    const result = await feedbackStore.review(principal, input);
    return {
      content: [{
        type: 'text' as const,
        text: `已记录 observation 复核结论：${result.review.verdict}。`,
      }],
      structuredContent: {
        observationId: result.observationId,
        review: {
          verdict: result.review.verdict,
          reviewedAt: result.review.reviewedAt,
          note: result.review.note,
        },
      },
    };
    });
  }

  if (principal.scopes.includes(OBSERVATION_DRAFT_SCOPE)) {
    server.registerTool('draft_sample_from_observation', {
    ...mcpDisplayCopy('draft_sample_from_observation', lang),
    inputSchema: {
      observationId: z.string().trim().min(1).max(128),
      prompt: z.string().trim().min(1).max(16_000)
        .describe('Proposed reproducible evaluation prompt.'),
      rubric: z.string().trim().min(1).max(8_000).optional()
        .describe('Optional reviewable success criteria.'),
      sampleId: z.string().trim().min(1).max(200).optional(),
      draftId: z.string().trim().min(1).max(512).optional()
        .describe('Optional stable idempotency key. OMK stores only its hash.'),
    },
    outputSchema: {
      draftId: z.string(),
      createdAt: z.string(),
      created: z.boolean(),
      status: z.literal('draft'),
      observationId: z.string(),
      sourceEvidence: z.array(z.object({
        captureId: z.string(),
        payloadHash: z.string(),
        capturedAt: z.string(),
      })),
      sample: z.object({
        sample_id: z.string(),
        prompt: z.string(),
        rubric: z.string().optional(),
        provenance: z.literal('production-trace'),
      }),
    },
    annotations: {
      title: mcpDisplayCopy('draft_sample_from_observation', lang).title,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    assertObservationDraftScope(principal);
    const observation = await feedbackStore.get(principal, input.observationId);
    if (observation.review?.verdict !== 'real_issue') {
      throw new ObservationFeedbackStoreError(
        'observation_review_required',
        '只有人工确认为 real_issue 的 observation 才能生成 sample 草稿。',
      );
    }
    const result = await feedbackStore.draftSample(principal, input);
    return {
      content: [{
        type: 'text' as const,
        text: result.created
          ? '已生成 regression sample 草稿；未写入正式评测集。'
          : '该 regression sample 草稿已存在，本次返回幂等结果。',
      }],
      structuredContent: {
        draftId: result.draft.draftId,
        createdAt: result.draft.createdAt,
        created: result.created,
        status: result.draft.status,
        observationId: result.draft.observationId,
        sourceEvidence: result.draft.sourceEvidence,
        sample: result.draft.sample,
      },
    };
    });
  }

  if (principal.scopes.includes(OBSERVATION_READ_SCOPE)) {
    registerObservationReviewComponent(server, { principal, feedbackStore, lang });
  }
}

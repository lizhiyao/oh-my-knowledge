import { EntityLinkConflictError } from '../../../knowledge/entities/links.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { createLocalEntityLinks, type EntityLinkApplication } from '../../../observability/application.js';
import type { ExecutorArchiveProducer } from '../../../executors/contracts/archive.js';
import type { EntityLinkStudioInspection, EntityLinkStudioPreview } from '../../view-models/knowledge/entity-links.js';

const id = z.string().uuid();
const workspace = z.string().trim().min(1).refine(isAbsolute, 'An explicit absolute workspace is required.').transform(value => resolve(value));
const ref = z.strictObject({ analysisId: id, entityId: id, mentionIds: z.array(id).min(1).max(64).optional() });
const base = { workspace };
const schema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('candidates'), selected: ref }),
  z.strictObject({ ...base, operation: z.literal('preview'), left: ref, right: ref,
    selection: z.strictObject({ executor: z.enum(['openai-api', 'codex']), model: z.string().min(1).max(1024) }), retryOf: id.nullable().optional() }),
  z.strictObject({ ...base, operation: z.literal('discard-preview'), previewToken: id }),
  z.strictObject({ ...base, operation: z.literal('propose'), previewToken: id, contentConfirmed: z.literal(true) }),
  z.strictObject({ ...base, operation: z.literal('continue'), reviewId: id, startToken: id, contentConfirmed: z.literal(true) }),
  z.strictObject({ ...base, operation: z.literal('list') }),
  z.strictObject({ ...base, operation: z.literal('quality') }),
  z.strictObject({ ...base, operation: z.literal('show'), reviewId: id }),
  z.strictObject({ ...base, operation: z.literal('resume'), reviewId: id }),
  z.strictObject({ ...base, operation: z.literal('recover-unknown'), reviewId: id, requestId: id }),
  z.strictObject({ ...base, operation: z.literal('cancel'), reviewId: id, requestId: id, expectedGeneration: z.number().int().positive(), reason: z.string().trim().min(1).max(4096) }),
  z.strictObject({ ...base, operation: z.literal('accept-preview'), reviewId: id, expectedGeneration: z.number().int().positive(),
    reason: z.string().trim().min(1).max(4096), objectLabel: z.string().trim().min(1).max(256).optional() }),
  z.strictObject({ ...base, operation: z.literal('accept'), reviewId: id, requestId: id, expectedGeneration: z.number().int().positive(),
    reason: z.string().trim().min(1).max(4096), identityConfirmed: z.literal(true), objectLabel: z.string().trim().min(1).max(256).optional(),
    replacementConfirmed: z.boolean().optional(), replacementConfirmationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }),
  z.strictObject({ ...base, operation: z.literal('reject'), reviewId: id, requestId: id, expectedGeneration: z.number().int().positive(), reason: z.string().trim().min(1).max(4096) }),
]);

export class EntityLinkStudioConflictError extends Error {
  constructor(readonly conflictCode: 'identity_unresolved' | 'kind_mismatch') { super(`entity_link_${conflictCode}`); }
}
export class EntityLinkStudioConfirmationError extends Error {
  constructor() { super('entity_link_confirmation_invalid'); }
}

/** Server-owned authorizations bind the displayed preview to its selected workspace.
 * They expire on restart; durable reviews remain readable without any authorization token.
 * Keep application instances alive for same-instance held-result archive recovery. */
export function createEntityLinkStudioService(producer: ExecutorArchiveProducer) {
  const applications = new Map<string, EntityLinkApplication>();
  type Authorization = { workspace: string; expires: number } & (
    { authorizationKind: 'preview'; preview: EntityLinkStudioPreview['preview']; proposeSeen: boolean }
    | { authorizationKind: 'start'; reviewId: string; generation: number; requestId: string });
  const authorizations = new Map<string, Authorization>();
  function app(root: string) {
    let value = applications.get(root);
    if (!value) {
      if (applications.size >= 32) throw new Error('Studio workspace session capacity exceeded.');
      value = createLocalEntityLinks(root, producer); applications.set(root, value);
    }
    return value;
  }
  function authorize(value: Omit<Extract<Authorization, { authorizationKind: 'preview' }>, 'expires'> | Omit<Extract<Authorization, { authorizationKind: 'start' }>, 'expires'>) {
    for (const [key, entry] of authorizations) if (entry.expires < Date.now()) authorizations.delete(key);
    if (value.authorizationKind === 'start') {
      // At most one prepared reservation per workspace. Obsolete start tokens
      // cannot authorize another review; reclaim them without evicting an app.
      for (const [key, entry] of authorizations) if (entry.authorizationKind === 'start' && entry.workspace === value.workspace
        && (entry.reviewId !== value.reviewId || entry.generation !== value.generation)) authorizations.delete(key);
      for (const [token, existing] of authorizations) if (existing.authorizationKind === 'start' && existing.workspace === value.workspace
        && existing.reviewId === value.reviewId && existing.generation === value.generation) return token;
    }
    const previewCount = [...authorizations.values()].filter(entry => entry.authorizationKind === 'preview').length;
    if ((value.authorizationKind === 'preview' && previewCount >= 224) || authorizations.size >= 256) throw new Error('Studio preview capacity exceeded; reopen later.');
    const token = randomUUID(); authorizations.set(token, { ...structuredClone(value), expires: Date.now() + 30 * 60 * 1000 }); return token;
  }
  function authorization(token: string, root: string) {
    const value = authorizations.get(token);
    if (!value || value.workspace !== root || value.expires < Date.now()) throw new EntityLinkStudioConfirmationError();
    return value;
  }
  function inspect(application: EntityLinkApplication, root: string, history: ReturnType<EntityLinkApplication['read']>): EntityLinkStudioInspection {
    const projection = application.projectHistory(history);
    return { workspace: root, history, projection, ...(projection.canStart ? { startToken: authorize({ authorizationKind: 'start', workspace: root,
      reviewId: history.reviewId, generation: history.generation, requestId: randomUUID() }) } : {}) };
  }
  return {
    async execute(input: unknown, signal?: AbortSignal): Promise<unknown> {
      const request = schema.parse(input); signal?.throwIfAborted();
      // Validate a token and workspace before constructing/accessing another workspace.
      const consent = request.operation === 'propose' || request.operation === 'discard-preview' ? authorization(request.previewToken, request.workspace)
        : request.operation === 'continue' ? authorization(request.startToken, request.workspace) : undefined;
      const application = app(request.workspace);
      let result: unknown;
      try { switch (request.operation) {
        case 'discard-preview': authorizations.delete(request.previewToken); return { discarded: true };
        case 'candidates': result = application.recall(request.selected); break;
        case 'preview': {
          const preview = application.preview(request.left, request.right, request.selection, request.retryOf ?? null);
          result = { workspace: request.workspace, previewToken: authorize({ authorizationKind: 'preview', workspace: request.workspace, preview, proposeSeen: false }), preview } satisfies EntityLinkStudioPreview;
          break;
        }
        case 'propose': {
          if (consent?.authorizationKind !== 'preview') throw new EntityLinkStudioConfirmationError();
          const preview = consent.preview;
          const replay = consent.proposeSeen;
          consent.proposeSeen = true;
          const existed = application.list().some(history => history.reviewId === preview.reviewId);
          // Receipt-first: the host checks the exact original prepare even on replay.
          const prepared = application.prepare({ reviewId: preview.reviewId, requestId: preview.requestId, plan: preview.plan, confirmDigest: preview.plan.confirmedDigest });
          const history = !replay && !existed && application.projectHistory(prepared).canStart
            ? await application.start({ reviewId: preview.reviewId, requestId: preview.startRequestId, expectedGeneration: prepared.generation }, signal) : prepared;
          result = inspect(application, request.workspace, history); break;
        }
        case 'continue': {
          if (consent?.authorizationKind !== 'start' || consent.reviewId !== request.reviewId) throw new EntityLinkStudioConfirmationError();
          result = inspect(application, request.workspace, await application.start({ reviewId: consent.reviewId, requestId: consent.requestId, expectedGeneration: consent.generation }, signal)); break;
        }
        case 'list': result = application.list().map(history => application.projectHistory(history)); break;
        case 'quality': result = application.quality(); break;
        case 'show': result = inspect(application, request.workspace, application.read(request.reviewId)); break;
        case 'resume': result = inspect(application, request.workspace, application.resume(request.reviewId)); break;
        case 'recover-unknown': result = inspect(application, request.workspace, application.recoverUnknown(request.reviewId, request.requestId)); break;
        case 'cancel': {
          result = inspect(application, request.workspace, application.cancelBeforeStart(request));
          for (const [token, entry] of authorizations) if (entry.workspace === request.workspace && (entry.authorizationKind === 'preview' ? entry.preview.reviewId : entry.reviewId) === request.reviewId) authorizations.delete(token);
          break;
        }
        case 'accept-preview': result = application.acceptPreview({ reviewId: request.reviewId, expectedGeneration: request.expectedGeneration,
          reason: request.reason, ...(request.objectLabel === undefined ? {} : { objectLabel: request.objectLabel }) }); break;
        case 'accept': case 'reject': {
          const command = { reviewId: request.reviewId, requestId: request.requestId, expectedGeneration: request.expectedGeneration, reason: request.reason };
          const history = request.operation === 'accept' ? application.decide({ ...command, decision: 'accept', identityConfirmed: request.identityConfirmed, ...(request.replacementConfirmed === undefined ? {} : { replacementConfirmed: request.replacementConfirmed }),
            ...(request.replacementConfirmationDigest === undefined ? {} : { replacementConfirmationDigest: request.replacementConfirmationDigest }), ...(request.objectLabel ? { objectLabel: request.objectLabel } : {}) })
            : application.decide({ ...command, decision: 'reject' });
          result = inspect(application, request.workspace, history); break;
        }
      }
      return structuredClone(result);
      } catch (error) {
        if (error instanceof EntityLinkConflictError && (error.conflictCode === 'identity_unresolved' || error.conflictCode === 'kind_mismatch')) {
          throw new EntityLinkStudioConflictError(error.conflictCode);
        }
        throw error;
      }
    },
  };
}

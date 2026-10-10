import { EvidenceWindowSchema } from './evidence.js';
import { z } from 'zod';
import { KnowledgeActorSchema } from '../../knowledge/contracts.js';
import { canonicalJson, GroundingSchema } from '../../knowledge/store.js';
import { KnowledgeRevisionSchema } from '../../knowledge/contracts.js';
import { EntityAnalysisWriteSchema, validateEntityAnalysis } from '../../knowledge/entities.js';
import { validateGroundingReferences, validateKnowledgeDraft } from '../../knowledge/validation.js';

export const ExtractionRunSchema = z.strictObject({
  runKind: z.literal('knowledge-extraction-run'), schemaVersion: z.literal(4),
  runId: z.string().uuid(), requestDigest: z.string(), generation: z.number().int().positive(),
  snapshotId: z.string().uuid(), sourceVersion: z.string(),
  origin: EvidenceWindowSchema.shape.origin,
  executor: z.string().min(1), model: z.string().min(1),
  promptVersion: z.literal('knowledge-extraction-v4'), promptHash: z.string(), inputDigest: z.string(),
  actor: KnowledgeActorSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(['generating', 'prepared', 'completed', 'failed', 'cancelled']),
  error: z.string().optional(), rawOutput: z.string().optional(),
  rejections: z.array(z.strictObject({ index: z.number().int().nonnegative(), reasons: z.array(z.string()) })),
  entityAnalysis: EntityAnalysisWriteSchema.optional(),
  entityRejections: z.array(z.strictObject({ component: z.enum(['entity', 'mention']), index: z.number().int().nonnegative(), reasons: z.array(z.string()) })).optional(),
  intents: z.array(z.strictObject({
    requestId: z.string(), revision: KnowledgeRevisionSchema, grounding: GroundingSchema,
  })),
  committed: z.array(z.strictObject({ knowledgeId: z.string(), revisionId: z.string() })),
  runtime: z.strictObject({
    durationMs: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional(),
    costUSD: z.number().optional(),
  }).optional(),
}).superRefine((run, context) => {
  if (['prepared', 'completed'].includes(run.status) && !run.entityAnalysis) {
    context.addIssue({ code: 'custom', path: ['entityAnalysis'], message: 'Prepared window extraction needs an entity intent, including empty results.' });
  }
  if (run.entityAnalysis && (run.entityAnalysis.analysisId !== run.runId || run.entityAnalysis.snapshotId !== run.snapshotId
    || run.entityAnalysis.sourceVersion !== run.sourceVersion || run.entityAnalysis.expectedGeneration !== 0
    || run.entityAnalysis.expectedHeadRevisionId !== null)) {
    context.addIssue({ code: 'custom', path: ['entityAnalysis'], message: 'Entity intent does not match the extraction window.' });
  }
  const add = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  if (['prepared', 'completed'].includes(run.status) && run.rawOutput === undefined) add(['rawOutput'], 'Prepared extraction needs its original output.');
  const analysis = run.entityAnalysis?.revision;
  if (!analysis) {
    if (run.intents.length || run.committed.length) add(['intents'], 'Knowledge intents require an entity analysis.');
    return;
  }
  const actor = { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId };
  if (validateEntityAnalysis(analysis).length || analysis.parentRevisionId !== undefined
    || canonicalJson(analysis.revisedBy) !== canonicalJson(actor)) add(['entityAnalysis'], 'Invalid entity birth intent.');
  if (new Set(run.intents.map(intent => intent.requestId)).size !== run.intents.length) add(['intents'], 'Duplicate knowledge request.');
  for (const field of ['knowledgeId', 'revisionId'] as const) {
    if (new Set(run.intents.map(intent => intent.revision[field])).size !== run.intents.length) add(['intents'], 'Duplicate knowledge identity.');
  }
  for (const [index, { revision, grounding }] of run.intents.entries()) {
    const refs = grounding.sourceBindings.flatMap(binding => binding.evidenceRefs); const registered = new Set(refs);
    const ref = grounding.entityAnalysisRef;
    const draft = { title: revision.title, content: revision.content, entities: revision.entities, evidence: revision.evidence };
    if (ref?.analysisId !== run.runId || ref.revisionId !== analysis.revisionId
      || grounding.sourceBindings.length !== 1 || grounding.sourceBindings[0].snapshotId !== run.snapshotId
      || grounding.sourceBindings[0].sourceVersion !== run.sourceVersion || registered.size !== refs.length
      || grounding.revisionId !== revision.revisionId || revision.parentRevision !== undefined
      || revision.createdAt !== revision.revisedAt || canonicalJson(revision.createdBy) !== canonicalJson(actor)
      || canonicalJson(revision.revisedBy) !== canonicalJson(actor)
      || !validateKnowledgeDraft(draft, registered).accepted || validateGroundingReferences(draft, grounding, registered).length
      || revision.entities.some(entity => {
        const known = analysis.entities.find(candidate => candidate.entityId === entity.entityId);
        return !known || known.label !== entity.label || known.description !== entity.description
          || known.uncertainties.some(reason => !grounding.identityUncertainties.includes(reason));
      })
      || grounding.mentions.some(mention => !analysis.mentions.some(known => canonicalJson(known) === canonicalJson(mention)))) {
      add(['intents', index], 'Knowledge intent differs from the bound entity birth revision.');
    }
  }
  const expected = run.intents.map(intent => ({ knowledgeId: intent.revision.knowledgeId, revisionId: intent.revision.revisionId }));
  if ((run.status === 'completed' && canonicalJson(expected) !== canonicalJson(run.committed))
    || new Set(run.committed.map(ref => ref.knowledgeId)).size !== run.committed.length
    || run.committed.some(ref => !expected.some(candidate => canonicalJson(candidate) === canonicalJson(ref)))) {
    add(['committed'], 'Committed knowledge does not match the run intents.');
  }
});
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;
export interface ExtractionRunStore {
  create(run: ExtractionRun): void;
  read(runId: string): ExtractionRun;
  list(): ExtractionRun[];
  save(run: ExtractionRun, expectedGeneration: number): void;
}

/** Safe run summary. Counts describe the prepared birth revision; inspection loads the chosen history revision. */
export function extractionRunSummary(run: ExtractionRun) {
  const analysis = run.entityAnalysis;
  return { runId: run.runId, status: run.status, startedAt: run.startedAt, committed: run.committed, rejections: run.rejections,
    ...(run.runtime ? { runtime: run.runtime } : {}),
    ...(analysis ? { entityAnalysis: { analysisId: analysis.analysisId, revisionId: analysis.revision.revisionId,
      entityCount: analysis.revision.entities.length, mentionCount: analysis.revision.mentions.length,
      unresolvedCount: analysis.revision.entities.filter(entity => entity.identityStatus === 'unresolved').length,
      rejectedCount: run.entityRejections?.length ?? 0 } } : {}),
  };
}
export type ExtractionRunSummary = ReturnType<typeof extractionRunSummary>;

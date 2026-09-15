import { validateGroundingReferences, validateKnowledgeDraft } from './admission.js';
import type { KnowledgeActor } from './contracts.js';
import { canonicalJson, KnowledgeEnvelopeSchema, type KnowledgeEnvelope, type KnowledgeWrite } from './store.js';

export function validateKnowledgeHistory(entry: KnowledgeEnvelope): void {
  if (entry.generation !== entry.receipts.length
    || entry.writeHeadRevisionId !== entry.revisions.at(-1)!.revisionId
    || new Set(entry.receipts.map((r) => r.requestId)).size !== entry.receipts.length
    || entry.grounding.length !== entry.revisions.length) throw new Error('Invalid knowledge history.');
  const seen = new Set<string>();
  for (const [index, revision] of entry.revisions.entries()) {
    const previous = entry.revisions[index - 1];
    if (revision.knowledgeId !== entry.knowledgeId || seen.has(revision.revisionId)
      || (previous ? revision.parentRevision?.knowledgeId !== entry.knowledgeId || revision.parentRevision?.revisionId !== previous.revisionId : revision.parentRevision !== undefined)
      || canonicalJson(revision.createdBy) !== canonicalJson(entry.revisions[0].createdBy)
      || revision.createdAt !== entry.revisions[0].createdAt
      || Date.parse(revision.revisedAt) < Date.parse(revision.createdAt)) throw new Error('Invalid revision lineage.');
    if (!previous && (revision.createdAt !== revision.revisedAt
      || canonicalJson(revision.createdBy) !== canonicalJson(revision.revisedBy))) throw new Error('Invalid initial revision authorship.');
    seen.add(revision.revisionId);
    const grounding = entry.grounding[index];
    const draft = { title: revision.title, content: revision.content, entities: revision.entities, evidence: revision.evidence };
    const sourceRefs = grounding.sourceBindings.flatMap((source) => source.evidenceRefs);
    const registeredEvidence = new Set(sourceRefs);
    if (registeredEvidence.size !== sourceRefs.length
      || grounding.revisionId !== revision.revisionId
      || !validateKnowledgeDraft(draft, registeredEvidence).accepted
      || validateGroundingReferences(draft, grounding, registeredEvidence).length) throw new Error('Invalid revision references.');
  }
  for (const [index, receipt] of entry.receipts.entries()) {
    if (receipt.committedGeneration !== index + 1 || !seen.has(receipt.revisionId)) throw new Error('Invalid knowledge receipt.');
  }
  if (entry.maintenance.some((choice) => !seen.has(choice.revisionId))) throw new Error('Unknown maintenance target.');
}
export function applyKnowledgeWrite(existing: KnowledgeEnvelope | undefined, command: KnowledgeWrite,
  actor: KnowledgeActor, namespace: string, commandDigest: string): KnowledgeEnvelope {
  if (existing) validateKnowledgeHistory(existing);
  const payloadActor = command.commandKind === 'append_revision' ? command.revision.revisedBy : command.maintenance.actor;
  if (payloadActor.actorKind !== actor.actorKind || payloadActor.actorId !== actor.actorId) throw new Error('unauthorized');
  if (existing && (existing.knowledgeId !== command.knowledgeId || existing.namespace !== namespace)) throw new Error('Knowledge identity mismatch.');
  const receipt = existing?.receipts.find((item) => item.requestId === command.requestId);
  if (receipt) {
    if (receipt.commandDigest !== commandDigest) throw new Error('idempotency_conflict');
    return existing!;
  }
  const generation = existing?.generation ?? 0;
  if (command.expectedGeneration !== generation || generation >= Number.MAX_SAFE_INTEGER) throw new Error('conflict');
  const revisions = [...(existing?.revisions ?? [])];
  const grounding = [...(existing?.grounding ?? [])];
  const maintenance = [...(existing?.maintenance ?? [])];
  let revisionId: string;
  if (command.commandKind === 'append_revision') {
    if (command.expectedHeadRevisionId !== (existing?.writeHeadRevisionId ?? null)) throw new Error('conflict');
    if (canonicalJson(command.revision.revisedBy) !== canonicalJson(actor)
      || (!existing && canonicalJson(command.revision.createdBy) !== canonicalJson(actor))) throw new Error('unauthorized');
    revisions.push(command.revision);
    grounding.push(command.grounding);
    revisionId = command.revision.revisionId;
  } else {
    if (!existing) throw new Error('Unknown knowledge.');
    if (canonicalJson(command.maintenance.actor) !== canonicalJson(actor)) throw new Error('unauthorized');
    maintenance.push(command.maintenance);
    revisionId = command.maintenance.revisionId;
  }
  const nextReceipt = { requestId: command.requestId, commandDigest, committedGeneration: generation + 1, revisionId };
  const next = KnowledgeEnvelopeSchema.parse({
    storeKind: 'knowledge-item-history', schemaVersion: 1, namespace,
    knowledgeId: command.knowledgeId, generation: generation + 1,
    writeHeadRevisionId: revisions.at(-1)!.revisionId,
    revisions, grounding, maintenance, receipts: [...(existing?.receipts ?? []), nextReceipt],
  });
  validateKnowledgeHistory(next);
  return next;
}

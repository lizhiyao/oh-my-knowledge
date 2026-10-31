import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { KnowledgeActor } from '../../src/knowledge/contracts.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { FileKnowledgeRelationStore } from '../../src/knowledge/adapters/relation-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { KnowledgeRelationsApplication } from '../../src/knowledge/application/relations.js';
import type { KnowledgeRelationProposeInput, KnowledgeRelationReviewInput, KnowledgeRelationWithdrawInput } from '../../src/knowledge/relations.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';
import { testDirectory } from '../helpers/temp-directory.js';
import { bodyWrite } from './body-fixtures.js';

export const relationActor: Extract<KnowledgeActor, { actorKind: 'agent' }> = { actorKind: 'agent', actorId: 'relation-fixture:author', executionRef: 'authored-fixture:one' };
export const relationOtherActor: Extract<KnowledgeActor, { actorKind: 'agent' }> = { actorKind: 'agent', actorId: 'relation-fixture:reviewer', executionRef: 'authored-fixture:two' };
export const relationAt = '2026-10-31T00:00:00Z';
/** Authored engineering fixture, with real Source3 capture and body-store digest admission. No model or semantic Gold. */
export function relationsFixture() {
  const root = testDirectory('omk-relations-'), knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root);
  const sources = new FileSourceStore(join(root, 'sources'), root), store = new FileKnowledgeRelationStore(join(root, 'knowledge-relations'), 'local', root);
  const snapshots = ['Alpha preserves history. 😀 Conditions remain bounded.', 'Beta adds a source scope limit. Execution is unknown.'].map((text, index) => captureTraceFixture(root, {
    path: join(root, `source-${index}.jsonl`), records: [{ recordIndex: index, raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) }],
  }));
  const commands = snapshots.map((snapshot, index) => {
    const command = bodyWrite(); command.knowledgeId = randomUUID(); command.requestId = randomUUID();
    command.revision = { ...command.revision, knowledgeId: command.knowledgeId, revisionId: randomUUID(), title: `Authored source ${index + 1}`,
      createdBy: relationActor, revisedBy: relationActor, content: { segments: [{ segmentId: 's1', text: snapshot.excerpts[0].text,
        evidence: [{ source: sourceRef(snapshot), selection: { evidenceRef: snapshot.excerpts[0].evidenceRef, start: 0, end: snapshot.excerpts[0].text.length, quote: snapshot.excerpts[0].text }, basis: 'source_assertion' }] }] } };
    command.revision.bodyDigest = knowledgeBodyDigest(command.revision); knowledge.write(command, relationActor); return command;
  });
  const bodyRefs = commands.map(c => knowledgeBodyRef(c.revision)), relationId = randomUUID();
  const appFor = (actor?: KnowledgeActor) => new KnowledgeRelationsApplication({ knowledge, sources, relations: store, actor, now: () => relationAt });
  const app = appFor(relationActor);
  const identity = () => { const h = store.read(relationId); return { relationId, requestId: randomUUID(), expectedGeneration: h?.generation ?? 0, expectedHeadEventId: h?.writeHeadEventId ?? null }; };
  const propose = (overrides: Partial<KnowledgeRelationProposeInput> = {}): KnowledgeRelationProposeInput => {
    const h = store.read(relationId), last = [...(h?.events ?? [])].reverse().find(e => e.eventKind === 'relation_proposed');
    return { ...identity(), parentRelationRevisionId: last?.eventId ?? null, relationType: 'supplements', from: { bodyRef: bodyRefs[0] }, to: { bodyRef: bodyRefs[1] },
      question: 'Which source limits need to remain visible?', conditions: ['Only the authored saved source windows.'],
      comparisonScope: { status: 'unknown', subject: 'Distinct source-local objects.', modality: 'Source assertions, not execution.', time: 'unknown', version: 'Saved exact snapshots only.', reason: 'No fact-time equivalence is established.' },
      basis: 'inference', reason: 'The first bounded report adds a history constraint to the second report.', limitations: ['Authored engineering demonstration; not a verified semantic relation.'],
      evidence: commands.map((c, index) => ({ side: index === 0 ? 'from' as const : 'to' as const,
        bodySelection: { segmentId: 's1', start: 0, end: c.revision.content.segments[0].text.length, quote: c.revision.content.segments[0].text }, ...c.revision.content.segments[0].evidence[0] })), ...overrides };
  };
  const review = (choice: 'accept' | 'reject' = 'accept', overrides: Partial<KnowledgeRelationReviewInput> = {}): KnowledgeRelationReviewInput => {
    const proposal = [...store.read(relationId)!.events].reverse().find(e => e.eventKind === 'relation_proposed')!;
    return { ...identity(), relationRevisionId: proposal.eventId, choice, reason: 'Explicit fixture operator opinion.', limitations: ['Source interpretation remains bounded.'],
      checkedEvidenceIndices: proposal.evidence.map((_, index) => index), supersedesReviewEventIds: [], ...overrides };
  };
  const withdraw = (overrides: Partial<KnowledgeRelationWithdrawInput> = {}): KnowledgeRelationWithdrawInput => ({ ...identity(),
    relationRevisionId: [...store.read(relationId)!.events].reverse().find(e => e.eventKind === 'relation_proposed')!.eventId,
    reason: 'Author withdraws this exact proposal.', limitations: ['Original opinions remain in history.'], ...overrides });
  const appendBody = (index: number) => {
    const previous = commands[index].revision, h = knowledge.read(previous.knowledgeId), draft = { title: previous.title, reuseRationale: previous.reuseRationale,
      content: { ...previous.content, segments: previous.content.segments.map(s => ({ ...s, text: `${s.text}Explicit later revision.` })) } };
    const revision = { ...previous, ...draft, revisionId: randomUUID(), bodyDigest: knowledgeBodyDigest(draft), parentRevision: { knowledgeId: previous.knowledgeId, revisionId: previous.revisionId }, revisionReason: 'Real append-only fixture revision.' };
    knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: previous.knowledgeId, expectedGeneration: h.generation, expectedHeadRevisionId: h.writeHeadRevisionId, revision }, relationActor);
    return revision;
  };
  return { root, knowledge, sources, snapshots, store, commands, bodyRefs, relationId, app, appFor, propose, review, withdraw, appendBody };
}

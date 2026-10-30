import type { KnowledgeActor, KnowledgeRevision } from './contracts.js';
import { canonicalJson } from './store.js';
import { SourceCoverageEnvelopeSchema, SourceCoverageWriteSchema, SourceLedgerEnvelopeSchema, SourceLedgerWriteSchema, SourceReviewActorSchema,
  type SourceCoverageData, type SourceCoverageDecisionRef, type SourceCoverageEnvelope, type SourceCoverageRef, type SourceCoverageRevision,
  type SourceCoverageWrite, type SourceLedgerData, type SourceLedgerEnvelope, type SourceLedgerRevision, type SourceLedgerWrite,
  type SourceReviewManifest } from './source-review.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate source review ${label}.`);
}
function exact(actual: readonly string[], expected: readonly string[], label: string): void {
  unique(actual, label);
  if (!same([...actual].sort(), [...expected].sort())) throw new Error(`Incomplete source review ${label}.`);
}
export function validateSourceReviewManifest(manifest: SourceReviewManifest): void {
  unique(manifest.sources.map(source => source.sourceKey), 'source keys');
  unique(manifest.sources.map(source => canonicalJson(source.sourceRef)), 'source refs');
  unique(manifest.units.map(unit => unit.unitKey), 'unit keys');
  unique(manifest.units.flatMap(unit => unit.evidenceRef === null ? [] : [unit.evidenceRef]), 'excerpt refs');
  for (const source of manifest.sources) {
    if (manifest.units.filter(unit => unit.sourceKey === source.sourceKey && unit.unitKind === 'source_metadata').length !== 1) throw new Error('Every source requires one metadata unit.');
  }
  for (const unit of manifest.units) {
    if (!manifest.sources.some(source => source.sourceKey === unit.sourceKey) || !unit.fieldPaths.length
      || (unit.unitKind === 'source_metadata' ? unit.evidenceRef !== null || !unit.utf16Length : unit.evidenceRef === null)) throw new Error('Invalid source review manifest unit.');
    unique(unit.fieldPaths, 'field paths');
  }
}
function validateEvidence(evidence: SourceLedgerData['items'][number]['evidence'], manifest: SourceReviewManifest) {
  for (const anchor of evidence) {
    const unit = manifest.units.find(unit => unit.unitKey === anchor.unitKey);
    if (!unit || unit.unitKind !== anchor.unitKind || anchor.end > unit.utf16Length) throw new Error('Source review evidence is outside its delivered unit.');
  }
}
/** Bounds and inventories only. Exact text/digests are verified by the host before publication. */
export function validateSourceLedgerData(data: SourceLedgerData): void {
  validateSourceReviewManifest(data.manifest);
  exact(data.unitDispositions.map(unit => unit.unitKey), data.manifest.units.map(unit => unit.unitKey), 'unit dispositions');
  unique(data.items.map(item => item.itemId), 'item IDs');
  const itemIds = new Set(data.items.map(item => item.itemId));
  for (const unit of data.unitDispositions) {
    unique(unit.itemIds, 'unit item references');
    if (unit.itemIds.some(id => !itemIds.has(id))) throw new Error('Unknown source ledger item.');
    if (unit.disposition === 'retain' && !unit.itemIds.length) throw new Error('Retained source unit requires an item.');
    for (const itemId of unit.itemIds) {
      const item = data.items.find(item => item.itemId === itemId)!;
      if (![...item.evidence, ...item.facets.flatMap(facet => facet.evidence)].some(anchor => anchor.unitKey === unit.unitKey)) throw new Error('Unit item reference requires its own unit evidence.');
    }
  }
  for (const item of data.items) {
    unique(item.equivalentItemIds, 'equivalent items'); unique(item.facets.map(facet => facet.facetId), 'facet IDs');
    if (item.equivalentItemIds.some(id => id === item.itemId || !itemIds.has(id))) throw new Error('Invalid equivalent source ledger item.');
    if (item.disposition === 'retain' && !item.evidence.length) throw new Error('Retained source item requires evidence.');
    validateEvidence(item.evidence, data.manifest);
    for (const facet of item.facets) {
      if (['stated', 'explicit_unknown'].includes(facet.epistemicStatus) && !facet.evidence.length) throw new Error('Stated source facet requires evidence.');
      validateEvidence(facet.evidence, data.manifest);
    }
    for (const anchor of [...item.evidence, ...item.facets.flatMap(facet => facet.evidence)]) {
      if (!data.unitDispositions.find(unit => unit.unitKey === anchor.unitKey)?.itemIds.includes(item.itemId)) throw new Error('Source item evidence requires a matching unit disposition.');
    }
  }
}
function targetKey(target: SourceCoverageData['checks'][number]['target']): string { return canonicalJson(target); }
export function validateSourceCoverageStructure(data: SourceCoverageData): void {
  validateSourceReviewManifest(data.manifest);
  unique(data.bodyRefs.map(canonicalJson), 'body refs'); unique(data.checks.map(check => check.checkId), 'check IDs'); unique(data.findings.map(finding => finding.findingId), 'finding IDs');
  unique(data.checks.map(check => canonicalJson([check.target, check.coverageTarget])), 'coverage targets');
  const validateAnchors = (anchors: SourceCoverageData['checks'][number]['bodyEvidence']) => {
    if (anchors.some(anchor => !data.bodyRefs.some(ref => same(ref, anchor.bodyRef)))) throw new Error('Body evidence is outside the exact coverage bodies.');
  };
  for (const check of data.checks) {
    validateEvidence(check.sourceEvidence, data.manifest); validateAnchors(check.bodyEvidence);
    const target = check.target;
    if (target.targetKind === 'source_unit' && !data.manifest.units.some(unit => unit.unitKey === target.unitKey)) throw new Error('Unknown source coverage unit.');
    if (target.targetKind === 'body_segment' && !data.bodyRefs.some(ref => same(ref, target.bodyRef))) throw new Error('Unknown source coverage body.');
    if (check.status === 'covered' && (!check.bodyEvidence.length || check.coverageTarget === 'factual_value' && check.factualValue !== 'known')) throw new Error('Unknown factual value cannot be covered.');
    if (check.status === 'covered' && check.coverageTarget !== 'preserved_bounded_input_limitation' && !check.sourceEvidence.length) throw new Error('Covered source meaning requires source evidence.');
    if (check.coverageTarget !== 'factual_value' && check.factualValue !== 'not_applicable') throw new Error('Only a factual-value target can assert a factual value.');
    if (check.coverageTarget === 'preserved_bounded_input_limitation' && check.status === 'covered') {
      const bound = check.boundedInput;
      if (!bound || bound.sourceInputDigest !== data.manifest.sourceInputDigest) throw new Error('Bounded input coverage requires its exact inspected input.');
      exact(bound.unitKeys, data.manifest.units.map(unit => unit.unitKey), 'bounded input units'); unique(bound.inspectedFields, 'inspected fields');
      const fields = new Set(data.manifest.units.flatMap(unit => unit.fieldPaths));
      if (bound.inspectedFields.some(field => !fields.has(field))) throw new Error('Bounded input inspected an unknown field.');
    } else if (check.boundedInput !== null) throw new Error('Unexpected bounded input witness.');
  }
  for (const finding of data.findings) { validateEvidence(finding.sourceEvidence, data.manifest); validateAnchors(finding.bodyEvidence); }
}
export function validateSourceCoverageData(data: SourceCoverageData, ledger: Pick<SourceLedgerRevision, 'revisionId' | 'digest' | 'data'>, bodies: readonly KnowledgeRevision[]): void {
  validateSourceLedgerData(ledger.data); validateSourceCoverageStructure(data);
  if (!same(data.manifest, ledger.data.manifest) || data.ledgerRef.revisionId !== ledger.revisionId || data.ledgerRef.digest !== ledger.digest) throw new Error('Source coverage ledger identity conflict.');
  exact(data.bodyRefs.map(canonicalJson), bodies.map(body => canonicalJson({ knowledgeId: body.knowledgeId, revisionId: body.revisionId, bodyDigest: body.bodyDigest })), 'body refs');
  const targets = [
    ...data.manifest.units.map(unit => ({ targetKind: 'source_unit' as const, unitKey: unit.unitKey })),
    ...ledger.data.items.flatMap(item => [{ targetKind: 'ledger_item' as const, itemId: item.itemId },
      ...item.facets.map(facet => ({ targetKind: 'ledger_facet' as const, itemId: item.itemId, facetId: facet.facetId }))]),
    ...bodies.flatMap(body => body.content.segments.map(segment => ({ targetKind: 'body_segment' as const,
      bodyRef: { knowledgeId: body.knowledgeId, revisionId: body.revisionId, bodyDigest: body.bodyDigest }, segmentId: segment.segmentId }))),
  ].map(targetKey);
  const actualTargets = new Set(data.checks.map(check => targetKey(check.target)));
  if (actualTargets.size !== targets.length || targets.some(key => !actualTargets.has(key))) throw new Error('Coverage must check every exact unit, item, facet and body segment.');
  const validateBody = (anchors: SourceCoverageData['checks'][number]['bodyEvidence']) => {
    for (const anchor of anchors) {
      const body = bodies.find(body => same(anchor.bodyRef, { knowledgeId: body.knowledgeId, revisionId: body.revisionId, bodyDigest: body.bodyDigest }));
      const segment = body?.content.segments.find(segment => segment.segmentId === anchor.segmentId);
      if (!segment || segment.text.slice(anchor.start, anchor.end) !== anchor.quote || anchor.end > segment.text.length) throw new Error('Source coverage body quote mismatch.');
    }
  };
  for (const check of data.checks) {
    validateBody(check.bodyEvidence);
  }
  for (const finding of data.findings) { validateEvidence(finding.sourceEvidence, data.manifest); validateBody(finding.bodyEvidence); }
}
export function sourceCoverageUnresolved(data: SourceCoverageData, ledger: SourceLedgerData): string[] {
  return [...ledger.unitDispositions.filter(unit => unit.disposition !== 'retain').map(unit => `unit:${unit.unitKey}`),
    ...ledger.items.filter(item => item.disposition !== 'retain').map(item => `item:${item.itemId}`),
    ...data.checks.filter(check => check.status !== 'covered').map(check => `check:${check.checkId}`), ...data.findings.map(finding => `finding:${finding.findingId}`)];
}
function validateHistory(history: SourceLedgerEnvelope | SourceCoverageEnvelope): void {
  if (history.events.length !== history.generation || history.receipts.length !== history.generation || history.writeHeadEventId !== history.events.at(-1)?.eventId) throw new Error('Invalid source review history head.');
  unique(history.events.map(event => event.eventId), 'event IDs'); unique(history.receipts.map(receipt => receipt.requestId), 'request IDs');
  const revisionIds = new Set<string>(); let previousRevision: string | null = null;
  for (const [index, event] of history.events.entries()) {
    const receipt = history.receipts[index];
    if (event.parentEventId !== (history.events[index - 1]?.eventId ?? null) || receipt.eventId !== event.eventId || receipt.requestId !== event.eventId || receipt.committedGeneration !== index + 1) throw new Error('Invalid source review history references.');
    if (event.eventKind === 'analysis') {
      if (revisionIds.has(event.revision.revisionId) || event.revision.parentRevisionId !== previousRevision || !same(event.actor, event.revision.revisedBy)) throw new Error('Invalid source review analysis history.');
      if (history.storeKind === 'knowledge-source-ledger-history') validateSourceLedgerData((event.revision as SourceLedgerRevision).data);
      else validateSourceCoverageStructure((event.revision as SourceCoverageRevision).data);
      revisionIds.add(event.revision.revisionId); previousRevision = event.revision.revisionId;
    }
  }
}
export function validateSourceLedgerHistory(history: SourceLedgerEnvelope): void { validateHistory(history); }
function sameBinding(a: SourceCoverageDecisionRef | Extract<SourceCoverageEnvelope['events'][number], { eventKind: 'decision' }>['decision'], b: unknown): boolean {
  const { coverageRef, sourceSetId, ledgerRef, bodyRefs } = a;
  return same({ coverageRef, sourceSetId, ledgerRef, bodyRefs }, b);
}
function bindingOf(decision: SourceCoverageDecisionRef | Extract<SourceCoverageEnvelope['events'][number], { eventKind: 'decision' }>['decision']) {
  return { coverageRef: decision.coverageRef, sourceSetId: decision.sourceSetId, ledgerRef: decision.ledgerRef, bodyRefs: decision.bodyRefs };
}
export function validateSourceCoverageHistory(history: SourceCoverageEnvelope): void {
  validateHistory(history);
  const inactive = new Set<string>();
  for (const [index, event] of history.events.entries()) {
    if (event.eventKind === 'analysis') continue;
    if (event.eventKind === 'revocation') {
      if (!history.events.slice(0, index).some(previous => previous.eventId === event.targetEventId && previous.eventKind === 'decision') || inactive.has(event.targetEventId)) throw new Error('Invalid source decision revocation.');
      inactive.add(event.targetEventId); continue;
    }
    const decision = event.decision, ref = decision.coverageRef;
    const analysis = history.events.slice(0, index).find(previous => previous.eventKind === 'analysis' && previous.revision.revisionId === ref.revisionId);
    if (ref.coverageId !== history.coverageId || analysis?.eventKind !== 'analysis' || analysis.revision.digest !== ref.digest
      || decision.sourceSetId !== analysis.revision.data.manifest.sourceSetId || !same(decision.ledgerRef, analysis.revision.data.ledgerRef) || !same(decision.bodyRefs, analysis.revision.data.bodyRefs)) throw new Error('Source decision analysis identity conflict.');
    unique(decision.supersedesEventIds, 'superseded decisions'); unique(decision.dispositions.map(item => item.unresolvedId), 'unresolved dispositions');
    for (const target of decision.supersedesEventIds) {
      const previous = history.events.slice(0, index).find(previous => previous.eventId === target);
      if (previous?.eventKind !== 'decision' || inactive.has(target) || !same(bindingOf(previous.decision), bindingOf(decision))) throw new Error('Invalid source decision supersession.');
      inactive.add(target);
    }
    if (decision.decisionKind === 'proceed_with_limits' && decision.dispositions.some(item => item.disposition === 'blocks')) throw new Error('Blocking source dispositions cannot proceed.');
  }
}
/** Explicit supersession/revocation only. Newer time and model agreement never select truth. */
export function selectSourceCoverageDecision(history: SourceCoverageEnvelope | undefined, ref: SourceCoverageRef) {
  if (history) validateSourceCoverageHistory(history);
  if (history && history.coverageId !== ref.coverageId) throw new Error('Source decision selection identity conflict.');
  const inactive = new Set(history?.events.flatMap(event => event.eventKind === 'decision' ? event.decision.supersedesEventIds : event.eventKind === 'revocation' ? [event.targetEventId] : []) ?? []);
  const events = history?.events.filter((event): event is Extract<SourceCoverageEnvelope['events'][number], { eventKind: 'decision' }> =>
    event.eventKind === 'decision' && same(event.decision.coverageRef, ref) && !inactive.has(event.eventId)) ?? [];
  const opinions = new Set(events.map(event => canonicalJson({ decisionKind: event.decision.decisionKind,
    dispositions: [...event.decision.dispositions].sort((a, b) => a.unresolvedId.localeCompare(b.unresolvedId)).map(({ unresolvedId, disposition }) => ({ unresolvedId, disposition })) })));
  const status = !events.length ? 'not_reviewed' as const : opinions.size > 1 ? 'disputed' as const : events[0].decision.decisionKind;
  return { status, events };
}
export function assertSourceCoverageDecision(history: SourceCoverageEnvelope, ref: SourceCoverageDecisionRef): void {
  const selected = selectSourceCoverageDecision(history, ref.coverageRef);
  if (selected.status !== 'proceed_with_limits' || !selected.events.some(event => event.eventId === ref.eventId && sameBinding(event.decision, bindingOf(ref)))) throw new Error('An active nonconflicting exact source coverage decision is required.');
}
export function validateSourceCoverageDecisionDispositions(command: SourceCoverageWrite, coverage: SourceCoverageRevision, ledger: SourceLedgerRevision): void {
  if (command.commandKind !== 'record_decision') return;
  if (command.decision.coverageRef.coverageId !== command.coverageId || command.decision.coverageRef.revisionId !== coverage.revisionId || command.decision.coverageRef.digest !== coverage.digest
    || command.decision.sourceSetId !== coverage.data.manifest.sourceSetId || !same(command.decision.ledgerRef, coverage.data.ledgerRef) || !same(command.decision.bodyRefs, coverage.data.bodyRefs)
    || coverage.data.ledgerRef.revisionId !== ledger.revisionId || coverage.data.ledgerRef.digest !== ledger.digest) throw new Error('Source decision reference conflict.');
  exact(command.decision.dispositions.map(item => item.unresolvedId), sourceCoverageUnresolved(coverage.data, ledger.data), 'unresolved dispositions');
}
export function applySourceLedgerWrite(existing: SourceLedgerEnvelope | undefined, input: SourceLedgerWrite, actorInput: KnowledgeActor, namespace: string, commandDigest: string, at: string): SourceLedgerEnvelope {
  const command = SourceLedgerWriteSchema.parse(input), actor = SourceReviewActorSchema.parse(actorInput);
  if (existing) { validateSourceLedgerHistory(existing); if (existing.namespace !== namespace || existing.ledgerId !== command.ledgerId) throw new Error('Source ledger identity conflict.'); }
  const receipt = existing?.receipts.find(receipt => receipt.requestId === command.requestId);
  if (receipt) { if (receipt.commandDigest !== commandDigest) throw new Error('Source review idempotency conflict.'); return existing!; }
  if ((existing?.generation ?? 0) !== command.expectedGeneration || (existing?.writeHeadEventId ?? null) !== command.expectedHeadEventId) throw new Error('Source review revision conflict.');
  const next = SourceLedgerEnvelopeSchema.parse({ storeKind: 'knowledge-source-ledger-history', schemaVersion: 1, namespace, ledgerId: command.ledgerId,
    generation: command.expectedGeneration + 1, writeHeadEventId: command.requestId, events: [...(existing?.events ?? []), { eventKind: 'analysis', eventId: command.requestId, parentEventId: command.expectedHeadEventId, actor, at, revision: command.revision }],
    receipts: [...(existing?.receipts ?? []), { requestId: command.requestId, commandDigest, committedGeneration: command.expectedGeneration + 1, eventId: command.requestId }] });
  validateSourceLedgerHistory(next); return next;
}
export function applySourceCoverageWrite(existing: SourceCoverageEnvelope | undefined, input: SourceCoverageWrite, actorInput: KnowledgeActor, namespace: string, commandDigest: string, at: string): SourceCoverageEnvelope {
  const command = SourceCoverageWriteSchema.parse(input), actor = SourceReviewActorSchema.parse(actorInput);
  if (existing) { validateSourceCoverageHistory(existing); if (existing.namespace !== namespace || existing.coverageId !== command.coverageId) throw new Error('Source coverage identity conflict.'); }
  const receipt = existing?.receipts.find(receipt => receipt.requestId === command.requestId);
  if (receipt) { if (receipt.commandDigest !== commandDigest) throw new Error('Source review idempotency conflict.'); return existing!; }
  if ((existing?.generation ?? 0) !== command.expectedGeneration || (existing?.writeHeadEventId ?? null) !== command.expectedHeadEventId) throw new Error('Source review revision conflict.');
  const details = command.commandKind === 'append_analysis' ? { eventKind: 'analysis', revision: command.revision }
    : command.commandKind === 'record_decision' ? { eventKind: 'decision', decision: command.decision } : { eventKind: 'revocation', targetEventId: command.targetEventId, reason: command.reason };
  const next = SourceCoverageEnvelopeSchema.parse({ storeKind: 'knowledge-source-coverage-history', schemaVersion: 1, namespace, coverageId: command.coverageId,
    generation: command.expectedGeneration + 1, writeHeadEventId: command.requestId, events: [...(existing?.events ?? []), { ...details, eventId: command.requestId, parentEventId: command.expectedHeadEventId, actor, at }],
    receipts: [...(existing?.receipts ?? []), { requestId: command.requestId, commandDigest, committedGeneration: command.expectedGeneration + 1, eventId: command.requestId }] });
  validateSourceCoverageHistory(next); return next;
}

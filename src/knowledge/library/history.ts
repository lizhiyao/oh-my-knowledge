import { canonicalJson } from '../store.js';
import { LibraryEnvelopeSchema, LibraryWriteSchema, type LibraryEnvelope, type LibraryWrite } from './contracts.js';

export function validateLibraryHistory(history: LibraryEnvelope): void {
  if (history.generation !== history.revisions.length || history.receipts.length !== history.generation
    || history.writeHeadRevisionId !== history.revisions.at(-1)!.revisionId) throw new Error('Invalid library history head.');
  const revisions = new Set<string>(); const requests = new Set<string>();
  for (const [index, revision] of history.revisions.entries()) {
    const receipt = history.receipts[index];
    if (revisions.has(revision.revisionId) || revision.parentRevisionId !== history.revisions[index - 1]?.revisionId
      || requests.has(receipt.requestId) || receipt.committedGeneration !== index + 1 || receipt.revisionId !== revision.revisionId
      || revision.draft.referentKind !== history.revisions[0].draft.referentKind) throw new Error('Invalid library history references.');
    revisions.add(revision.revisionId); requests.add(receipt.requestId);
  }
}
export function applyLibraryWrite(existing: LibraryEnvelope | undefined, input: LibraryWrite, digest: string): LibraryEnvelope {
  const command = LibraryWriteSchema.parse(input);
  if (existing) {
    validateLibraryHistory(existing);
    if (existing.objectId !== command.objectId) throw new Error('Library identity conflict.');
    const receipt = existing.receipts.find(value => value.requestId === command.requestId);
    if (receipt) {
      if (receipt.commandDigest !== digest) throw new Error('Library idempotency conflict.');
      return existing;
    }
  }
  if ((existing?.generation ?? 0) !== command.expectedGeneration
    || (existing?.writeHeadRevisionId ?? null) !== command.expectedHeadRevisionId
    || (command.revision.parentRevisionId ?? null) !== command.expectedHeadRevisionId) throw new Error('Library revision conflict.');
  if (existing && canonicalJson(existing.revisions.at(-1)!.draft) === canonicalJson(command.revision.draft)) throw new Error('Library change required.');
  const next = LibraryEnvelopeSchema.parse({ storeKind: 'knowledge-library-object-history', schemaVersion: 1,
    objectId: command.objectId, generation: command.expectedGeneration + 1, writeHeadRevisionId: command.revision.revisionId,
    revisions: [...(existing?.revisions ?? []), command.revision],
    receipts: [...(existing?.receipts ?? []), { requestId: command.requestId, commandDigest: digest,
      committedGeneration: command.expectedGeneration + 1, revisionId: command.revision.revisionId }],
  });
  validateLibraryHistory(next); return next;
}

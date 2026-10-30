import type { SourceLedgerRevision } from '../source-review.js';
import type { GenerationJournalStore } from '../extraction/generation-journal.js';
import type { SourceReviewGenerationProfile } from '../extraction/source-review-wire.js';
import { generationTextDigest } from '../extraction/body-generation-wire.js';
import { canonicalJson } from '../store.js';

/** The archive store verifies bytes/native binding; this adapter additionally pins the successful exact analysis request. */
export function readSourceReviewOriginal(journals: GenerationJournalStore, original: SourceLedgerRevision['modelOriginal'],
  expected: { profile: SourceReviewGenerationProfile; input: string }): string {
  const journal = journals.read(original.runId), stage = journal?.stages.find(stage => stage.invocationId === original.invocationId);
  const profile = expected.profile;
  if (!journal || !stage || !stage.outcomeRef || !['archived', 'prepared_writes', 'completed'].includes(stage.state)
    || stage.requestDigest !== original.requestDigest || stage.outcomeRef.digest !== original.archiveDigest
    || original.archiveRef !== `generation-journals/outcomes/${journal.runId}/${stage.invocationId}.json`
    || stage.stageKind !== profile.stageKind || stage.profileId !== profile.profileId || stage.wireId !== profile.wireId
    || stage.promptVersion !== profile.promptVersion || stage.system !== profile.system
    || canonicalJson(stage.wireSchema) !== canonicalJson(profile.wireSchema) || stage.input !== expected.input
    || stage.inputDigest !== generationTextDigest(expected.input) || stage.issues.length) {
    throw new Error('Source review native request custody mismatch.');
  }
  const outcome = journals.outcome(journal, stage);
  if (!outcome || outcome.cleanupFailure || outcome.outcomeKind !== 'result' || !outcome.result.ok
    || outcome.result.refusal !== undefined || outcome.result.failure !== undefined
    || Array.isArray(outcome.result.toolCalls) && outcome.result.toolCalls.length > 0
    || typeof outcome.result.output !== 'string' || generationTextDigest(outcome.result.output) !== original.outputDigest) {
    throw new Error('Source review native original did not complete cleanly.');
  }
  return outcome.result.output;
}

import type { ExtractionRun } from './runs.js';
import { canonicalJson } from '../store.js';

interface AdmissionCounts {
  accepted: number; rejected: number; recorded: number; unknownRuns: number; acceptanceRate: number | null;
}
interface LocalizationCounts {
  passed: number; rejected: number; notChecked: number; unknown: number; unknownRuns: number; passRate: number | null;
}
interface QualityGroup {
  identity: Pick<ExtractionRun, 'schemaVersion' | 'promptVersion' | 'promptHash' | 'executor' | 'model'> & {
    policyId: string; policy: ExtractionRun['policy']; outputMode: 'json-schema' | 'prompt-json'; wireId: string | null;
    timeoutMs: number; maxOutputTokens: number | null; producerId: string; producerRevision: string;
  };
  runs: Record<ExtractionRun['status'], number> & { total: number; withAdmission: number; withoutAdmission: number; zeroAccepted: number; zeroKnowledge: number };
  entities: AdmissionCounts; mentions: AdmissionCounts; proposals: AdmissionCounts;
  localization: LocalizationCounts;
  identifierFragmentRejections: number; identifierFragmentRejectionRate: number | null; referenceRejections: number;
  reasons: { component: 'entity' | 'mention' | 'proposal'; reason: string; count: number }[];
}
const admission = (): AdmissionCounts => ({ accepted: 0, rejected: 0, recorded: 0, unknownRuns: 0, acceptanceRate: null });
const quoteRejected = new Set(['invalid_quote_locator', 'unknown_evidence', 'quote_mismatch', 'ambiguous_quote', 'quote_occurrence_out_of_range']);
const quotePassed = new Set(['mention_identifier_fragment', 'duplicate_mention_position', 'unknown_entity']);
const quoteNotChecked = new Set(['invalid_structure', 'duplicate_mention']);
const referenceRejected = new Set([
  'unknown_entity', 'entity_without_mention', 'unknown_possible_entity', 'unresolved_possible_entity',
  'possible_entity_level_mismatch', 'unknown_component', 'invalid_component_target', 'possible_component_mismatch',
  'unknown_collection_member', 'collection_cycle',
  'component:duplicate_mention', 'component:unknown_mention', 'component:missing_entity_mention',
  'collection:duplicate_mention', 'collection:unknown_mention', 'collection:missing_entity_mention',
  'duplicate_entity_reference', 'duplicate_mention_reference', 'unknown_entity_analysis_reference', 'unknown_mention_analysis_reference',
  'unknown_mention_entity', 'unknown_mention_evidence', 'citation_link_mismatch', 'unknown_citation_evidence', 'link_without_citation',
  'citation:unknown_evidence',
]);
const referencePathCodes = ['unknown_entity:', 'unknown_statement:', 'unknown_evidence:', 'uncovered_statement:'];

/** Read saved admission facts only. Never replay today's checker against historical raw output. */
export function extractionQuality(runs: readonly ExtractionRun[]) {
  const groups = new Map<string, QualityGroup>(); const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.runId)) throw new Error('Duplicate extraction run identity.');
    seen.add(run.runId);
    const attempt = run.attempts[0];
    const identity = { schemaVersion: run.schemaVersion, promptVersion: run.promptVersion, promptHash: run.promptHash, executor: run.executor, model: run.model,
      policyId: run.policy.policyId, policy: run.policy, outputMode: attempt.request.outputMode, wireId: attempt.request.wireId ?? null,
      timeoutMs: attempt.request.timeoutMs, maxOutputTokens: attempt.request.maxOutputTokens ?? null,
      producerId: attempt.producer.producerId, producerRevision: attempt.producer.producerRevision };
    const key = canonicalJson(identity);
    let group = groups.get(key);
    if (!group) {
      group = { identity, runs: { total: 0, generating: 0, prepared: 0, completed: 0, failed: 0, cancelled: 0,
        withAdmission: 0, withoutAdmission: 0, zeroAccepted: 0, zeroKnowledge: 0 },
        entities: admission(), mentions: admission(), proposals: admission(),
        localization: { passed: 0, rejected: 0, notChecked: 0, unknown: 0, unknownRuns: 0, passRate: null },
        identifierFragmentRejections: 0, identifierFragmentRejectionRate: null, referenceRejections: 0, reasons: [] };
      groups.set(key, group);
    }
    group.runs.total++; group.runs[run.status]++;
    if (!run.entityAnalysis) {
      group.runs.withoutAdmission++;
      for (const counts of [group.entities, group.mentions, group.proposals, group.localization]) counts.unknownRuns++;
    } else {
      group.runs.withAdmission++;
      const birth = run.entityAnalysis.revision;
      if (!birth.entities.length && !run.intents.length) group.runs.zeroAccepted++;
      if (!run.intents.length) group.runs.zeroKnowledge++;
      group.entities.accepted += birth.entities.length;
      group.mentions.accepted += birth.mentions.length;
      group.proposals.accepted += run.intents.length;
      group.localization.passed += birth.mentions.length;
      if (run.entityRejections === undefined) {
        group.entities.unknownRuns++; group.mentions.unknownRuns++; group.localization.unknownRuns++;
      }
    }
    const rejected = [...(run.entityRejections ?? []), ...run.rejections.map(value => ({ ...value, component: 'proposal' as const }))];
    for (const item of rejected) {
      const counts = item.component === 'entity' ? group.entities : item.component === 'mention' ? group.mentions : group.proposals;
      counts.rejected++;
      if (item.reasons.some(reason => referenceRejected.has(reason) || referencePathCodes.some(prefix => reason.startsWith(prefix)))) group.referenceRejections++;
      if (item.component === 'mention') {
        if (item.reasons.includes('mention_identifier_fragment')) group.identifierFragmentRejections++;
        // These saved reasons identify a reached stage. Unknown/custom reasons stay unknown.
        const category = item.reasons.length && item.reasons.every(reason => quoteRejected.has(reason)) ? 'rejected'
          : item.reasons.length && item.reasons.every(reason => quotePassed.has(reason)) ? 'passed'
            : item.reasons.length && item.reasons.every(reason => quoteNotChecked.has(reason)) ? 'notChecked' : 'unknown';
        group.localization[category]++;
      }
      for (const reason of new Set(item.reasons)) {
        const row = group.reasons.find(value => value.component === item.component && value.reason === reason);
        if (row) row.count++; else group.reasons.push({ component: item.component, reason, count: 1 });
      }
    }
  }
  for (const group of groups.values()) {
    for (const counts of [group.entities, group.mentions, group.proposals]) {
      counts.recorded = counts.accepted + counts.rejected;
      counts.acceptanceRate = counts.recorded && !counts.unknownRuns ? counts.accepted / counts.recorded : null;
    }
    group.identifierFragmentRejectionRate = group.mentions.recorded && !group.mentions.unknownRuns
      ? group.identifierFragmentRejections / group.mentions.recorded : null;
    const checked = group.localization.passed + group.localization.rejected;
    group.localization.passRate = checked && !group.localization.unknownRuns && !group.localization.unknown
      ? group.localization.passed / checked : null;
    group.reasons.sort((a, b) => a.component.localeCompare(b.component) || a.reason.localeCompare(b.reason));
  }
  return { projectionKind: 'knowledge-extraction-quality' as const, projectionVersion: 'omk.extraction-quality/v3' as const,
    runCount: runs.length, groups: [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => group) };
}

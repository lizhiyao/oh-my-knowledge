import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertHistoricalQualityRuntime, captureQualityCases, parseQualityArguments, qualityInput, qualityOutputRoot, type QualityCase } from './knowledge-extraction-quality.js';

const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().trim().min(1);
const exactText = z.string().min(1).refine(value => value.trim().length > 0);
const CorpusSchema = z.strictObject({
  corpusVersion: z.literal('omk-entity-quality/v2'), provenance: text,
  reviewPolicy: z.strictObject({ mentionMatching: text, identity: text, knowledgeRoles: text, interpretation: text, granularity: text }),
  cases: z.array(z.strictObject({
    caseId: key, messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: exactText })).min(1),
    mentions: z.array(z.strictObject({ mentionKey: key, entity: key, messageIndex: z.number().int().nonnegative(), quote: exactText, occurrence: z.number().int().nonnegative() })),
    separate: z.array(z.tuple([key, key])).optional(),
    unresolved: z.array(z.strictObject({ entity: key, possibleEntities: z.array(key) })).optional(),
    roles: z.array(z.strictObject({ subject: key, object: key.nullable(), relationKeywords: z.array(text).min(1) })),
    knowledgeExpected: z.literal('none').optional(), limitations: z.array(text).optional(), checks: z.array(text).min(1),
  })).min(1).max(16),
});
export type EntityQualityCorpus = z.infer<typeof CorpusSchema>;

// Consumer projection only; the current window validator owns structural admission.
type CriticalCheckInput = {
  analysis: { entities: { entityId: string; identityStatus: 'proposed' | 'unresolved'; possibleEntityIds: string[] }[];
    mentions: { entityId: string; selection: { evidenceRef: string; start: number; end: number } }[]; rejected: unknown[] };
  accepted: { draft: { content: { statements: { subject: { entityId: string }; object?: { entityId: string }; relation: string }[] } } }[];
  rejected: unknown[];
};

export function parseEntityQualityArguments(args: string[]) {
  const remaining: string[] = []; let repeat: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--repeat') {
      if (repeat !== undefined || !/^[12]$/.test(args[index + 1] ?? '')) throw new Error('Provide --repeat 1 or 2 once.');
      repeat = Number(args[index + 1]);
    } else remaining.push(args[index], args[index + 1]);
  }
  return { ...parseQualityArguments(remaining), repeat: repeat ?? 1 };
}

/** Frozen source-span and identity checks are evidence, not a general semantic accuracy score. */
export function checkCriticalEntities(sample: EntityQualityCorpus['cases'][number], checked: CriticalCheckInput) {
  const expected = expectedEntityMentions(sample);
  const matches = expected.map(gold => {
    const included = checked.analysis.mentions.filter(mention => mention.selection.evidenceRef === gold.evidenceRef
      && mention.selection.start <= gold.start && mention.selection.end >= gold.end);
    return { mentionKey: gold.mentionKey, entity: gold.entity, exact: included.some(mention => mention.selection.start === gold.start && mention.selection.end === gold.end),
      covered: included.length === 1, entityIds: [...new Set(included.map(mention => mention.entityId))] };
  });
  const groups = [...new Set(expected.map(mention => mention.entity))].map(entity => {
    const members = matches.filter(mention => mention.entity === entity);
    const ids = [...new Set(members.flatMap(mention => mention.entityIds))];
    return { entity, entityId: members.every(mention => mention.covered) && ids.length === 1 ? ids[0] : null };
  });
  const mapped = (entity: string) => groups.find(group => group.entity === entity)?.entityId ?? null;
  const separations = (sample.separate ?? []).map(([left, right]) => ({ left, right,
    passed: !!mapped(left) && !!mapped(right) && mapped(left) !== mapped(right) }));
  const unresolved = (sample.unresolved ?? []).map(gold => {
    const entity = checked.analysis.entities.find(entity => entity.entityId === mapped(gold.entity));
    const possible = gold.possibleEntities.map(mapped);
    return { entity: gold.entity, passed: entity?.identityStatus === 'unresolved' && possible.every(Boolean)
      && [...entity.possibleEntityIds].sort().join('|') === (possible as string[]).sort().join('|') };
  });
  const roles = sample.roles.map(gold => {
    const statements = checked.accepted.flatMap(proposal => proposal.draft.content.statements)
      .filter(statement => gold.relationKeywords.some(keyword => statement.relation.includes(keyword)));
    const passed = statements.some(statement => statement.subject.entityId === mapped(gold.subject)
      && (gold.object ? statement.object?.entityId === mapped(gold.object) : !statement.object));
    // Optional knowledge omission is different from a wrong entity assignment.
    return { ...gold, status: passed ? 'matched' : statements.length ? 'mismatched' : 'not_observed' };
  });
  return { checkVersion: 'omk-entity-critical-checks/v1', criticalMentions: matches, identityGroups: groups,
    separations, unresolved, roles, unexpectedKnowledge: sample.knowledgeExpected === 'none' && !!checked.accepted.length,
    structuralRejections: checked.rejected.length + checked.analysis.rejected.length,
    extraEntitiesNeedReview: checked.analysis.entities.filter(entity => !groups.some(group => group.entityId === entity.entityId)).map(entity => entity.entityId),
    semanticReview: 'pending', independentReview: 'not_performed' };
}

/** UTF-16 spans are frozen before outputs. Broad model quotations still need manual surface review. */
export function expectedEntityMentions(sample: EntityQualityCorpus['cases'][number]) {
  return sample.mentions.map(mention => {
    const source = sample.messages[mention.messageIndex]?.text;
    if (!source) throw new Error('Gold mention references an absent message.');
    let start = -1;
    for (let index = 0; index <= mention.occurrence; index += 1) {
      start = source.indexOf(mention.quote, start + 1);
      if (start < 0) throw new Error('Gold mention does not occur at its selected occurrence.');
    }
    return { ...mention, evidenceRef: `${sample.caseId}:${mention.messageIndex}`, start, end: start + mention.quote.length };
  });
}

export function parseEntityQualityCorpus(raw: string): EntityQualityCorpus {
  const corpus = CorpusSchema.parse(JSON.parse(raw));
  if (new Set(corpus.cases.map(sample => sample.caseId)).size !== corpus.cases.length) throw new Error('Duplicate case identity.');
  for (const sample of corpus.cases) {
    const positions = expectedEntityMentions(sample).map(mention => `${mention.evidenceRef}:${mention.start}:${mention.end}`);
    if (new Set(positions).size !== positions.length) throw new Error('Duplicate critical mention position.');
    if (new Set(sample.mentions.map(mention => mention.mentionKey)).size !== sample.mentions.length) throw new Error('Duplicate critical mention identity.');
    const entities = new Set(sample.mentions.map(mention => mention.entity));
    const referenced = [...(sample.separate ?? []).flat(), ...(sample.unresolved ?? []).flatMap(entry => [entry.entity, ...entry.possibleEntities]),
      ...sample.roles.flatMap(role => [role.subject, ...(role.object ? [role.object] : [])])];
    if (referenced.some(entity => !entities.has(entity))) throw new Error('Gold identity reference is not supported by a critical mention.');
    if (sample.separate?.some(([left, right]) => left === right)) throw new Error('A required separation must concern two different entities.');
    if (sample.unresolved?.some(entry => entry.possibleEntities.includes(entry.entity))) throw new Error('An unresolved identity cannot target itself.');
  }
  return corpus;
}

export function entityQualityCases(corpus: EntityQualityCorpus): QualityCase[] {
  return corpus.cases.map(sample => ({ caseId: sample.caseId, provenance: corpus.provenance, messages: sample.messages, reviewChecks: sample.checks }));
}

/** Only source excerpts and coverage limitations are transmitted, never gold identities or checks. */
export function entityQualityInput(corpus: EntityQualityCorpus, sample: QualityCase) {
  const source = corpus.cases.find(entry => entry.caseId === sample.caseId);
  if (!source) throw new Error('Case is outside the frozen corpus.');
  const input = qualityInput(sample);
  return { ...input, limitations: [...input.limitations, ...(source.limitations ?? [])] };
}

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args = parseEntityQualityArguments(process.argv.slice(2));
  const output = qualityOutputRoot(repo, args.output);
  const corpusText = readFileSync(resolve(repo, 'test/fixtures/entity-extraction-quality.json'), 'utf8');
  const corpus = parseEntityQualityCorpus(corpusText);
  const promptModule = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/prompt.js')).href);
  assertHistoricalQualityRuntime(promptModule.EXTRACTION_PROMPT_VERSION);
  const selected = z.strictObject({ version: z.literal('knowledge-extraction-v3'), prompt: exactText }).parse(args.prompt
    ? JSON.parse(readFileSync(args.prompt, 'utf8')) : { version: promptModule.EXTRACTION_PROMPT_VERSION, prompt: promptModule.EXTRACTION_PROMPT });
  const { configuredExtractionModel } = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/adapters/executor.js')).href);
  const { checkWindowExtractionResponse } = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/window-proposals.js')).href);
  const model = configuredExtractionModel('codex', args.model);
  const cases = entityQualityCases(corpus);
  mkdirSync(output); // A second invocation cannot overwrite or silently retry this run.
  const manifest = { promptVersion: selected.version, promptHash: digest(selected.prompt), corpusDigest: digest(corpusText),
    executor: 'codex', model: model.model, startedAt: new Date().toISOString(), caseCount: cases.length,
    independentReview: 'not_performed', semanticReview: 'pending', repeat: args.repeat, maxCalls: cases.length * args.repeat, retries: 0,
    usdCost: 'Unknown unless actually reported by executor.', applicability: corpus.provenance };
  writeFileSync(resolve(output, 'prompt.json'), JSON.stringify(selected, null, 2));
  writeFileSync(resolve(output, 'corpus.json'), corpusText);
  writeFileSync(resolve(output, 'expected-mentions.json'), JSON.stringify(corpus.cases.map(sample => ({ caseId: sample.caseId, mentions: expectedEntityMentions(sample) })), null, 2));
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ ...manifest, status: 'running' }, null, 2));
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = { failed: false, aborted: false, attempted: 0 };
    const criticalChecks: { repeat: number; caseId: string; checks: ReturnType<typeof checkCriticalEntities> | null }[] = [];
    for (let repeat = 1; repeat <= args.repeat && !controller.signal.aborted; repeat += 1) {
      const directory = resolve(output, `repeat-${repeat}`); mkdirSync(directory);
      const capture = await captureQualityCases({ cases, output: directory, prompt: selected.prompt, signal: controller.signal,
        input: sample => entityQualityInput(corpus, sample), check: checkWindowExtractionResponse,
        generate: (prompt, input, signal) => model.generate(prompt, input, signal) });
      result.failed ||= capture.failed; result.aborted ||= capture.aborted; result.attempted += capture.attempted;
      for (const sample of corpus.cases.slice(0, capture.attempted)) {
        const record = JSON.parse(readFileSync(resolve(directory, `${sample.caseId}.json`), 'utf8'));
        criticalChecks.push({ repeat, caseId: sample.caseId, checks: record.checked ? checkCriticalEntities(sample, record.checked) : null });
      }
      writeFileSync(resolve(output, 'critical-checks.json'), JSON.stringify(criticalChecks, null, 2));
    }
    result.aborted ||= controller.signal.aborted;
    const captureFailures = criticalChecks.filter(record => !record.checks).length;
    const structuralRejections = criticalChecks.reduce((total, record) => total + (record.checks?.structuralRejections ?? 0), 0);
    writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ ...manifest, ...result,
      captureFailures, structuralRejections, status: result.aborted ? 'cancelled' : result.failed ? 'capture_failures' : 'captured', finishedAt: new Date().toISOString() }, null, 2));
    if (result.aborted || result.failed) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  console.log(`Evidence: ${output}. Structural results are separate from semantic and independent review.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

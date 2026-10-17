import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { annotationReadiness, authorReviewStatus, reviewReceiptStatus, reviewBuiltDigest, reviewDigest, reviewOutputRoot } from './entity-extraction-review.js';
import { ENTITY_LINK_CHECK_VERSION, ENTITY_LINK_CORPUS_VERSION, ENTITY_LINK_GUIDE_VERSION,
  entityLinkReviewInput, parseEntityLinkReviewCorpus, type EntityLinkReviewCorpus, type EntityLinkReviewInput } from './entity-link-review-corpus.js';

/** Same UTF-16 key ordering as the production canonical-json-v1 contract. */
export const canonicalLinkReview = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalLinkReview).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalLinkReview((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const bytesDigest = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
interface Suggestion { assessment: 'same_object' | 'different_objects' | 'insufficient_evidence'; rationale: string }
export interface EntityLinkReviewRuntime {
  validateInput(value: unknown): EntityLinkReviewInput;
  parseSuggestion(value: unknown): Suggestion;
  admitSuggestion(value: unknown, input: EntityLinkReviewInput): Suggestion;
  prompt: string; promptVersion: string; promptHash: string; responseSchema: unknown; responseSchemaHash: string;
}
/** Corpus/request data cannot select imported code. */
export async function loadEntityLinkReviewRuntime(repository: string): Promise<EntityLinkReviewRuntime> {
  const load = (path: string) => import(pathToFileURL(resolve(repository, 'dist', path)).href);
  const [input, link, prompt] = await Promise.all([load('knowledge/entities/link-invocation.js'), load('knowledge/entities/links.js'),
    load('observability/knowledge-extraction/linking/entity-link-prompt.js')]);
  return { validateInput: (value: unknown) => input.EntityLinkModelInputSchema.parse(value),
    parseSuggestion: (value: unknown) => link.EntityLinkSuggestionSchema.parse(value),
    admitSuggestion: (value: unknown, selected: EntityLinkReviewInput) => link.checkEntityLinkSuggestion(value, {
      left: selected.left.binding, right: selected.right.binding }),
    prompt: prompt.ENTITY_LINK_PROMPT, promptVersion: prompt.ENTITY_LINK_PROMPT_VERSION, promptHash: prompt.ENTITY_LINK_PROMPT_HASH,
    responseSchema: prompt.ENTITY_LINK_RESPONSE_JSON_SCHEMA, responseSchemaHash: prompt.ENTITY_LINK_RESPONSE_SCHEMA_HASH };
}

export function entityLinkReviewHostIdentity(repository: string) {
  const here = dirname(fileURLToPath(import.meta.url)), extension = extname(fileURLToPath(import.meta.url));
  const names = ['entity-link-review', 'entity-link-review-corpus', 'entity-extraction-review', 'entity-review-corpus', 'entity-review-checks'];
  const require = createRequire(import.meta.url); const zodRoot = dirname(require.resolve('zod/package.json'));
  const validatorVersion = JSON.parse(readFileSync(resolve(zodRoot, 'package.json'), 'utf8')).version as string;
  const validatorDigest = reviewBuiltDigest(zodRoot);
  const runtimeRequire = createRequire(realpathSync(resolve(repository, 'dist/knowledge/entities/link-invocation.js')));
  const runtimeZodRoot = dirname(runtimeRequire.resolve('zod/package.json'));
  if (JSON.parse(readFileSync(resolve(runtimeZodRoot, 'package.json'), 'utf8')).version !== validatorVersion
    || reviewBuiltDigest(runtimeZodRoot) !== validatorDigest) throw new Error('Production and checker validators differ; freeze matching installed validators.');
  return { runtimeDigest: reviewBuiltDigest(resolve(repository, 'dist')),
    checkerDigest: reviewDigest(names.map(name => readFileSync(resolve(here, name + extension), 'utf8')).join('\0')),
    dependencyDigest: reviewDigest(['package.json', 'yarn.lock'].map(name => readFileSync(resolve(repository, name), 'utf8')).join('\0')),
    validatorVersion, validatorDigest, nodeVersion: process.versions.node, nodeBinaryDigest: bytesDigest(readFileSync(process.execPath)) };
}

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const EntityLinkMeasurementIdentitySchema = z.strictObject({
  measurementVersion: z.literal('omk-entity-link-measurement/v1'),
  corpusVersion: z.literal(ENTITY_LINK_CORPUS_VERSION), guideVersion: z.literal(ENTITY_LINK_GUIDE_VERSION), checkVersion: z.literal(ENTITY_LINK_CHECK_VERSION),
  corpusDigest: digest, guideDigest: digest, runtimeDigest: digest, checkerDigest: digest, dependencyDigest: digest,
  validatorVersion: text, validatorDigest: digest, nodeVersion: text, nodeBinaryDigest: digest,
  promptVersion: text, promptHash: digest, responseSchemaHash: digest,
});
export const EntityLinkCaptureSchema = z.strictObject({
  captureVersion: z.literal('omk-entity-link-captures/v1'), measurementId: digest,
  split: z.enum(['development', 'validation']), repeats: z.union([z.literal(1), z.literal(2)]),
  startedAt: z.iso.datetime({ offset: true }), executor: text, model: text,
  records: z.array(z.strictObject({ caseId: text, repeat: z.union([z.literal(1), z.literal(2)]), inputDigest: digest,
    result: z.discriminatedUnion('captureStatus', [
      z.strictObject({ captureStatus: z.literal('output'), output: z.string(), usage: z.unknown().optional(),
        durationMs: z.number().finite().nonnegative().optional(), costUSD: z.number().finite().nonnegative().optional() }),
      z.strictObject({ captureStatus: z.enum(['call_failure', 'cancelled']), failure: text,
        durationMs: z.number().finite().nonnegative().optional(), costUSD: z.number().finite().nonnegative().optional() }),
    ]),
  })),
});

/** The machine checks structure, selected evidence and agreement with authored references, never semantic truth. */
export function reviewEntityLinkCapture(raw: string, corpus: EntityLinkReviewCorpus, measurementId: string, runtime: EntityLinkReviewRuntime) {
  const capture = EntityLinkCaptureSchema.parse(JSON.parse(raw));
  if (capture.measurementId !== measurementId || Date.parse(capture.startedAt) > Date.now()) throw new Error('Capture identity/time mismatch.');
  const selected = corpus.cases.filter(sample => sample.split === capture.split);
  const byId = new Map(selected.map(sample => [sample.caseId, sample])); const seen = new Set<string>();
  const records = capture.records.map(record => {
    const sample = byId.get(record.caseId); const key = `${record.caseId}:${record.repeat}`;
    if (!sample || seen.has(key) || record.repeat > capture.repeats
      || record.inputDigest !== reviewDigest(canonicalLinkReview(entityLinkReviewInput(sample)))) throw new Error('Unknown/duplicate/unplanned case or input bytes changed.');
    seen.add(key);
    if (record.result.captureStatus !== 'output') return { caseId: sample.caseId, repeat: record.repeat, checkStatus: record.result.captureStatus,
      failure: record.result.failure, rationaleReview: 'pending' as const };
    let value: unknown;
    try { value = JSON.parse(record.result.output); } catch { return { caseId: sample.caseId, repeat: record.repeat, checkStatus: 'parse_failure', rationaleReview: 'pending' as const }; }
    try { runtime.parseSuggestion(value); } catch { return { caseId: sample.caseId, repeat: record.repeat, checkStatus: 'schema_rejection', rationaleReview: 'pending' as const }; }
    let suggestion: Suggestion;
    try { suggestion = runtime.admitSuggestion(value, sample.input); } catch { return { caseId: sample.caseId, repeat: record.repeat, checkStatus: 'binding_rejection', rationaleReview: 'pending' as const }; }
    return { caseId: sample.caseId, repeat: record.repeat, checkStatus: 'admitted', assessment: suggestion.assessment,
      authorReference: sample.expectedAssessment, agreesWithAuthorReference: suggestion.assessment === sample.expectedAssessment,
      rationale: suggestion.rationale, rationaleReview: 'pending' as const };
  });
  const unattempted = selected.flatMap(sample => Array.from({ length: capture.repeats }, (_, index) => index + 1)
    .filter(repeat => !seen.has(`${sample.caseId}:${repeat}`)).map(repeat => ({ caseId: sample.caseId, repeat })));
  const count = (status: string) => records.filter(record => record.checkStatus === status).length;
  const outputCount = capture.records.filter(record => record.result.captureStatus === 'output').length;
  const costs = capture.records.flatMap(record => record.result.costUSD === undefined ? [] : [record.result.costUSD]);
  const compared = records.filter(record => record.checkStatus === 'admitted');
  return { capture, records, unattempted, summary: {
    planned: selected.length * capture.repeats, recorded: records.length, unattempted: unattempted.length,
    outputCount, callFailures: count('call_failure'), cancelled: count('cancelled'), parseFailures: count('parse_failure'),
    schemaRejections: count('schema_rejection'), bindingRejections: count('binding_rejection'), admitted: compared.length,
    authorReferenceCompared: compared.length, authorReferenceMatches: compared.filter(record => record.agreesWithAuthorReference).length,
    parseFailureRate: outputCount ? count('parse_failure') / outputCount : null,
    structureRejectionRate: outputCount - count('parse_failure') ? count('schema_rejection') / (outputCount - count('parse_failure')) : null,
    costReportingRecords: costs.length, reportedCostUSD: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    totalCostUSD: records.length && !unattempted.length && costs.length === records.length ? costs.reduce((a, b) => a + b, 0) : null,
    semanticReview: 'pending' as const, qualityConclusion: 'not_evaluated' as const,
    coverage: 'Public synthetic authored references; agreement is not independent semantic accuracy or population performance.',
  } };
}

interface PrepareOptions { repository: string; corpus: string; output: string; selfReview?: string; review?: string; captures?: string }
/** Creates a fresh external immutable bundle; no executor is imported or called. */
export async function prepareEntityLinkReview(options: PrepareOptions) {
  const repository = resolve(options.repository); const output = reviewOutputRoot(repository, options.output);
  const runtime = await loadEntityLinkReviewRuntime(repository); const corpusText = readFileSync(options.corpus, 'utf8');
  const corpus = parseEntityLinkReviewCorpus(corpusText, runtime.validateInput);
  if (runtime.promptHash !== reviewDigest(runtime.prompt) || runtime.responseSchemaHash !== reviewDigest(canonicalLinkReview(runtime.responseSchema))) throw new Error('Built prompt/schema identity mismatch.');
  const guides = ['docs/specs/entities/entity-link-evaluation.md', 'docs/zh/specs/entities/entity-link-evaluation.md']
    .map(path => readFileSync(resolve(repository, path), 'utf8'));
  const identity = EntityLinkMeasurementIdentitySchema.parse({ measurementVersion: 'omk-entity-link-measurement/v1', corpusVersion: ENTITY_LINK_CORPUS_VERSION,
    guideVersion: ENTITY_LINK_GUIDE_VERSION, checkVersion: ENTITY_LINK_CHECK_VERSION,
    corpusDigest: reviewDigest(corpusText), guideDigest: reviewDigest(guides.join('\0')),
    ...entityLinkReviewHostIdentity(repository), promptVersion: runtime.promptVersion, promptHash: runtime.promptHash,
    responseSchemaHash: runtime.responseSchemaHash });
  const measurementId = reviewDigest(canonicalLinkReview(identity));
  const captureText = options.captures ? readFileSync(options.captures, 'utf8') : undefined;
  const result = captureText === undefined ? null : reviewEntityLinkCapture(captureText, corpus, measurementId, runtime);
  const author = authorReviewStatus(options.selfReview ? readFileSync(options.selfReview, 'utf8') : undefined, corpus, measurementId, result?.capture.startedAt);
  const review = reviewReceiptStatus(options.review ? readFileSync(options.review, 'utf8') : undefined, corpus, measurementId, result?.capture.startedAt);
  const readiness = annotationReadiness(author.status, review.status);
  const manifest = { ...identity, measurementId, createdAt: new Date().toISOString(), authorReview: author.status,
    independentHumanReview: review.status, ...readiness, modelCallsByThisCommand: 0,
    semanticReview: 'pending', qualityConclusion: 'not_evaluated', captureSummary: result?.summary ?? null,
    splitCounts: { development: corpus.cases.filter(sample => sample.split === 'development').length,
      validation: corpus.cases.filter(sample => sample.split === 'validation').length } };
  mkdirSync(output, { mode: 0o700 }); mkdirSync(resolve(output, 'inputs'), { mode: 0o700 });
  const publish = (name: string, bytes: string) => writeFileSync(resolve(output, name), bytes, { flag: 'wx', mode: 0o600 });
  const save = (name: string, value: unknown) => publish(name, JSON.stringify(value, null, 2) + '\n');
  save('manifest.json', manifest); publish('corpus.json', corpusText); publish('system.prompt.txt', runtime.prompt);
  publish('response-schema.json', canonicalLinkReview(runtime.responseSchema));
  publish('annotation-guide.en.md', guides[0]); publish('annotation-guide.zh.md', guides[1]);
  for (const sample of corpus.cases) publish(`inputs/${sample.caseId}.json`, canonicalLinkReview(entityLinkReviewInput(sample)));
  const decisions = corpus.cases.map(sample => ({ caseId: sample.caseId, decision: 'changes_requested', rationale: 'Pending review before outputs.' }));
  save('author-review-template.json', { selfReviewVersion: 'omk-entity-author-review/v1', measurementId, reviewer: '', reviewedAt: '', reviewedBeforeOutputs: true, decisions });
  save('review-template.json', { reviewVersion: 'omk-entity-annotation-review/v1', measurementId, reviewer: '', reviewedAt: '',
    reviewKind: 'independent-human', reviewedBeforeOutputs: true, independenceAttestation: false, decisions, disputes: [] });
  if (author.receipt) save('self-review.json', author.receipt);
  if (review.receipt) save('review.json', review.receipt);
  if (result) { publish('captures.json', captureText!); save('checks.json', result.records); save('unattempted.json', result.unattempted); }
  return { manifest, result };
}

async function main() {
  const args = process.argv.slice(2); const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--repository', '--corpus', '--output', '--self-review', '--review', '--captures'].includes(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('Expected unique named path pairs.');
    values.set(name, value);
  }
  if (!values.has('--corpus') || !values.has('--output')) throw new Error('Provide --corpus and external --output.');
  const result = await prepareEntityLinkReview({ repository: values.get('--repository') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    corpus: values.get('--corpus')!, output: values.get('--output')!, selfReview: values.get('--self-review'), review: values.get('--review'), captures: values.get('--captures') });
  console.log(JSON.stringify(result.manifest, null, 2));
  if (result.result && (result.result.unattempted.length || result.result.records.some(record => record.checkStatus !== 'admitted'))) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

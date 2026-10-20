import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ENTITY_CHECK_VERSION, ENTITY_GUIDE_VERSION, parseEntityReviewCorpus } from './entity-review-corpus.js';
import { authorReviewStatus, reviewBuiltDigest, reviewCapture, reviewDigest, reviewOutputRoot, reviewReceiptStatus } from './entity-extraction-review.js';
import type { EntityReviewAdmission } from './entity-review-checks.js';
import { evaluateSemanticReview, createSemanticPlan, createSemanticReviewTemplate, parseSemanticPlan, semanticReviewTargets } from './entity-semantic-checks.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Preserve the original measurement's field order and identity algorithm.
const Identity = z.object({
  corpusVersion: z.literal('omk-entity-quality/v13'), checkVersion: z.literal(ENTITY_CHECK_VERSION), guideVersion: z.literal(ENTITY_GUIDE_VERSION),
  corpusDigest: digest, guideDigest: digest, checkerDigest: digest, runtimeDigest: digest, dependencyDigest: digest,
  nodeVersion: z.string(), promptVersion: z.string(), promptHash: digest, promptHashEncoding: z.literal('raw-utf8'), responseSchemaVersion: z.literal(4),
});
function readText(path: string) {
  const bytes = readFileSync(path), text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Evidence must be valid raw UTF-8.');
  return text;
}
const optionalText = (path: string) => existsSync(path) ? readText(path) : undefined;

/** Verify the original bundle; never trust its reported ready flags or stored checks. */
export async function loadSemanticBundle(repository: string, directory: string) {
  const manifest = JSON.parse(readText(resolve(directory, 'manifest.json')));
  const identity = Identity.parse(manifest);
  const measurementId = digest.parse(manifest.measurementId);
  if (reviewDigest(JSON.stringify(identity)) !== measurementId) throw new Error('Review measurement identity mismatch.');
  const corpusText = readText(resolve(directory, 'corpus.json')), corpus = parseEntityReviewCorpus(corpusText);
  const guides = ['annotation-guide.en.md', 'annotation-guide.zh.md'].map(name => readText(resolve(directory, name)));
  const currentGuides = ['docs/specs/entities/entity-extraction-evaluation.md', 'docs/zh/specs/entities/entity-extraction-evaluation.md']
    .map(name => readText(resolve(repository, name)));
  const tools = ['entity-extraction-review.js', 'entity-review-corpus.js', 'entity-review-checks.js', 'entity-measurement-runtime.js']
    .map(name => readText(resolve(repository, 'dist-scripts/bench', name)));
  if (identity.corpusDigest !== reviewDigest(corpusText) || identity.guideDigest !== reviewDigest(guides.join('\0'))
    || guides.some((guide, index) => guide !== currentGuides[index]) || identity.checkerDigest !== reviewDigest(tools.join('\0'))
    || identity.runtimeDigest !== reviewBuiltDigest(resolve(repository, 'dist'))
    || identity.dependencyDigest !== reviewDigest(['package.json', 'yarn.lock'].map(name => readText(resolve(repository, name))).join('\0'))
    || identity.nodeVersion !== process.versions.node) throw new Error('Frozen corpus, guide, checker, runtime or environment differs; use the original build.');
  // The paths are fixed by this program, never supplied by a bundle or capture.
  const prompt = await import(pathToFileURL(resolve(repository, 'dist/knowledge/extraction/prompt.js')).href);
  const production = await import(pathToFileURL(resolve(repository, 'dist/knowledge/extraction/window-proposals.js')).href);
  if (identity.promptVersion !== prompt.EXTRACTION_PROMPT_VERSION || identity.promptHash !== reviewDigest(prompt.EXTRACTION_PROMPT)) {
    throw new Error('Frozen prompt identity mismatch.');
  }
  return { corpus, corpusText, measurementId,
    authorReceipt: optionalText(resolve(directory, 'self-review.json')), independentReceipt: optionalText(resolve(directory, 'review.json')),
    admit: production.checkWindowExtractionResponse as (response: unknown, excerpts: readonly { evidenceRef: string; text: string }[]) => EntityReviewAdmission };
}

export function parseSemanticArguments(args: string[]) {
  const command = args[0];
  if (command !== 'prepare' && command !== 'review') throw new Error('Use prepare or review.');
  const allowed = command === 'prepare' ? ['--bundle', '--policy', '--split', '--repeats', '--output']
    : ['--bundle', '--plan', '--captures', '--receipt', '--output'];
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!allowed.includes(name) || values.has(name) || !value?.trim() || value.startsWith('--')) throw new Error('Expected unique, supported flag/value pairs.');
    values.set(name, value);
  }
  for (const name of allowed.filter(name => name !== '--receipt')) if (!values.has(name)) throw new Error(`Missing ${name}.`);
  if (command === 'prepare' && (!['development', 'validation'].includes(values.get('--split')!) || !['1', '2'].includes(values.get('--repeats')!))) {
    throw new Error('Use development/validation and 1/2 repeats as supported by captures v1.');
  }
  return { command, values };
}

export async function runSemanticCommand(repository: string, args: string[], now = new Date().toISOString()) {
  const { command, values } = parseSemanticArguments(args);
  const directory = resolve(values.get('--bundle')!), output = reviewOutputRoot(repository, values.get('--output')!);
  if (existsSync(output)) throw new Error('Output already exists; preserve prior evidence.');
  const bundle = await loadSemanticBundle(repository, directory);
  const saveFiles = (files: Record<string, string>) => {
    mkdirSync(output, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(resolve(output, name), bytes, { flag: 'wx', mode: 0o600 });
  };
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  if (command === 'prepare') {
    if (existsSync(resolve(directory, 'captures.json'))) throw new Error('Cannot declare a new semantic plan on a bundle containing outputs.');
    const policy = JSON.parse(readText(resolve(values.get('--policy')!)));
    const split = values.get('--split')! as 'development' | 'validation';
    const plan = createSemanticPlan({ measurementId: bundle.measurementId, declaredAt: now,
      split, repeats: Number(values.get('--repeats')) as 1 | 2, caseIds: bundle.corpus.cases.filter(sample => sample.split === split).map(sample => sample.caseId), criteria: policy });
    saveFiles({ 'plan.json': json(plan) });
    return { output, status: 'prepared', modelCallsByThisCommand: 0, exitCode: 0 };
  }
  const planText = readText(resolve(values.get('--plan')!)), plan = parseSemanticPlan(JSON.parse(planText));
  const captureText = readText(resolve(values.get('--captures')!));
  const captured = reviewCapture(captureText, bundle.corpus, bundle.measurementId, bundle.admit);
  const author = authorReviewStatus(bundle.authorReceipt, bundle.corpus, bundle.measurementId, captured.capture.startedAt);
  const independent = reviewReceiptStatus(bundle.independentReceipt, bundle.corpus, bundle.measurementId, captured.capture.startedAt);
  const context = { corpus: bundle.corpus, measurementId: bundle.measurementId, capturesDigest: reviewDigest(captureText), capture: captured,
    authorReview: author.status, annotationReview: independent.status, now };
  const receiptText = values.has('--receipt') ? readText(resolve(values.get('--receipt')!)) : undefined;
  const report = evaluateSemanticReview({ ...context, plan, receipt: receiptText === undefined ? undefined : JSON.parse(receiptText) });
  const toolDigest = reviewDigest(['entity-semantic-review.js', 'entity-semantic-checks.js']
    .map(name => readText(resolve(repository, 'dist-scripts/bench', name))).join('\0'));
  const analysis = { ...report, toolDigest, modelCallsByThisCommand: 0, captureSummary: captured.summary,
    outputReviewDigest: receiptText === undefined ? null : reviewDigest(receiptText),
    referenceReceiptDigests: { author: bundle.authorReceipt === undefined ? null : reviewDigest(bundle.authorReceipt),
      independent: bundle.independentReceipt === undefined ? null : reviewDigest(bundle.independentReceipt) } };
  saveFiles({ 'plan.json': planText, 'captures.json': captureText, 'corpus.json': bundle.corpusText,
    'review-targets.json': json(semanticReviewTargets(context)), 'review-template.json': json(createSemanticReviewTemplate({ ...context, plan })),
    'report.json': json({ ...analysis, reportId: reviewDigest(JSON.stringify(analysis)) }),
    ...(bundle.authorReceipt === undefined ? {} : { 'reference-self-review.json': bundle.authorReceipt }),
    ...(bundle.independentReceipt === undefined ? {} : { 'reference-review.json': bundle.independentReceipt }),
    ...(receiptText === undefined ? {} : { 'output-review.json': receiptText }) });
  return { output, status: report.status, modelCallsByThisCommand: 0, exitCode: report.status === 'accepted_within_scope' ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  runSemanticCommand(repository, process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
  }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

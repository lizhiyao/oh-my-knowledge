import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { qualityOutputRoot } from './knowledge-extraction-quality.js';
import { ENTITY_CHECK_VERSION, ENTITY_GUIDE_VERSION, entityReviewInput, parseEntityReviewCorpus, reviewMentions, type EntityReviewCorpus } from './entity-review-corpus.js';
import { reviewCapturedOutput, type EntityReviewAdmission } from './entity-review-checks.js';

export const reviewDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const isoTime = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1);
const CaptureSchema = z.strictObject({
  captureVersion: z.literal('omk-entity-captures/v1'), measurementId: digest,
  split: z.enum(['development', 'validation']), repeats: z.union([z.literal(1), z.literal(2)]), startedAt: isoTime,
  executor: text, model: text,
  records: z.array(z.strictObject({
    caseId: text, repeat: z.union([z.literal(1), z.literal(2)]), inputDigest: digest,
    result: z.discriminatedUnion('captureStatus', [
      z.strictObject({ captureStatus: z.literal('output'), output: z.string(), usage: z.unknown().optional(),
        durationMs: z.number().nonnegative().optional(), costUSD: z.number().nonnegative().optional() }),
      z.strictObject({ captureStatus: z.enum(['call_failure', 'cancelled']), failure: text,
        durationMs: z.number().nonnegative().optional(), costUSD: z.number().nonnegative().optional() }),
    ]),
  })),
});
const ReceiptSchema = z.strictObject({
  reviewVersion: z.literal('omk-entity-annotation-review/v1'), measurementId: digest,
  reviewer: text, reviewedAt: isoTime,
  reviewKind: z.literal('independent-human'), reviewedBeforeOutputs: z.literal(true),
  independenceAttestation: z.literal(true),
  decisions: z.array(z.strictObject({ caseId: text, decision: z.enum(['approved', 'changes_requested']), rationale: text })),
  disputes: z.array(z.strictObject({ caseId: text, question: text, resolution: text, adjudicator: text })),
});
const AuthorReviewSchema = z.strictObject({
  selfReviewVersion: z.literal('omk-entity-author-review/v1'), measurementId: digest,
  reviewer: text, reviewedAt: isoTime, reviewedBeforeOutputs: z.literal(true),
  decisions: z.array(z.strictObject({ caseId: text, decision: z.enum(['approved', 'changes_requested']), rationale: text })),
});

function validateReview(record: z.infer<typeof AuthorReviewSchema> | z.infer<typeof ReceiptSchema>,
  corpus: EntityReviewCorpus, measurementId: string, outputsStartedAt?: string) {
  if (record.measurementId !== measurementId) throw new Error('Review receipt is for a different measurement identity.');
  if (new Date(record.reviewedAt).getTime() > Date.now()) throw new Error('Review time is in the future.');
  if (outputsStartedAt && new Date(record.reviewedAt).getTime() > new Date(outputsStartedAt).getTime()) throw new Error('Gold review must precede output capture.');
  const cases = new Set(corpus.cases.map(sample => sample.caseId));
  if (record.decisions.length !== cases.size || new Set(record.decisions.map(value => value.caseId)).size !== cases.size
    || record.decisions.some(value => !cases.has(value.caseId))) throw new Error('Review must cover every case exactly once.');
}

export function authorReviewStatus(raw: string | undefined, corpus: EntityReviewCorpus, measurementId: string, outputsStartedAt?: string) {
  if (raw === undefined) return { status: 'pending' as const, receipt: null };
  const receipt = AuthorReviewSchema.parse(JSON.parse(raw));
  validateReview(receipt, corpus, measurementId, outputsStartedAt);
  if (!corpus.authors.some(author => author.toLowerCase() === receipt.reviewer.toLowerCase())) throw new Error('Author review needs a corpus author.');
  return { status: receipt.decisions.some(value => value.decision === 'changes_requested') ? 'changes_requested' as const : 'completed' as const, receipt };
}

export function reviewReceiptStatus(raw: string | undefined, corpus: EntityReviewCorpus, measurementId: string, outputsStartedAt?: string) {
  if (raw === undefined) return { status: 'pending' as const, receipt: null };
  const receipt = ReceiptSchema.parse(JSON.parse(raw));
  validateReview(receipt, corpus, measurementId, outputsStartedAt);
  if (corpus.authors.some(author => author.toLowerCase() === receipt.reviewer.toLowerCase())) throw new Error('Corpus author cannot attest independent review.');
  const cases = new Set(corpus.cases.map(sample => sample.caseId));
  if (receipt.disputes.some(value => !cases.has(value.caseId))) throw new Error('Review dispute references an unknown case.');
  if (receipt.disputes.some(value => corpus.authors.some(author => author.toLowerCase() === value.adjudicator.toLowerCase()))) throw new Error('Dispute adjudication needs an independent reviewer.');
  return { status: receipt.decisions.some(value => value.decision === 'changes_requested') ? 'changes_requested' as const : 'attested_independent_human' as const, receipt };
}

export function annotationReadiness(author: ReturnType<typeof authorReviewStatus>['status'], independent: ReturnType<typeof reviewReceiptStatus>['status']) {
  const blocked = author === 'changes_requested' || independent === 'changes_requested';
  return { goldReady: !blocked && independent === 'attested_independent_human',
    exploratoryReady: !blocked && (author === 'completed' || independent === 'attested_independent_human') };
}

export function reviewCapture(raw: string, corpus: EntityReviewCorpus, measurementId: string,
  admit: (response: unknown, excerpts: ReturnType<typeof entityReviewInput>['excerpts']) => EntityReviewAdmission) {
  const capture = CaptureSchema.parse(JSON.parse(raw));
  if (capture.measurementId !== measurementId) throw new Error('Capture is for a different measurement identity.');
  const cases = corpus.cases.filter(sample => sample.split === capture.split);
  const byId = new Map(cases.map(sample => [sample.caseId, sample]));
  const seen = new Set<string>();
  const records = capture.records.map(record => {
    const sample = byId.get(record.caseId);
    const key = `${record.caseId}:${record.repeat}`;
    if (!sample || seen.has(key) || record.repeat > capture.repeats) throw new Error('Unknown, duplicate or out-of-plan capture.');
    seen.add(key);
    const input = entityReviewInput(sample);
    if (record.inputDigest !== reviewDigest(JSON.stringify(input))) throw new Error('Captured input differs from frozen source input.');
    const result = record.result.captureStatus === 'output' ? reviewCapturedOutput(sample, record.result.output, response => admit(response, input.excerpts))
      : { captureStatus: record.result.captureStatus, failure: record.result.failure, structuralRejections: [], checks: null };
    return { caseId: record.caseId, repeat: record.repeat, ...result };
  });
  const unattempted = cases.flatMap(sample => Array.from({ length: capture.repeats }, (_, index) => ({ caseId: sample.caseId, repeat: index + 1 }))
    .filter(record => !seen.has(`${record.caseId}:${record.repeat}`)));
  const notAttempted = unattempted.length;
  const count = (status: string) => records.filter(record => record.captureStatus === status).length;
  const callFailures = count('call_failure'); const parseFailures = count('parse_failure'); const cancellations = count('cancelled');
  const costs = capture.records.flatMap(record => record.result.costUSD === undefined ? [] : [record.result.costUSD]);
  const durations = capture.records.flatMap(record => record.result.durationMs === undefined ? [] : [record.result.durationMs]);
  const checkedCriticalMentions = records.reduce((sum, record) => sum + (record.checks?.criticalMentions.length ?? 0), 0);
  const plannedCriticalMentions = cases.reduce((sum, sample) => sum + sample.mentions.length * capture.repeats, 0);
  return { capture, records, unattempted, summary: {
    planned: cases.length * capture.repeats, recorded: records.length, notAttempted,
    callFailures, parseFailures, cancellations, captured: count('captured'),
    captureStatus: cancellations ? 'cancelled' : callFailures || parseFailures ? 'capture_failures' : notAttempted ? 'incomplete' : 'captured',
    structuralRejectingOutputs: records.filter(record => record.structuralRejections.length).length,
    rejectedItems: records.reduce((sum, record) => sum + record.structuralRejections.length, 0),
    checkedCriticalMentions, plannedCriticalMentions, uncheckedCriticalMentions: plannedCriticalMentions - checkedCriticalMentions,
    missingCriticalMentions: records.reduce((sum, record) => sum + (record.checks?.criticalMentions.filter(value => value.status !== 'matched').length ?? 0), 0),
    wrongMerges: records.reduce((sum, record) => sum + (record.checks?.identityPairs.filter(value => value.status === 'wrong_merge').length ?? 0), 0),
    wrongSplits: records.reduce((sum, record) => sum + (record.checks?.identityPairs.filter(value => value.status === 'wrong_split').length ?? 0), 0),
    notEvaluableIdentityPairs: records.reduce((sum, record) => sum + (record.checks?.identityPairs.filter(value => value.status === 'not_evaluable').length ?? 0), 0),
    identityMismatches: records.reduce((sum, record) => sum + (record.checks?.identities.filter(value => value.status === 'mismatched').length ?? 0), 0),
    semanticReview: 'pending',
    usdCost: costs.length && costs.length === records.length ? costs.reduce((sum, cost) => sum + cost, 0) : 'unknown',
    reportedCostUSD: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null, costReportingRecords: costs.length,
    reportedDurationMs: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) : null, durationReportingRecords: durations.length,
  } };
}

export function parseEntityReviewArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!['--corpus', '--output', '--captures', '--review', '--self-review'].includes(name) || values.has(name) || !value?.trim() || value.startsWith('--')) throw new Error('Expected unique --corpus, --output and optional --captures / --review / --self-review pairs.');
    values.set(name, value);
  }
  if (!values.has('--corpus') || !values.has('--output')) throw new Error('Provide --corpus and external --output explicitly.');
  return { corpus: values.get('--corpus')!, output: values.get('--output')!, captures: values.get('--captures'), review: values.get('--review'), selfReview: values.get('--self-review') };
}

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function entityReviewHtml(corpus: EntityReviewCorpus, measurementId: string,
  state = { annotationReview: 'pending', authorReview: 'pending', hasCaptures: false }) {
  const cases = corpus.cases.map(sample => `<article id="${sample.caseId}"><h2>${escape(sample.caseId)} · ${escape(sample.split)}</h2>
    <p>项目 ${escape(sample.projectGroup)} ／ 会话 ${escape(sample.conversationGroup)} ／ ${escape(sample.tags.join('，'))}</p>
    ${sample.messages.map((message, index) => `<h3>消息 ${index} · ${message.role}</h3><pre>${escape(message.text)}</pre>`).join('')}
    <h3>关键提及与允许边界（UTF-16）</h3><table><tr><th>提及</th><th>身份组</th><th>来源／位置</th><th>原文与出现序号</th></tr>
    ${reviewMentions(sample).map(mention => `<tr><td>${escape(mention.mentionKey)}</td><td>${escape(mention.entity)}</td><td>${mention.spans.map(span => `${escape(span.evidenceRef)} [${span.start}, ${span.end})`).join('<br>')}</td><td>${escape(JSON.stringify(mention.alternatives))}<br>${escape(mention.rationale)}</td></tr>`).join('')}</table>
    <h3>身份、候选、组件及集合</h3><pre>${escape(JSON.stringify(sample.entities, null, 2))}</pre>
    <h3>知识角色及人工语义标准</h3><pre>${escape(JSON.stringify(sample.roles, null, 2))}</pre>
    <ul>${sample.semanticChecks.map(check => `<li>${escape(check)}</li>`).join('')}</ul>
    <p>知识策略：${escape(sample.knowledgePolicy)}。限制：${escape(sample.limitations.join('；'))}</p></article>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>实体标注复核记录</title><style>body{font:16px/1.7 system-ui;margin:32px auto;padding:0 20px;max-width:1100px;color:#222}article{border-top:1px solid #ccc;padding-top:24px;margin-top:32px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left;overflow-wrap:anywhere}code{overflow-wrap:anywhere}</style>
    <h1>实体标注复核记录</h1><p>作者自审：${escape(state.authorReview)}；独立人工标注复核：${escape(state.annotationReview)}；${state.hasCaptures ? '已提供捕获，输出语义复核待完成' : '尚无模型输出'}。这是合成关键提及集，不代表真实日志准确率。验证集按项目／会话预留，公开可见，不是盲测集。</p>
    <p>指南：${ENTITY_GUIDE_VERSION}；检查：${ENTITY_CHECK_VERSION}；测量身份：<code>${escape(measurementId)}</code>。</p>
    <p>作者可完成逐例语义自审，保存 self-review.json 后继续工程与探索性验收；这不要求用户承担复核，也不计入独立人工证据。独立复核使用 review-template.json，逐例填写批准或需修改及理由，签署作者独立性声明。需修正标注时升级版本并重建本包；不得看输出后修改答案。程序只能核对声明，不能证明判断正确或复核人真实独立。</p>
    <nav>${corpus.cases.map(sample => `<a href="#${sample.caseId}">${escape(sample.caseId)}</a>`).join(' ／ ')}</nav>${cases}</html>`;
}

/** Hash built bytes, including transitive runtime dependencies, rather than trusting a stale dist version label. */
function builtDigest(root: string) {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path); else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const path of files) { hash.update(relative(root, path)); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0'); }
  return `sha256:${hash.digest('hex')}`;
}

async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args = parseEntityReviewArguments(process.argv.slice(2));
  const output = qualityOutputRoot(repo, args.output);
  const corpusText = readFileSync(resolve(args.corpus), 'utf8'); const corpus = parseEntityReviewCorpus(corpusText);
  const guides = ['docs/specs/entity-extraction-evaluation.md', 'docs/zh/specs/entity-extraction-evaluation.md']
    .map(path => readFileSync(resolve(repo, path), 'utf8'));
  const guideText = guides.join('\0');
  const promptModule = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/prompt.js')).href);
  if (promptModule.EXTRACTION_PROMPT_VERSION !== 'knowledge-extraction-v8') throw new Error('This measurement requires the built v8 prompt/runtime.');
  const { checkWindowExtractionResponse } = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/window-proposals.js')).href);
  const identity = { corpusVersion: corpus.corpusVersion, checkVersion: ENTITY_CHECK_VERSION, guideVersion: ENTITY_GUIDE_VERSION,
    corpusDigest: reviewDigest(corpusText), guideDigest: reviewDigest(guideText),
    checkerDigest: reviewDigest(['entity-extraction-review.js', 'entity-review-corpus.js', 'entity-review-checks.js', 'knowledge-extraction-quality.js']
      .map(path => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8')).join('\0')),
    runtimeDigest: builtDigest(resolve(repo, 'dist')),
    dependencyDigest: reviewDigest(['package.json', 'yarn.lock'].map(path => readFileSync(resolve(repo, path), 'utf8')).join('\0')),
    nodeVersion: process.versions.node, promptVersion: promptModule.EXTRACTION_PROMPT_VERSION,
    promptHash: reviewDigest(promptModule.EXTRACTION_PROMPT), promptHashEncoding: 'raw-utf8', responseSchemaVersion: 4 };
  const measurementId = reviewDigest(JSON.stringify(identity));
  const captureText = args.captures ? readFileSync(resolve(args.captures), 'utf8') : undefined;
  const result = captureText === undefined ? null : reviewCapture(captureText, corpus, measurementId, checkWindowExtractionResponse);
  const review = reviewReceiptStatus(args.review ? readFileSync(resolve(args.review), 'utf8') : undefined, corpus, measurementId, result?.capture.startedAt);
  const author = authorReviewStatus(args.selfReview ? readFileSync(resolve(args.selfReview), 'utf8') : undefined, corpus, measurementId, result?.capture.startedAt);
  const readiness = annotationReadiness(author.status, review.status);
  const manifest = { ...identity, measurementId, annotationReview: review.status, authorReview: author.status, provenance: corpus.provenance,
    splitCounts: { development: corpus.cases.filter(sample => sample.split === 'development').length,
      validation: corpus.cases.filter(sample => sample.split === 'validation').length },
    conclusion: author.status === 'changes_requested' || review.status === 'changes_requested' ? 'annotation_changes_requested'
      : !result ? 'not_evaluated' : readiness.goldReady ? 'semantic_review_pending'
      : readiness.exploratoryReady ? 'exploratory_semantic_review_pending' : 'annotation_review_pending',
    ...readiness, modelCallsByThisCommand: 0,
    coverage: 'Synthetic critical mentions only; no overall precision/F1, real-log accuracy or population stability claim.',
    captureSummary: result?.summary ?? null };
  mkdirSync(output); // Refuse overwrite even for offline checking.
  const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2));
  save('manifest.json', manifest); writeFileSync(resolve(output, 'corpus.json'), corpusText);
  writeFileSync(resolve(output, 'annotation-guide.md'), guideText.replace('\0', '\n\n---\n\n'));
  writeFileSync(resolve(output, 'annotation-guide.en.md'), guides[0]); writeFileSync(resolve(output, 'annotation-guide.zh.md'), guides[1]);
  writeFileSync(resolve(output, 'review.html'), entityReviewHtml(corpus, measurementId, { annotationReview: review.status, authorReview: author.status, hasCaptures: !!result }));
  save('review-template.json', { reviewVersion: 'omk-entity-annotation-review/v1', measurementId,
    reviewer: '', reviewedAt: '', reviewKind: 'independent-human', reviewedBeforeOutputs: true, independenceAttestation: false,
    decisions: corpus.cases.map(sample => ({ caseId: sample.caseId, decision: 'changes_requested', rationale: '' })), disputes: [] });
  save('inputs.json', corpus.cases.map(sample => ({ caseId: sample.caseId, split: sample.split,
    inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))), input: entityReviewInput(sample) })));
  if (review.receipt) save('review.json', review.receipt);
  if (author.receipt) save('self-review.json', author.receipt);
  if (result) { writeFileSync(resolve(output, 'captures.json'), captureText!); save('checks.json', result.records); save('unattempted.json', result.unattempted); }
  console.log(`Evidence: ${output}. Author review: ${author.status}. Independent annotation review: ${review.status}. Model calls: 0. Semantic review: pending.`);
  if (result && result.summary.captureStatus !== 'captured') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

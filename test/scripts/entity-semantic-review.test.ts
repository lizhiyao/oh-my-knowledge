import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ENTITY_GUIDE_VERSION, entityReviewInput, parseEntityReviewCorpus, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { reviewDigest } from '../../scripts/bench/entity-extraction-review.js';
import { parseSemanticArguments, runSemanticCommand } from '../../scripts/bench/entity-semantic-review.js';
import { PROJECT_ROOT, runCli, runCliFailing } from '../helpers/cli-process.js';
import { testDirectory } from '../helpers/temp-directory.js';
import { modelWindow } from '../knowledge/fixtures.js';

it('requires explicit policy/split/repeats, rejects duplicate flags and offers no model-dispatch parameters', () => {
  expect(parseSemanticArguments(['prepare', '--bundle', '/bundle', '--policy', '/policy', '--split', 'development', '--repeats', '1', '--output', '/new']).command).toBe('prepare');
  for (const args of [[], ['generate'], ['prepare', '--bundle', '/b'],
    ['review', '--bundle', '/b', '--plan', '/p', '--captures', '/c', '--output', '/o', '--model', 'anything'],
    ['review', '--bundle', '/b', '--plan', '/p', '--captures', '/c', '--output', '/o', '--output', '/again'],
    ['prepare', '--bundle', '/b', '--policy', '/p', '--split', 'development', '--repeats', '3', '--output', '/o']]) {
    expect(() => parseSemanticArguments(args)).toThrow();
  }
});

function authoredCase(caseId: string, split: 'development' | 'validation', subject: string, object: string): EntityReviewCase {
  const text = `${subject} 使用 ${object}。`;
  return { caseId, split, projectGroup: `${caseId}-project`, conversationGroup: `${caseId}-conversation`,
    messages: [{ role: 'user', text }], limitations: ['Authored integration harness; no model or external verification.'], tags: ['integration-harness'],
    entities: ['project', 'tool'].map(entityKey => ({ entityKey, referentKinds: ['object'], identityStatus: 'proposed',
      possibleEntities: [], component: null, collection: null, rationale: 'A distinct object in the authored source.' })),
    mentions: [subject, object].map((quote, index) => ({ mentionKey: `name-${index}`, entity: index ? 'tool' : 'project', messageIndex: 0,
      alternatives: [{ quote, occurrence: 0 }], rationale: 'An exact authored name.' })),
    roles: [{ roleKey: 'uses', coverage: 'required', subject: 'project', object: 'tool', messageIndex: 0,
      anchor: { quote: text, occurrence: 0 }, interpretation: 'The source says the subject uses the object; retain direction and source-assertion status.' }],
    knowledgePolicy: 'optional', semanticChecks: ['Review relation direction, descriptive positive meaning, source assertion and unknown fact time.'] };
}

function expectReportIdentity(report: Record<string, unknown>) {
  const { reportId, ...analysis } = report;
  expect(reportId).toBe(reviewDigest(JSON.stringify(analysis)));
}

// Compiled entry boundary: real exit codes, exact artifacts, production admission, and no dispatch.
it('retains incomplete evidence and wires authored output review through the compiled offline command', async () => {
  const root = testDirectory('omk-semantic-command-'), bundle = join(root, 'bundle'), output = join(root, 'result');
  const corpusFile = join(root, 'authored-corpus.json');
  // Borrow the supported schema shape, without changing the published 64-window corpus or its denominator.
  const corpusBytes = JSON.stringify({ corpusVersion: 'omk-entity-quality/v13', guideVersion: ENTITY_GUIDE_VERSION,
    provenance: 'synthetic', authors: ['integration-author'], annotationScope: 'critical_mentions',
    cases: [authoredCase('integration-dev', 'development', 'Alpha', 'Beta'), authoredCase('integration-validation', 'validation', 'Gamma', 'Delta')] });
  const corpus = parseEntityReviewCorpus(corpusBytes), sample = corpus.cases[0];
  writeFileSync(corpusFile, corpusBytes);
  await runCli(['--corpus', corpusFile, '--output', bundle], {
    entry: join(PROJECT_ROOT, 'dist-scripts/bench/entity-extraction-review.js'), cwd: PROJECT_ROOT,
  });
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
  const authorBytes = JSON.stringify({ selfReviewVersion: 'omk-entity-author-review/v1', measurementId: manifest.measurementId,
    reviewer: corpus.authors[0], reviewedAt: new Date().toISOString(), reviewedBeforeOutputs: true,
    decisions: corpus.cases.map(value => ({ caseId: value.caseId, decision: 'approved', rationale: 'Authored fixture self-review; not an independent human reference.' })) }, null, 2) + '\n';
  writeFileSync(join(bundle, 'self-review.json'), authorBytes);
  const policy = join(root, 'policy.json');
  writeFileSync(policy, JSON.stringify({ maxConfirmedErrors: 0, confirmedErrorsRationale: 'Authored harness requires no confirmed errors; not a real quality threshold.',
    maxRequiredGaps: 0, requiredGapsRationale: 'Authored harness requires all obligations; not population evidence.' }));
  const entry = join(PROJECT_ROOT, 'dist-scripts/bench/entity-semantic-review.js'), planDir = join(root, 'plan');
  const prepared = await runCli(['prepare', '--bundle', bundle, '--policy', policy, '--split', 'development', '--repeats', '1', '--output', planDir], { entry, cwd: PROJECT_ROOT });
  expect(JSON.parse(prepared.stdout)).toMatchObject({ status: 'prepared', modelCallsByThisCommand: 0, exitCode: 0 });
  const planFile = join(planDir, 'plan.json'), plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const captures = join(root, 'captures.json');
  const captureBase = { captureVersion: 'omk-entity-captures/v1', measurementId: manifest.measurementId,
    split: 'development', repeats: 1, startedAt: plan.declaredAt, executor: 'authored-harness', model: 'no-model-call' };
  const bytes = JSON.stringify({ ...captureBase, records: [] });
  writeFileSync(captures, bytes);
  const args = ['review', '--bundle', bundle, '--plan', planFile, '--captures', captures, '--output', output];
  const reviewed = await runCliFailing(args, 1, { entry, cwd: PROJECT_ROOT });
  const summary = JSON.parse(reviewed.stdout), report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  expect(summary.modelCallsByThisCommand).toBe(0);
  expect(summary.status).not.toBe('accepted_within_scope');
  expect(report.captureSummary).toMatchObject({ planned: 1, recorded: 0, notAttempted: 1, usdCost: 'unknown' });
  expect(report).toMatchObject({ modelCallsByThisCommand: 0, outputReviewDigest: null });
  expectReportIdentity(report);
  expect(readFileSync(join(output, 'captures.json'), 'utf8')).toBe(bytes);
  expect(readFileSync(join(output, 'plan.json'), 'utf8')).toBe(readFileSync(planFile, 'utf8'));
  expect(readFileSync(join(output, 'corpus.json'), 'utf8')).toBe(corpusBytes);
  expect(existsSync(join(output, 'review-template.json'))).toBe(true);
  await expect(runSemanticCommand(PROJECT_ROOT, args)).rejects.toThrow('already exists');

  const response = modelWindow();
  response.mentions.forEach(mention => { mention.selection.evidenceRef = `${sample.caseId}:0`; });
  response.proposals[0].draft.evidence[0] = { ...response.proposals[0].draft.evidence[0], evidenceRef: `${sample.caseId}:0`,
    relation: 'supports', basis: 'source_assertion', interpretation: sample.roles[0].interpretation };
  response.proposals[0].citations[0].selection = { evidenceRef: `${sample.caseId}:0`, quote: sample.messages[0].text, occurrence: 0 };
  const completeCaptures = join(root, 'complete-captures.json');
  const completeBytes = JSON.stringify({ ...captureBase, records: [{ caseId: sample.caseId, repeat: 1,
    inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))), result: { captureStatus: 'output', output: JSON.stringify(response) } }] });
  writeFileSync(completeCaptures, completeBytes);
  const completeArgs = ['review', '--bundle', bundle, '--plan', planFile, '--captures', completeCaptures];
  const pendingOutput = join(root, 'pending');
  expect(await runSemanticCommand(PROJECT_ROOT, [...completeArgs, '--output', pendingOutput])).toMatchObject({ status: 'pending', exitCode: 1, modelCallsByThisCommand: 0 });
  const template = JSON.parse(readFileSync(join(pendingOutput, 'review-template.json'), 'utf8'));
  expect(new Set(template.decisions.map((value: { target: { itemKind: string } }) => value.target.itemKind)))
    .toEqual(new Set(['entity', 'mention', 'statement', 'role', 'semantic_check', 'case']));
  const receipt = { ...template, reviewer: { actorKind: 'agent', actorId: 'integration-author' }, independentHuman: false,
    reviewedAt: new Date().toISOString(), decisions: template.decisions.map((value: { target: unknown }) => ({ target: value.target,
      verdict: 'correct', errorCodes: [], rationale: 'Authored agent judgment of this fixture against its full source; no independent human approval.' })) };
  const receiptFile = join(root, 'output-review.json'), receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
  writeFileSync(receiptFile, receiptBytes);
  const finalOutput = join(root, 'agent-reviewed');
  const final = await runCliFailing([...completeArgs, '--receipt', receiptFile, '--output', finalOutput], 1, { entry, cwd: PROJECT_ROOT });
  expect(JSON.parse(final.stdout)).toMatchObject({ status: 'exploratory_reviewed', exitCode: 1, modelCallsByThisCommand: 0 });
  const finalReport = JSON.parse(readFileSync(join(finalOutput, 'report.json'), 'utf8'));
  expect(finalReport).toMatchObject({ status: 'exploratory_reviewed', reference: { authorReview: 'completed', annotationReview: 'pending', goldReady: false },
    outputReview: { independentHuman: false, confirmedErrors: 0 }, outputReviewDigest: reviewDigest(receiptBytes),
    referenceReceiptDigests: { author: reviewDigest(authorBytes), independent: null },
    captureSummary: { planned: 1, captured: 1, structuralRejectingOutputs: 0, missingCriticalMentions: 0 } });
  expectReportIdentity(finalReport);
  expect(readFileSync(join(finalOutput, 'output-review.json'), 'utf8')).toBe(receiptBytes);
  expect(readFileSync(join(finalOutput, 'reference-self-review.json'), 'utf8')).toBe(authorBytes);
  expect(readFileSync(join(finalOutput, 'captures.json'), 'utf8')).toBe(completeBytes);

  const variantFile = join(root, 'output-review-variant.json'), variantOutput = join(root, 'variant');
  const variantBytes = JSON.stringify({ ...receipt, decisions: receipt.decisions.map((value: { rationale: string }, index: number) =>
    index === 0 ? { ...value, rationale: value.rationale + ' Additional authored review note.' } : value) }, null, 2) + '\n';
  writeFileSync(variantFile, variantBytes);
  expect(await runSemanticCommand(PROJECT_ROOT, [...completeArgs, '--receipt', variantFile, '--output', variantOutput]))
    .toMatchObject({ status: 'exploratory_reviewed', exitCode: 1 });
  const variantReport = JSON.parse(readFileSync(join(variantOutput, 'report.json'), 'utf8'));
  expectReportIdentity(variantReport);
  expect(variantReport.outputReviewDigest).toBe(reviewDigest(variantBytes));
  expect(variantReport.reportId).not.toBe(finalReport.reportId);
  for (const field of ['planId', 'capturesDigest', 'toolDigest', 'captureSummary', 'referenceReceiptDigests']) expect(variantReport[field]).toEqual(finalReport[field]);
  expect(readFileSync(join(variantOutput, 'output-review.json'), 'utf8')).toBe(variantBytes);

  writeFileSync(join(bundle, 'captures.json'), bytes);
  await expect(runSemanticCommand(PROJECT_ROOT, ['prepare', '--bundle', bundle, '--policy', policy, '--split', 'development', '--repeats', '1', '--output', join(root, 'late')])).rejects.toThrow('containing outputs');
  writeFileSync(join(bundle, 'corpus.json'), readFileSync(join(bundle, 'corpus.json'), 'utf8') + '\n');
  await expect(runSemanticCommand(PROJECT_ROOT, ['review', '--bundle', bundle, '--plan', planFile, '--captures', captures, '--output', join(root, 'tampered')])).rejects.toThrow('differs');
  expect(existsSync(join(root, 'tampered'))).toBe(false);
});

// Fixed repository-only composition root. No executor, credentials or model call path.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { extractionStudyFileText } from '../../knowledge/adapters/study-files.js';
import { extractionStudyHostIdentity } from '../../knowledge/adapters/study-host.js';
import { replayExtractionStudyEvidence } from '../../knowledge/application/study-runner.js';
import { parseExtractionStudyCorpus } from '../../knowledge/extraction/study-corpus.js';
import { parseExtractionStudyPlan } from '../../knowledge/extraction/study-plan.js';
import { createExtractionStudyPanel, evaluateExtractionStudyPanel, ExtractionStudyPanelAdjudicationSchema,
  ExtractionStudyPanelSubmissionSchema, extractionStudyPanelBytesDigest, parseExtractionStudyPanel } from '../../knowledge/extraction/study-panel.js';

const format = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const evidenceEnvelope = z.object({ plan: z.unknown(), corpusRaw: z.string() });
function parents(path: string) {
  for (let cursor = resolve(path);;) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Panel output parent must be a regular directory without symbolic links.');
    const next = dirname(cursor); if (next === cursor) break; cursor = next;
  }
}
function publish(directory: string, name: string, raw: string) {
  const fd = openSync(join(directory, name), 'wx', 0o600);
  try { writeFileSync(fd, raw, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** Reports save a complete raw evidence inventory; failure leaves an explicit partial directory, never an overwrite. */
export function executeLocalExtractionStudyPanel(input: { command: 'prepare' | 'report'; values: Record<string, string>; repository: string }) {
  const { values } = input, repository = realpathSync(input.repository), output = values['--output'];
  if (!isAbsolute(output)) throw new Error('Panel output must be an explicit absolute path.');
  parents(dirname(output));
  if (existsSync(output) || inside(repository, resolve(output)) || inside(resolve(output), repository)) throw new Error('Panel output must be a new external directory.');
  const evidenceRaw = extractionStudyFileText(values['--evidence']), portable: unknown = JSON.parse(evidenceRaw);
  const replay = replayExtractionStudyEvidence(portable, extractionStudyHostIdentity());
  const envelope = evidenceEnvelope.parse(portable), plan = parseExtractionStudyPlan(envelope.plan), corpus = parseExtractionStudyCorpus(JSON.parse(envelope.corpusRaw));
  const context = { plan, corpus, slots: replay.slots, outputDigest: replay.outputDigest, integrity: replay.integrity,
    evidenceDigest: extractionStudyPanelBytesDigest(evidenceRaw), now: new Date().toISOString() };
  const files: { name: string; raw: string; role: string; reviewerId?: string }[] = [{ name: 'evidence.json', raw: evidenceRaw, role: 'original-study-evidence' }];
  let result: Record<string, unknown>;
  if (input.command === 'prepare') {
    const analysisMode = z.enum(['prospective', 'retrospective']).parse(values['--mode']);
    const rosterRaw = extractionStudyFileText(values['--roster'], 1024 * 1024);
    const panel = createExtractionStudyPanel(context, { declaredAt: context.now, analysisMode, roster: JSON.parse(rosterRaw) });
    files.push({ name: 'roster.json', raw: rosterRaw, role: 'original-roster-declaration' }, { name: 'panel.json', raw: format(panel), role: 'panel' },
      { name: 'targets.json', raw: format(panel.targets), role: 'complete-target-set' });
    result = { panelId: panel.panelId, analysisMode, expectedTargets: panel.targets.length };
  } else {
    const panelRaw = extractionStudyFileText(values['--panel'], 64 * 1024 * 1024), panel = parseExtractionStudyPanel(JSON.parse(panelRaw), context);
    const submissionRaw = extractionStudyFileText(values['--submission'], 1024 * 1024), submission = ExtractionStudyPanelSubmissionSchema.parse(JSON.parse(submissionRaw));
    const resolvedPaths = new Set<string>();
    const receipts = submission.receipts.map((entry, index) => {
      const path = resolve(dirname(values['--submission']), entry.receiptFile), raw = extractionStudyFileText(path, 64 * 1024 * 1024), real = realpathSync(path);
      if (resolvedPaths.has(real)) throw new Error('Panel submission cannot alias the same original receipt twice.');
      resolvedPaths.add(real);
      files.push({ name: `initial-${String(index).padStart(3, '0')}.json`, raw, role: 'original-initial-review', reviewerId: entry.reviewerId });
      return { receiptFile: entry.receiptFile, raw };
    });
    let adjudication: { raw: string; reviewReceiptRaw: string } | undefined;
    if (values['--adjudication']) {
      const raw = extractionStudyFileText(values['--adjudication'], 1024 * 1024), value = ExtractionStudyPanelAdjudicationSchema.parse(JSON.parse(raw));
      const reviewReceiptRaw = extractionStudyFileText(resolve(dirname(values['--adjudication']), value.reviewReceiptFile), 64 * 1024 * 1024);
      adjudication = { raw, reviewReceiptRaw };
      files.push({ name: 'adjudication.json', raw, role: 'original-adjudication-envelope' },
        { name: 'adjudication-review.json', raw: reviewReceiptRaw, role: 'original-adjudicator-review' });
    }
    const report = evaluateExtractionStudyPanel({ context, panel, submissionRaw, receipts, adjudication });
    files.push({ name: 'panel.json', raw: panelRaw, role: 'original-panel' }, { name: 'submission.json', raw: submissionRaw, role: 'original-complete-submission' },
      { name: 'targets.json', raw: format(panel.targets), role: 'complete-target-set' }, { name: 'report.json', raw: format(report), role: 'panel-report' });
    result = { panelId: panel.panelId, reportId: report.reportId, fullIAA: report.fullIAA, fullIAAUnavailableReasons: report.fullIAAUnavailableReasons };
  }
  // Validate all inputs and identities before creating the output. No source paths are loaded from portable evidence.
  mkdirSync(output, { mode: 0o700 });
  for (const file of files) publish(output, file.name, file.raw);
  publish(output, 'package-manifest.json', format({ packageVersion: 'omk-extraction-study-panel-package/v1',
    files: files.map(({ name, raw, role, reviewerId }) => ({ name, role, ...(reviewerId ? { reviewerId } : {}), bytes: Buffer.byteLength(raw, 'utf8'), digest: extractionStudyPanelBytesDigest(raw) })) }));
  syncDirectory(output); syncDirectory(dirname(output));
  return { ...result, output, modelCallsByThisCommand: 0, qualityAcceptance: 'not_assessed' as const, exitCode: 0 };
}

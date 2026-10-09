import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const QualityCasesSchema = z.array(z.strictObject({
  caseId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  provenance: z.string().trim().min(1),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string().min(1) })).min(1),
  reviewChecks: z.array(z.string().trim().min(1)).min(1),
})).min(1).max(12).refine((cases) => new Set(cases.map(({ caseId }) => caseId)).size === cases.length,
  'Case identities must be unique.');
export type QualityCase = z.infer<typeof QualityCasesSchema>[number];

export function parseQualityCases(text: string): QualityCase[] {
  return QualityCasesSchema.parse(JSON.parse(text));
}

export function parseQualityArguments(args: string[]): { output: string; model: string; prompt?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--output', '--model', '--prompt'].includes(key) || values.has(key) || !value?.trim() || value.startsWith('--')) {
      throw new Error('Expected unique --output, --model and optional --prompt pairs.');
    }
    values.set(key, value);
  }
  if (!values.has('--output') || !values.has('--model')) throw new Error('Provide --output and --model explicitly.');
  return { output: values.get('--output')!, model: values.get('--model')!, prompt: values.get('--prompt') };
}

/** Fixed evidence identities keep the input byte-identical across prompt versions. */
export function qualityInput(sample: QualityCase) {
  return {
    excerpts: sample.messages.map((message, index) => ({
      evidenceRef: `${sample.caseId}:${index}`, recordIndex: index, eventKind: 'message',
      role: message.role, text: message.text,
    })),
    limitations: ['Selected messages only. Tool calls, tool results and surrounding unselected records are not included.'],
  };
}

export function qualityOutputRoot(root: string, requested: string): string {
  if (!isAbsolute(requested)) throw new Error('Use an absolute output directory outside the repository.');
  const output = resolve(requested);
  const parent = resolve(realpathSync(dirname(output)), output.split(sep).at(-1)!);
  const location = relative(realpathSync(root), parent);
  if (!location || (!location.startsWith(`..${sep}`) && location !== '..' && !isAbsolute(location))) {
    throw new Error('Quality run output must stay outside the repository.');
  }
  return parent;
}

interface QualityRun {
  cases: QualityCase[];
  output: string;
  prompt: string;
  signal: AbortSignal;
  generate: (prompt: string, input: string, signal: AbortSignal) => Promise<{ output: string }>;
  check: (response: unknown, excerpts: ReturnType<typeof qualityInput>['excerpts']) => { accepted: unknown[]; rejected: unknown[]; analysis?: { rejected: unknown[] } };
  input?: (sample: QualityCase) => ReturnType<typeof qualityInput>;
}

/** Serial calls avoid leaving a second executor running if local persistence fails. */
export async function captureQualityCases(run: QualityRun) {
  let failed = false;
  let attempted = 0;
  for (const sample of run.cases) {
    if (run.signal.aborted) break;
    const data = (run.input ?? qualityInput)(sample);
    const input = JSON.stringify(data);
    const record: Record<string, unknown> = {
      caseId: sample.caseId, provenance: sample.provenance, inputDigest: digest(input), input: data,
      reviewChecks: sample.reviewChecks, semanticReview: 'pending',
    };
    attempted += 1;
    try {
      const result = await run.generate(run.prompt, input, run.signal);
      record.runtime = result;
      const checked = run.check(JSON.parse(result.output), data.excerpts);
      record.checked = checked;
      const rejections = checked.rejected.length + (checked.analysis?.rejected.length ?? 0);
      if (rejections) failed = true;
      console.log(`${sample.caseId}: output captured; ${rejections} structural rejections; semantic review pending`);
    } catch (error) {
      failed = true;
      record.failure = error instanceof Error ? error.message : String(error);
      console.log(`${sample.caseId}: failed; see local evidence`);
    }
    writeFileSync(resolve(run.output, `${sample.caseId}.json`), JSON.stringify(record, null, 2));
  }
  return { failed, aborted: run.signal.aborted, attempted };
}

async function main() {
  const args = parseQualityArguments(process.argv.slice(2));
  const output = qualityOutputRoot(repo, args.output);
  const corpusText = readFileSync(resolve(repo, 'test/fixtures/knowledge-extraction-quality.json'), 'utf8');
  const cases = parseQualityCases(corpusText);
  const promptModule = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/prompt.js')).href);
  const selected = args.prompt ? JSON.parse(readFileSync(args.prompt, 'utf8'))
    : { version: promptModule.EXTRACTION_PROMPT_VERSION, prompt: promptModule.EXTRACTION_PROMPT };
  if (typeof selected.version !== 'string' || !selected.version.trim() || typeof selected.prompt !== 'string' || !selected.prompt.trim()) {
    throw new Error('Prompt file must contain nonempty version and prompt strings.');
  }
  const { configuredExtractionModel } = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/adapters/executor.js')).href);
  const { generatedExtractionResponseChecker } = await import(pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/window-proposals.js')).href);
  const check = generatedExtractionResponseChecker(selected.version);
  const model = configuredExtractionModel('codex', args.model);
  mkdirSync(output); // Never overwrite an earlier run.
  const manifest = {
    promptVersion: selected.version, promptHash: digest(selected.prompt), corpusDigest: digest(corpusText),
    executor: 'codex', model: model.model, startedAt: new Date().toISOString(), caseCount: cases.length,
    independentReview: 'pending', applicability: 'Exploratory cases; no population-effect or release conclusion.',
  };
  writeFileSync(resolve(output, 'prompt.json'), JSON.stringify(selected, null, 2));
  writeFileSync(resolve(output, 'corpus.json'), corpusText);
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ ...manifest, status: 'running' }, null, 2));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await captureQualityCases({ cases, output, prompt: selected.prompt, signal: controller.signal,
      generate: (prompt, input, signal) => model.generate(prompt, input, signal), check });
    writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ ...manifest, ...result,
      status: result.aborted ? 'cancelled' : result.failed ? 'failed' : 'captured', finishedAt: new Date().toISOString(),
    }, null, 2));
    if (result.failed || result.aborted) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
  console.log(`Evidence: ${output}. USD cost is unknown unless reported by the executor. No semantic verdict was assigned.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

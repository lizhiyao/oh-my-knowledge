import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../store.js';
import { parseExtractionStudyPlan } from '../extraction/study-plan.js';
import { parseExtractionStudyCorpus } from '../extraction/study-corpus.js';
import { FileExtractionRunStore } from './run-store.js';

const bytesDigest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
export const extractionStudyBytesDigest = bytesDigest;
export const extractionStudyFileText = (path: string, maxBytes = 128 * 1024 * 1024) => regular(path, maxBytes);
function regular(path: string, maxBytes: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Study evidence must be a bounded regular file.');
  const bytes = readFileSync(path), text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Study evidence is not raw UTF-8.');
  return text;
}
function checkParents(path: string) {
  let cursor = resolve(path);
  while (true) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Study evidence directory must not contain symlinks.');
    const next = dirname(cursor); if (next === cursor) break; cursor = next;
  }
}
function sync(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function publish(path: string, text: string) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  sync(dirname(path));
}

/** Explicit external research evidence only; never an additional workspace store or an overwrite path. */
export class ExtractionStudyFiles {
  readonly directory: string;
  readonly workspace: string;
  private readonly repository: string;
  constructor(input: { directory: string; workspace: string; repository: string }) {
    if (![input.directory, input.workspace, input.repository].every(isAbsolute)) throw new Error('Study, workspace and repository paths must be explicit and absolute.');
    this.workspace = resolve(input.workspace); this.repository = realpathSync(input.repository); this.directory = resolve(input.directory);
    checkParents(this.workspace);
    checkParents(dirname(this.directory));
    const parent = realpathSync(dirname(this.directory)), target = join(parent, relative(dirname(this.directory), this.directory));
    if (target !== this.directory || inside(this.repository, target) || inside(this.workspace, target)
      || inside(target, this.repository) || inside(target, this.workspace)) throw new Error('Study output must be isolated outside the checkout and knowledge workspace.');
    if (existsSync(target)) checkParents(target);
  }
  create(planInput: unknown, corpusText: string, configurationText: string) {
    const plan = parseExtractionStudyPlan(planInput), corpus = parseExtractionStudyCorpus(JSON.parse(corpusText));
    if (plan.corpusDigest !== corpus.corpusDigest || plan.corpusBytesDigest !== bytesDigest(corpusText)
      || plan.configurationDigest !== bytesDigest(configurationText)) throw new Error('Study corpus or configuration raw bytes differ from the prepared identity.');
    mkdirSync(this.directory, { mode: 0o700 });
    publish(join(this.directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    publish(join(this.directory, 'corpus.json'), corpusText);
    publish(join(this.directory, 'configuration.json'), configurationText);
    for (const variant of plan.variants) publish(join(this.directory, `${variant.variantId}-prompt.txt`), variant.promptProfile.system);
    sync(dirname(this.directory));
  }
  open() {
    checkParents(this.directory);
    const planText = regular(join(this.directory, 'plan.json'), 128 * 1024 * 1024), plan = parseExtractionStudyPlan(JSON.parse(planText));
    const corpusText = regular(join(this.directory, 'corpus.json'), 128 * 1024 * 1024), corpus = parseExtractionStudyCorpus(JSON.parse(corpusText));
    if (plan.corpusDigest !== corpus.corpusDigest || plan.corpusBytesDigest !== bytesDigest(corpusText)) throw new Error('Frozen study corpus changed.');
    for (const variant of plan.variants) if (regular(join(this.directory, `${variant.variantId}-prompt.txt`), 2 * 1024 * 1024) !== variant.promptProfile.system) throw new Error('Frozen study prompt raw bytes changed.');
    const configurationText = regular(join(this.directory, 'configuration.json'), 4 * 1024 * 1024);
    if (bytesDigest(configurationText) !== plan.configurationDigest) throw new Error('Frozen study configuration bytes changed.');
    return { plan, corpus, corpusText, planText, configurationText };
  }
  async exclusively<T>(action: () => Promise<T>): Promise<T> {
    checkParents(this.directory);
    const lock = join(this.directory, 'active.lock'), fd = openSync(lock, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); sync(this.directory); return await action(); }
    finally { closeSync(fd); unlinkSync(lock); sync(this.directory); }
  }
  /** Copy exact validated original run/outcome bytes. Missing outcomes stay absent, never synthesized. */
  evidence(planInput: unknown) {
    const plan = parseExtractionStudyPlan(planInput), runs = new FileExtractionRunStore(join(this.workspace, 'extraction-runs'), this.workspace);
    const opened = this.open();
    if (opened.plan.planId !== plan.planId) throw new Error('Exported study plan differs from the frozen evidence directory.');
    const records: { runId: string; raw: string; outcomes: { attemptId: string; raw: string }[] }[] = [];
    for (const slot of plan.slots) {
      let run;
      try { run = runs.read(slot.runId); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const raw = regular(join(this.workspace, 'extraction-runs', `${slot.runId}.json`), 16 * 1024 * 1024);
      if (canonicalJson(JSON.parse(raw)) !== canonicalJson(run)) throw new Error('Study run changed while exporting evidence.');
      const outcomes: { attemptId: string; raw: string }[] = [];
      for (const attempt of run.attempts) {
        try {
          const checked = runs.readOutcome(run.runId, attempt.attemptId, attempt.outcome);
          const raw = regular(join(this.workspace, 'extraction-runs', 'outcomes', run.runId, `${attempt.attemptId}.json`), 512 * 1024 * 1024);
          if (Buffer.byteLength(raw) !== checked.ref.bytes || bytesDigest(raw) !== checked.ref.digest) throw new Error('Study native outcome changed while exporting evidence.');
          outcomes.push({ attemptId: attempt.attemptId, raw });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt.outcome) throw error; }
      }
      records.push({ runId: slot.runId, raw, outcomes });
    }
    return { evidenceVersion: 'omk-knowledge-extraction-study-evidence/v1' as const, plan, corpusRaw: opened.corpusText, configurationRaw: opened.configurationText, records };
  }
  /** New, private result directory. Re-analysis never overwrites the earlier report or raw evidence. */
  saveReport(output: string, value: unknown, evidence: unknown) {
    const target = new ExtractionStudyFiles({ directory: output, workspace: this.workspace, repository: this.repository });
    if (inside(this.directory, target.directory) || inside(target.directory, this.directory)) throw new Error('Report output must be separate from the frozen study evidence.');
    mkdirSync(target.directory, { mode: 0o700 });
    publish(join(target.directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    publish(join(target.directory, 'report.json'), JSON.stringify(value, null, 2) + '\n');
    sync(dirname(target.directory));
  }
}

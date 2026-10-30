import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkStorageDirectory, KnowledgeStorageStateError } from '../../evidence/storage/knowledge-workspace.js';
import { canonicalJson } from '../store.js';
import type { ExtractionStudyRunnerPorts } from './study-runner.js';
import { FileExtractionRunStore } from '../adapters/run-store.js';
import { TraceEvidenceStore } from '../adapters/trace-evidence.js';
import { ExtractionStudyFiles, extractionStudyBytesDigest, extractionStudyFileText } from '../adapters/study-files.js';
import { extractionStudyHostIdentity } from '../adapters/study-host.js';
import { prepareExtractionStudy, replayExtractionStudyEvidence } from './study-runner.js';
import { ExtractionStudyPlanSchema } from '../extraction/study-plan.js';
import { parseExtractionStudyCorpus, createExtractionStudyReferenceTemplate } from '../extraction/study-corpus.js';
import { createExtractionStudyOutputTemplate } from '../extraction/study-review.js';
import { analyzeExtractionStudy } from '../extraction/study-analysis.js';
import { configuredExtractionModel } from '../adapters/executor.js';
import type { ExecutorArchiveProducer } from '../../executors/contracts/archive.js';
import { KnowledgeActorSchema } from '../contracts.js';
import { ExtractionGenerationPolicySchema } from '../extraction/generation-policy.js';
import { ExtractionPromptProfileSchema } from '../extraction/generation.js';
import { z } from 'zod';
const bytesDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const FROZEN_TYPED_GENERATION_UNSUPPORTED = 'knowledge_study_generation_unsupported: 旧 typed 生成计划不适用于当前正文宿主；请使用 observe knowledge generate 或新的 body 测量协议。Frozen typed generation plans require a separate compatible host; use the current body generation entry or a new body measurement protocol. No model was invoked.';
export const unsupportedFrozenTypedGeneration = () => ({ errorCode: 'knowledge_study_generation_unsupported', message: FROZEN_TYPED_GENERATION_UNSUPPORTED,
  modelCallsByThisCommand: 0, goldReady: false, qualityConclusion: 'not_evaluated', exitCode: 1 });

/** This historical research writer must never add Source2 documents to a current workspace. */
function assertHistoricalSourceWorkspace(workspace: string, evidence: TraceEvidenceStore, signal?: AbortSignal): void {
  const refuse: () => never = () => { throw new KnowledgeStorageStateError('knowledge_storage_unsupported'); };
  const stat = (path: string): Stats | undefined => {
    try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const same = (before: Stats, after: Stats | undefined) => !!after && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  const root = join(workspace, 'sources'), uuid = z.string().uuid();
  const temporary = /^([0-9a-f-]{36})\.json\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
  try {
    signal?.throwIfAborted(); checkStorageDirectory(workspace);
    if (stat(join(workspace, '.source-migration.json'))) refuse();
    const before = stat(root);
    if (!before) return;
    if (!before.isDirectory() || before.isSymbolicLink()) refuse();
    const directory = opendirSync(root), seen: Array<{ path: string; stat: Stats }> = [];
    let total = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        signal?.throwIfAborted();
        if (seen.length >= 4096) refuse();
        const path = join(root, entry.name), initial = stat(path);
        if (!initial?.isFile() || initial.isSymbolicLink() || initial.size > 16 * 1024 * 1024 + 256
          || (total += initial.size) > 64 * 1024 * 1024) refuse();
        seen.push({ path, stat: initial });
        // Account for live/recoverable atomic publications without consuming or cleaning them.
        if (entry.name === '.write.lock') { if (initial.size > 4096) refuse(); continue; }
        const pending = temporary.exec(entry.name);
        if (pending && uuid.safeParse(pending[1]).success && Number.isSafeInteger(Number(pending[2])) && uuid.safeParse(pending[3]).success) continue;
        const snapshotId = entry.name.slice(0, -5);
        if (!entry.name.endsWith('.json') || !uuid.safeParse(snapshotId).success) refuse();
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let raw: unknown;
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile() || !same(initial, opened)) refuse();
          const bytes = Buffer.allocUnsafe(initial.size + 1); let offset = 0;
          while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
          if (offset !== initial.size || !same(opened, fstatSync(fd))) refuse();
          raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
        } finally { closeSync(fd); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse();
        const value = raw as Record<string, unknown>;
        // Test the envelope before the old reader, whose tombstone check predates versioned markers.
        if ('storeKind' in value || 'schemaVersion' in value || 'snapshotDigest' in value || 'markerDigest' in value) refuse();
        if (value.deleted === true) {
          if (value.snapshotId !== snapshotId || Object.keys(value).sort().join(',') !== 'deleted,snapshotId') refuse();
        } else if (value.projectionVersion !== 'knowledge-window-v2' || evidence.read(snapshotId).status !== 'available') refuse();
      }
    } finally { directory.closeSync(); }
    if (!same(before, stat(root)) || seen.some(entry => !same(entry.stat, stat(entry.path)))
      || stat(join(workspace, '.source-migration.json'))) refuse();
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof KnowledgeStorageStateError) throw error;
    refuse();
  }
}

/** The research host declares its real actor instead of inheriting local-user human attribution. */
export function createExtractionStudyPorts(input: {
  workspace: string; actor: ExtractionStudyRunnerPorts['actor']; identity: ExtractionStudyRunnerPorts['identity']; model: ExtractionStudyRunnerPorts['model'];
}): ExtractionStudyRunnerPorts {
  const workspace = resolve(input.workspace), runs = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
  const evidence: TraceEvidenceStore = new TraceEvidenceStore(join(workspace, 'sources'), workspace,
    signal => assertHistoricalSourceWorkspace(workspace, evidence, signal));
  const hash = (value: unknown) => bytesDigest(canonicalJson(value));
  const actor = input.actor;
  return { runs, actor, hash, id: randomUUID, now: () => new Date().toISOString(), identity: input.identity, model: input.model,
    application: { source: (id, version) => evidence.read(id, version), capture: (selection, signal) => {
      assertHistoricalSourceWorkspace(workspace, evidence, signal); return evidence.capture(selection, signal);
    },
      async generate() { throw new Error(FROZEN_TYPED_GENERATION_UNSUPPORTED); },
      resume() { throw new Error(FROZEN_TYPED_GENERATION_UNSUPPORTED); } } };
}

const arm = z.strictObject({ variantId: z.enum(['baseline', 'candidate']), executor: z.enum(['openai-api', 'codex']),
  model: z.string().trim().min(1), policy: ExtractionGenerationPolicySchema,
  promptProfile: ExtractionPromptProfileSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional() });
const configuration = z.strictObject({ configurationVersion: z.literal('omk-knowledge-extraction-study-configuration/v1'),
  actor: KnowledgeActorSchema, changedVariable: ExtractionStudyPlanSchema.shape.changedVariable,
  split: ExtractionStudyPlanSchema.shape.split, repeats: ExtractionStudyPlanSchema.shape.repeats,
  criteria: ExtractionStudyPlanSchema.shape.criteria, sampling: ExtractionStudyPlanSchema.shape.sampling,
  variants: z.tuple([arm, arm]) });

/** Repository delivery host. Default prepare/report have no model effects; run advances one explicitly authorized slot. */
export async function executeLocalExtractionStudy(input: {
  command: 'prepare' | 'run' | 'report'; values: Record<string, string>; repository: string; runnerFile: string;
  producer: ExecutorArchiveProducer; signal?: AbortSignal;
}) {
  // Reject before opening a plan, claiming a slot, inspecting a producer or touching a store.
  if (input.command === 'run') return unsupportedFrozenTypedGeneration();
  const { values } = input;
  const files = new ExtractionStudyFiles({ directory: values['--study'], workspace: values['--workspace'], repository: input.repository });
  const identity = () => extractionStudyHostIdentity();
  const model = (variant: { executor: string; model: string; maxOutputTokens?: number | null; timeoutMs?: number; policy: z.infer<typeof ExtractionGenerationPolicySchema> }) => {
    const maxOutputTokens = variant.maxOutputTokens ?? (variant.policy.policyId === 'knowledge-generation-bounded/v1' ? variant.policy.maxOutputTokens : undefined);
    return configuredExtractionModel(variant.executor, variant.model, input.producer,
      { ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), ...(variant.timeoutMs === undefined ? {} : { timeoutMs: variant.timeoutMs }) });
  };
  if (input.command === 'prepare') {
    const corpusText = extractionStudyFileText(values['--corpus']), configText = extractionStudyFileText(values['--config'], 4 * 1024 * 1024);
    const corpus = parseExtractionStudyCorpus(JSON.parse(corpusText)), config = configuration.parse(JSON.parse(configText));
    const ports = createExtractionStudyPorts({ workspace: files.workspace, actor: config.actor, identity, model });
    const variants = config.variants.map(variant => ({ variantId: variant.variantId, model: model(variant), policy: variant.policy,
      ...(variant.promptProfile ? { promptProfile: variant.promptProfile } : {}) })) as Parameters<typeof prepareExtractionStudy>[1]['variants'];
    const plan = prepareExtractionStudy(ports, { ...config, corpus, corpusBytesDigest: extractionStudyBytesDigest(corpusText),
      configurationDigest: extractionStudyBytesDigest(configText), variants });
    files.create(plan, corpusText, configText);
    return { planId: plan.planId, study: files.directory, slots: plan.slots.length, modelCallsByThisCommand: 0,
      goldReady: false, qualityConclusion: 'not_evaluated', exitCode: 0 };
  }
  const opened = files.open();
  const portable = files.evidence(opened.plan), report = replayExtractionStudyEvidence(portable, identity());
  const receipt = (flag: string) => values[flag] ? JSON.parse(extractionStudyFileText(values[flag], 64 * 1024 * 1024)) as unknown : undefined;
  const reviewInput = { plan: opened.plan, corpus: opened.corpus, slots: report.slots, outputDigest: report.outputDigest,
    integrity: report.integrity, authorReceipt: receipt('--author-review'), referenceReceipt: receipt('--reference-review'),
    outputReceipt: receipt('--output-review'), now: new Date().toISOString() };
  const analysis = analyzeExtractionStudy(reviewInput);
  files.saveReport(values['--output'], { ...report, analysis,
    referenceAuthorTemplate: createExtractionStudyReferenceTemplate(opened.corpus, 'author'),
    independentReferenceTemplate: createExtractionStudyReferenceTemplate(opened.corpus, 'independent'),
    outputReviewTemplate: createExtractionStudyOutputTemplate(reviewInput) }, portable);
  return { planId: opened.plan.planId, output: values['--output'], summary: report.summary,
    modelCallsByThisCommand: 0, goldReady: false, qualityConclusion: 'not_evaluated', exitCode: 0 };
}

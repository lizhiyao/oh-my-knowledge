import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../store.js';
import { KnowledgeApplication } from './application.js';
import type { ExtractionStudyRunnerPorts } from './study-runner.js';
import { FileExtractionRunStore } from '../adapters/run-store.js';
import { TraceEvidenceStore } from '../adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../adapters/knowledge-tags.js';
import { FileEntityAnalysisStore } from '../adapters/entity-store.js';
import { ExtractionStudyFiles, extractionStudyBytesDigest, extractionStudyFileText } from '../adapters/study-files.js';
import { extractionStudyHostIdentity } from '../adapters/study-host.js';
import { prepareExtractionStudy, replayExtractionStudyEvidence, runExtractionStudySlot } from './study-runner.js';
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

/** The research host declares its real actor instead of inheriting local-user human attribution. */
export function createExtractionStudyPorts(input: {
  workspace: string; actor: ExtractionStudyRunnerPorts['actor']; identity: ExtractionStudyRunnerPorts['identity']; model: ExtractionStudyRunnerPorts['model'];
}): ExtractionStudyRunnerPorts {
  const workspace = resolve(input.workspace), runs = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
  const hash = (value: unknown) => bytesDigest(canonicalJson(value));
  const actor = input.actor;
  return { runs, actor, hash, id: randomUUID, now: () => new Date().toISOString(), identity: input.identity, model: input.model,
    application: new KnowledgeApplication({ runs, actor, hash, id: randomUUID, now: () => new Date().toISOString(),
      evidence: new TraceEvidenceStore(join(workspace, 'sources'), workspace), knowledge: new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace),
      tags: new FileKnowledgeTags(join(workspace, 'tags'), 'local', workspace), entities: new FileEntityAnalysisStore(join(workspace, 'entities'), workspace) }) };
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
  if (input.command === 'run') {
    if (values['--authorize-plan'] !== opened.plan.planId) throw new Error('Explicit authorization must name this exact frozen plan, source, model and declared invocation policy.');
    const ports = createExtractionStudyPorts({ workspace: files.workspace, actor: opened.plan.actor, identity, model });
    let dispatches = 0;
    const report = await files.exclusively(() => runExtractionStudySlot(ports, { plan: opened.plan, corpus: opened.corpus,
      slotId: values['--slot'], signal: input.signal, beforeDispatch() {
        if (files.open().plan.planId !== opened.plan.planId) throw new Error('Study plan changed before dispatch.');
        dispatches++;
      } }));
    return { planId: opened.plan.planId, slotId: values['--slot'], omkDispatchesByThisCommand: dispatches,
      providerRequests: 'not_attested', summary: report.summary, goldReady: false, qualityConclusion: 'not_evaluated',
      exitCode: report.slots.find(value => value.slotId === values['--slot'])?.run?.status === 'completed' ? 0 : 1 };
  }
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

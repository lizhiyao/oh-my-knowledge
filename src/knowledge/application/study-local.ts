import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
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

/** The research host declares its real actor instead of inheriting local-user human attribution. */
export function createExtractionStudyPorts(input: {
  workspace: string; actor: ExtractionStudyRunnerPorts['actor']; identity: ExtractionStudyRunnerPorts['identity']; model: ExtractionStudyRunnerPorts['model'];
}): ExtractionStudyRunnerPorts {
  const workspace = resolve(input.workspace), runs = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
  const evidence = new TraceEvidenceStore(join(workspace, 'sources'), workspace);
  const hash = (value: unknown) => bytesDigest(canonicalJson(value));
  const actor = input.actor;
  return { runs, actor, hash, id: randomUUID, now: () => new Date().toISOString(), identity: input.identity, model: input.model,
    application: { source: (id, version) => evidence.read(id, version), capture: (selection, signal) => evidence.capture(selection, signal),
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

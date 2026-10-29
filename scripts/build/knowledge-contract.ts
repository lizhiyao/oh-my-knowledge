import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Language = 'en' | 'zh';
export interface CurrentKnowledgeContract {
  workflowId: string; bodyPromptVersion: string; associationPromptVersion: string;
  bodyProfileId: string; associationProfileId: string; bodyWireId: string; associationWireId: string;
  bodyResponseSchemaVersion: number; associationResponseSchemaVersion: number;
  knowledgeHistorySchemaVersion: number; associationHistorySchemaVersion: number; reviewHistorySchemaVersion: number; journalSchemaVersion: number;
  entityHistorySchemaVersion: number; outcomeMaxBytes: number;
  retrievalDefaultBytes: number; retrievalMinBytes: number; retrievalMaxBytes: number;
  studyPlanMaxBytes: number; studyInspectionMaxBytes: number;
}

/** Current production identities and separately labelled historical-study capacities. */
export async function loadCurrentKnowledgeContract(root: string): Promise<CurrentKnowledgeContract> {
  const load = (file: string) => import(pathToFileURL(resolve(root, 'dist/knowledge', file)).href);
  const [wire, knowledge, associations, reviews, journal, entities, archive, retrieval, plan, inspection] = await Promise.all([
    load('extraction/body-generation-wire.js'), load('store.js'), load('associations.js'), load('reviews.js'), load('extraction/generation-journal.js'),
    load('entities/contracts.js'), load('adapters/generation-journal-store.js'), load('application/retrieval.js'),
    load('extraction/study-plan.js'), load('extraction/study-capacity.js'),
  ]);
  const body = wire.BODY_GENERATION_PROFILE, association = wire.ASSOCIATION_GENERATION_PROFILE;
  return {
    workflowId: journal.GenerationJournalSchema.shape.workflowId.value,
    bodyPromptVersion: body.promptVersion, associationPromptVersion: association.promptVersion,
    bodyProfileId: body.profileId, associationProfileId: association.profileId, bodyWireId: body.wireId, associationWireId: association.wireId,
    bodyResponseSchemaVersion: wire.BodyGenerationResponseSchema.shape.schemaVersion.value,
    associationResponseSchemaVersion: wire.AssociationGenerationResponseSchema.shape.schemaVersion.value,
    knowledgeHistorySchemaVersion: knowledge.KnowledgeEnvelopeSchema.shape.schemaVersion.value,
    associationHistorySchemaVersion: associations.KnowledgeAssociationEnvelopeSchema.shape.schemaVersion.value,
    reviewHistorySchemaVersion: reviews.KnowledgeReviewEnvelopeSchema.shape.schemaVersion.value,
    journalSchemaVersion: journal.GenerationJournalSchema.shape.schemaVersion.value,
    entityHistorySchemaVersion: entities.EntityAnalysisEnvelopeSchema.shape.schemaVersion.value,
    outcomeMaxBytes: archive.MAX_GENERATION_OUTCOME_BYTES,
    retrievalDefaultBytes: retrieval.KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES, retrievalMinBytes: retrieval.KNOWLEDGE_RETRIEVAL_MIN_BYTES,
    retrievalMaxBytes: retrieval.KNOWLEDGE_RETRIEVAL_MAX_BYTES,
    studyPlanMaxBytes: plan.EXTRACTION_STUDY_PLAN_MAX_BYTES, studyInspectionMaxBytes: inspection.EXTRACTION_STUDY_INSPECTION_MAX_BYTES,
  };
}

/** Both languages render one data object; no rounded limits or copied prompt versions. */
export function renderCurrentKnowledgeContract(values: CurrentKnowledgeContract, language: Language): string {
  const zh = language === 'zh';
  const integer = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid current knowledge contract limit.');
    return value.toLocaleString('en-US');
  };
  const bytes = (value: number) => `${integer(value)} ${zh ? '字节' : 'bytes'}`;
  const code = (value: string | number) => {
    if (typeof value === 'number') integer(value);
    else if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid current knowledge contract identity.');
    return `\`${value}\``;
  };
  const rows: [string, string, string][] = [
    ['Production workflow', '生产流程', code(values.workflowId)],
    ['Body prompt', '正文 prompt', code(values.bodyPromptVersion)],
    ['Association prompt', '关联 prompt', code(values.associationPromptVersion)],
    ['Body profile digest', '正文 profile 摘要', code(values.bodyProfileId)],
    ['Association profile digest', '关联 profile 摘要', code(values.associationProfileId)],
    ['Body structural wire digest', '正文结构线协议摘要', code(values.bodyWireId)],
    ['Association structural wire digest', '关联结构线协议摘要', code(values.associationWireId)],
    ['Body response Schema', '正文响应 Schema', code(values.bodyResponseSchemaVersion)],
    ['Association response Schema', '关联响应 Schema', code(values.associationResponseSchemaVersion)],
    ['Knowledge history Schema', '知识历史 Schema', code(values.knowledgeHistorySchemaVersion)],
    ['Association history Schema', '关联历史 Schema', code(values.associationHistorySchemaVersion)],
    ['Review and use feedback history Schema', '复核与使用反馈历史 Schema', code(values.reviewHistorySchemaVersion)],
    ['Generation journal Schema', '生成日志 Schema', code(values.journalSchemaVersion)],
    ['Entity history Schema', '实体历史 Schema', code(values.entityHistorySchemaVersion)],
    ['Complete native archive capacity', '完整原生归档容量', bytes(values.outcomeMaxBytes)],
    ['Default retrieval response budget (adjustable)', '默认检索响应预算（可调）', bytes(values.retrievalDefaultBytes)],
    ['Minimum retrieval response budget', '最小检索响应预算', bytes(values.retrievalMinBytes)],
    ['Maximum retrieval response budget', '最大检索响应预算', bytes(values.retrievalMaxBytes)],
    ['Historical typed study plan capacity', '历史 typed 研究计划容量', bytes(values.studyPlanMaxBytes)],
    ['Portable study inspection capacity', '可携带研究核对容量', bytes(values.studyInspectionMaxBytes)],
  ];
  return ['<!-- Generated by scripts/build/docs.ts from compiled runtime constants and Schemas. -->', '',
    zh ? '| 当前契约 | 值 |' : '| Current contract | Value |', '|---|---|',
    ...rows.map(([en, cn, value]) => `| ${zh ? cn : en} | ${value} |`)].join('\n');
}

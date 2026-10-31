import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Language = 'en' | 'zh';
export interface CurrentKnowledgeContract {
  workflowId: string; bodyPromptVersion: string; associationPromptVersion: string;
  ledgerPromptVersion: string; coveragePromptVersion: string; ledgerProfileId: string; coverageProfileId: string;
  ledgerWireId: string; coverageWireId: string; ledgerHistorySchemaVersion: number; coverageHistorySchemaVersion: number;
  bodyProfileId: string; associationProfileId: string; bodyWireId: string; associationWireId: string;
  bodyResponseSchemaVersion: number; associationResponseSchemaVersion: number;
  knowledgeHistorySchemaVersion: number; associationHistorySchemaVersion: number; reviewHistorySchemaVersion: number; journalSchemaVersion: number;
  entityHistorySchemaVersion: number; relationHistorySchemaVersion: number; graphProjectionSchemaVersion: number; outcomeMaxBytes: number;
  sourceSnapshotSchemaVersion: number; sourceProjectionVersion: string; sourceInputVersion: string; sourceImportRunIdentity: string;
  associationInputVersion: string;
  retrievalDefaultBytes: number; retrievalMinBytes: number; retrievalMaxBytes: number;
  studyPlanMaxBytes: number; studyInspectionMaxBytes: number;
}

/** Current production identities and separately labelled historical-study capacities. */
export async function loadCurrentKnowledgeContract(root: string): Promise<CurrentKnowledgeContract> {
  const load = (file: string) => import(pathToFileURL(resolve(root, 'dist/knowledge', file)).href);
  const [wire, knowledge, associations, reviews, journal, entities, archive, retrieval, plan, inspection, sources, sourceStore, sourceInput, sourceReview, reviewWire, relations, graph] = await Promise.all([
    load('extraction/body-generation-wire.js'), load('store.js'), load('associations.js'), load('reviews.js'), load('extraction/generation-journal.js'),
    load('entities/contracts.js'), load('adapters/generation-journal-store.js'), load('application/retrieval.js'),
    load('extraction/study-plan.js'), load('extraction/study-capacity.js'),
    load('sources.js'), load('adapters/source-store.js'), load('extraction/source-input.js'),
    load('source-review.js'), load('extraction/source-review-wire.js'), load('relations.js'), load('application/graph.js'),
  ]);
  const body = wire.BODY_GENERATION_PROFILE, association = wire.ASSOCIATION_GENERATION_PROFILE;
  return {
    workflowId: journal.GenerationJournalSchema.shape.workflowId.value,
    bodyPromptVersion: body.promptVersion, associationPromptVersion: association.promptVersion,
    ledgerPromptVersion: reviewWire.SOURCE_LEDGER_GENERATION_PROFILE.promptVersion, coveragePromptVersion: reviewWire.SOURCE_COVERAGE_GENERATION_PROFILE.promptVersion,
    ledgerProfileId: reviewWire.SOURCE_LEDGER_GENERATION_PROFILE.profileId, coverageProfileId: reviewWire.SOURCE_COVERAGE_GENERATION_PROFILE.profileId,
    ledgerWireId: reviewWire.SOURCE_LEDGER_GENERATION_PROFILE.wireId, coverageWireId: reviewWire.SOURCE_COVERAGE_GENERATION_PROFILE.wireId,
    ledgerHistorySchemaVersion: sourceReview.SourceLedgerEnvelopeSchema.shape.schemaVersion.value,
    coverageHistorySchemaVersion: sourceReview.SourceCoverageEnvelopeSchema.shape.schemaVersion.value,
    bodyProfileId: body.profileId, associationProfileId: association.profileId, bodyWireId: body.wireId, associationWireId: association.wireId,
    bodyResponseSchemaVersion: wire.BodyGenerationResponseSchema.shape.schemaVersion.value,
    associationResponseSchemaVersion: wire.AssociationGenerationResponseSchema.shape.schemaVersion.value,
    knowledgeHistorySchemaVersion: knowledge.KnowledgeEnvelopeSchema.shape.schemaVersion.value,
    associationHistorySchemaVersion: associations.KnowledgeAssociationEnvelopeSchema.shape.schemaVersion.value,
    reviewHistorySchemaVersion: reviews.KnowledgeReviewEnvelopeSchema.shape.schemaVersion.value,
    relationHistorySchemaVersion: relations.KnowledgeRelationEnvelopeSchema.shape.schemaVersion.value,
    graphProjectionSchemaVersion: graph.KNOWLEDGE_GRAPH_SCHEMA_VERSION,
    journalSchemaVersion: journal.GenerationJournalSchema.shape.schemaVersion.value,
    entityHistorySchemaVersion: entities.EntityAnalysisEnvelopeSchema.shape.schemaVersion.value,
    sourceSnapshotSchemaVersion: sourceStore.SOURCE_SNAPSHOT_SCHEMA_VERSION, sourceProjectionVersion: sources.SOURCE_PROJECTION_VERSION,
    sourceInputVersion: journal.GenerationJournalSchema.shape.inputVersion.value, sourceImportRunIdentity: sourceInput.SOURCE_IMPORT_RUN_IDENTITY,
    associationInputVersion: sourceInput.SOURCE_GENERATION_INPUT_VERSION,
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
    ['Source ledger prompt', '来源清单 prompt', code(values.ledgerPromptVersion)],
    ['Body prompt', '正文 prompt', code(values.bodyPromptVersion)],
    ['Source coverage prompt', '来源覆盖 prompt', code(values.coveragePromptVersion)],
    ['Association prompt', '关联 prompt', code(values.associationPromptVersion)],
    ['Body profile digest', '正文 profile 摘要', code(values.bodyProfileId)],
    ['Association profile digest', '关联 profile 摘要', code(values.associationProfileId)],
    ['Source ledger profile digest', '来源清单 profile 摘要', code(values.ledgerProfileId)],
    ['Source coverage profile digest', '来源覆盖 profile 摘要', code(values.coverageProfileId)],
    ['Body structural wire digest', '正文结构线协议摘要', code(values.bodyWireId)],
    ['Association structural wire digest', '关联结构线协议摘要', code(values.associationWireId)],
    ['Source ledger structural wire digest', '来源清单结构线协议摘要', code(values.ledgerWireId)],
    ['Source coverage structural wire digest', '来源覆盖结构线协议摘要', code(values.coverageWireId)],
    ['Body response Schema', '正文响应 Schema', code(values.bodyResponseSchemaVersion)],
    ['Association response Schema', '关联响应 Schema', code(values.associationResponseSchemaVersion)],
    ['Knowledge history Schema', '知识历史 Schema', code(values.knowledgeHistorySchemaVersion)],
    ['Association history Schema', '关联历史 Schema', code(values.associationHistorySchemaVersion)],
    ['Review and use feedback history Schema', '复核与使用反馈历史 Schema', code(values.reviewHistorySchemaVersion)],
    ['Cross-knowledge relation history Schema', '跨知识关系历史 Schema', code(values.relationHistorySchemaVersion)],
    ['Knowledge graph projection Schema', '知识图谱投影 Schema', code(values.graphProjectionSchemaVersion)],
    ['Generation journal Schema', '生成日志 Schema', code(values.journalSchemaVersion)],
    ['Source ledger history Schema', '来源清单历史 Schema', code(values.ledgerHistorySchemaVersion)],
    ['Source coverage history Schema', '来源覆盖历史 Schema', code(values.coverageHistorySchemaVersion)],
    ['Entity history Schema', '实体历史 Schema', code(values.entityHistorySchemaVersion)],
    ['Source snapshot Schema', '来源快照 Schema', code(values.sourceSnapshotSchemaVersion)],
    ['Source projection', '来源投影', code(values.sourceProjectionVersion)],
    ['Source generation input', '来源生成输入', code(values.sourceInputVersion)],
    ['Preserved association input envelope', '保留的关联输入封装', code(values.associationInputVersion)],
    ['Default source import run identity', '默认来源导入运行身份', code(values.sourceImportRunIdentity)],
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

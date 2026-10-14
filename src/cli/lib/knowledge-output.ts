import type { KnowledgeApplication } from '../../observability/knowledge-extraction/application.js';
import type { KnowledgeOperation } from '../../observability/knowledge-extraction/operations.js';
import type { ExtractionRun } from '../../observability/knowledge-extraction/runs.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';

/** Every copyable next step carries the same explicit workspace. */
export function knowledgeCommand(workspace: string, operation: string, fields: Record<string, string | number | boolean> = {}): string {
  return ['omk observe knowledge', operation, '--workspace', shellQuoteArg(workspace),
    ...Object.entries(fields).flatMap(([flag, value]) => typeof value === 'boolean' ? value ? [`--${flag}`] : [] : [`--${flag}`, shellQuoteArg(String(value))])].join(' ');
}
export function formatKnowledgeResult(value: unknown, lang: 'zh' | 'en', operation: KnowledgeOperation, workspace: string): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const command = (name: string, fields?: Record<string, string | number | boolean>) => knowledgeCommand(workspace, name, fields);
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  let body = formatBody(value, lang); const next: string[] = [];
  if (Array.isArray(value) && !value.length) body = operation.operation === 'list' ? t('尚无知识；没有候选不代表没有可积累的经验。', 'No knowledge yet; an empty list does not mean there is nothing to learn.') : t('尚无提炼运行。', 'No extraction runs yet.');
  switch (operation.operation) {
    case 'capture':
      next.push(t('归档只保存选定记录，不会调用模型。先核对来源范围：', 'Capture only saves selected records and does not call a model. Review the source scope first:'), command('source', { snapshot: String(item.snapshotId) }));
      next.push(t('确认片段后再 generate；该操作会调用配置的模型：', 'After reviewing excerpts, generate calls the configured model:'), command('generate', { snapshot: String(item.snapshotId) })); break;
    case 'list':
      next.push(value instanceof Array && value.length ? command('show', { id: value[0].knowledgeId }) : command('capture', { source: './session.jsonl' })); break;
    case 'show': {
      const detail = value as ReturnType<KnowledgeApplication['detail']>;
      next.push(t('核对来源、适用条件与未知项后，使用当前修订记录维护决定：', 'Review sources, conditions and unknowns before recording a maintenance decision:'), command('retain', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId, generation: detail.history.generation, reason: t('核对后的理由', 'Reason after review') }));
      if (detail.grounding.entityAnalysisRef) next.push(command('entities', { analysis: detail.grounding.entityAnalysisRef.analysisId, 'entity-revision': detail.grounding.entityAnalysisRef.revisionId }));
      break;
    }
    case 'generate': case 'resume': {
      const run = value as ExtractionRun;
      if (run.status === 'completed') {
        next.push(command('entities', { analysis: run.runId }));
        if (run.committed.length) next.push(command('show', { id: run.committed[0].knowledgeId }));
        else next.push(t('本次未提交知识。核对实体结果、拒绝原因和原始来源；不要把零结果视为提炼质量通过。', 'No knowledge was committed. Review entities, rejection reasons and the source; zero results do not demonstrate extraction quality.'), command('runs', { json: true }), command('source', { snapshot: run.snapshotId }));
      } else if (run.rawOutput !== undefined || run.status === 'prepared') next.push(t('resume 恢复已保存结果，不再次调用模型：', 'Resume restores saved results without another model call:'), command('resume', { id: run.runId }));
      else next.push(t('尚无可恢复的模型结果；先核对运行状态。resume 不重新提炼，也不启动第二次模型调用。', 'No saved model result is available to restore. Inspect the run first; resume neither re-extracts nor starts a second model call.'), command('runs'));
      break;
    }
    case 'runs':
      if (Array.isArray(value) && value.length) next.push(t('恢复只处理已保存结果，不调用模型。选择运行身份：', 'Recovery only handles saved results, without calling a model. Select a run identity:'), command('resume', { id: value[0].runId }));
      else next.push(command('capture', { source: './session.jsonl' }));
      break;
    case 'entities': case 'correct-entities': {
      const detail = value as ReturnType<KnowledgeApplication['entities']>;
      next.push(t('纠正实体只新增实体修订，不会自动改写知识；应用时需明确知识及实体修订。', 'Entity correction only adds an entity revision; knowledge changes require explicitly selected knowledge and entity revisions.'), command('entities', { analysis: detail.history.analysisId, 'entity-revision': detail.revision.revisionId }), command('list')); break;
    }
    case 'entity-catalog': {
      const catalog = value as ReturnType<KnowledgeApplication['queryEntities']>;
      next.push(catalog.rows.length ? command('entities', { analysis: catalog.rows[0].analysisId, 'entity-revision': catalog.rows[0].revisionId }) : t('调整搜索或筛选后重试；没有匹配对象不代表身份已归并。', 'Adjust the search or filters; no matching entities does not establish merged identity.')); break;
    }
    case 'source': {
      const source = value as ReturnType<KnowledgeApplication['source']>;
      if (source.status === 'unavailable') next.push(t('来源不可用，不能据此核对原文。请保留历史身份；如需重新归档，明确选择原日志：', 'The source is unavailable; its original text cannot be reviewed. Preserve historical identities and explicitly select the original log to capture again:'), command('capture', { source: './session.jsonl' }));
      else next.push(t('读取不会调用模型。确认发送范围后再提炼：', 'Reading does not call a model. Confirm the sending scope before extracting:'), command('generate', { snapshot: source.window.snapshotId })); break;
    }
    case 'delete-source': next.push(t('仅标记来源已删除；历史知识和修订身份仍保留，后续原文核对会显示不可用。', 'Only the source is marked deleted; knowledge history and revision identities remain, with original evidence shown as unavailable.'), command('list')); break;
    case 'maintain': next.push(t('维护决定不证明效果。读取当前知识，核对已保存决定：', 'Maintenance does not prove effectiveness. Read current knowledge to check the saved decision:'), command('show', { id: operation.id })); break;
    case 'revise': case 'apply-entities': next.push(t('新修订不会继承旧维护决定。先核对，再明确保留或舍弃：', 'The new revision does not inherit the old maintenance choice. Review it before choosing retain or discard:'), command('show', { id: operation.id })); break;
    default: break;
  }
  return [body, `${t('知识工作区', 'Knowledge workspace')}: ${workspace}`, ...(next.length ? [`${t('下一步', 'Next')}:`, ...next] : [])].join('\n\n');
}

function formatBody(value: unknown, lang: 'zh' | 'en'): string {
  if (Array.isArray(value)) return value.length ? value.map((entry) => formatBody(entry, lang)).join('\n\n') : (lang === 'zh' ? '暂无记录。' : 'No records.');
  if (!value || typeof value !== 'object') return String(value);
  const item = value as Record<string, unknown>;
  if (item.runKind === 'knowledge-extraction-run') {
    const run = item as unknown as ExtractionRun;
    return [lang === 'zh' ? `提炼运行：${run.status}` : `Extraction run: ${run.status}`,
      `${run.runId} · ${run.executor} / ${run.model}`,
      lang === 'zh' ? `已提交 ${run.committed.length} 条知识；${run.rejections.length} 条知识未接纳；${run.entityRejections ? `${run.entityRejections.length} 条实体未接纳` : '实体拒绝数量未记录'}。接纳不代表已证实。` : `${run.committed.length} knowledge items committed; ${run.rejections.length} knowledge proposals rejected; ${run.entityRejections ? `${run.entityRejections.length} entity proposals rejected` : 'entity rejection count unreported'}. Admission does not verify truth.`,
      ...(run.error ? [run.error] : [])].join('\n');
  }
  if ('rows' in item && 'entityCount' in item) {
    const catalog = item as ReturnType<KnowledgeApplication['queryEntities']>;
    return [lang === 'zh' ? `${catalog.total} 个匹配对象 · 第 ${catalog.page} 页；身份对应仍需核对。` : `${catalog.total} matching entities · page ${catalog.page}; identity assignments need review.`,
      ...(catalog.unavailableAnalyses ? [lang === 'zh' ? `${catalog.unavailableAnalyses} 份分析不可读，结果不完整。` : `${catalog.unavailableAnalyses} unreadable analyses; results are incomplete.`] : []),
      ...(catalog.knowledgeStatus === 'unavailable' ? [lang === 'zh' ? '关联知识不可读，数量未知。' : 'Linked knowledge unavailable; counts unknown.'] : []),
      ...catalog.rows.map(row => `${row.label} · ${row.identityStatus} · ${row.mentionCount} ${lang === 'zh' ? '处提及' : 'mentions'} · ${row.knowledgeCount ?? '—'} ${lang === 'zh' ? '条知识' : 'knowledge items'}\n${row.analysisId} / ${row.entityId} / ${row.revisionId}\n${row.qualifiers.join(' / ')} · ${row.sourceStatus}`)].join('\n\n');
  }
  if ('history' in item && (item.history as { storeKind?: string })?.storeKind === 'entity-analysis-history') {
    const analysis = item as ReturnType<KnowledgeApplication['entities']>;
    return [lang === 'zh' ? '实体分析，身份对应仍需核对。' : 'Entity analysis; identity assignments need review.',
      `${analysis.history.analysisId} / ${analysis.revision.revisionId} · generation ${analysis.history.generation}`,
      JSON.stringify({ entities: analysis.revision.entities, mentions: analysis.revision.mentions, limitations: analysis.revision.limitations,
        revisionReason: analysis.revision.revisionReason, sourceStatus: analysis.source.status }, null, 2)].join('\n');
  }
  if ('revision' in item) {
    const detail = item as ReturnType<KnowledgeApplication['detail']>;
    return [
      detail.revision.title, `${detail.revision.knowledgeId} / ${detail.revision.revisionId} · generation ${detail.history.generation}`,
      lang === 'zh' ? `维护决定：${detail.maintenance?.choice === 'retain' ? '已保留' : detail.maintenance?.choice === 'discard' ? '已舍弃' : '尚未决定'}；保留不等于已证实，效果尚未验证。` : `Maintenance: ${detail.maintenance?.choice ?? 'undecided'}; retention does not verify truth or effectiveness.`,
      JSON.stringify(detail.revision.content, null, 2),
      JSON.stringify({ entities: detail.revision.entities, evidence: detail.revision.evidence, grounding: detail.grounding, sources: detail.sources }, null, 2),
    ].join('\n');
  }
  if ('snapshotId' in item && 'excerpts' in item) return `${item.snapshotId}\n${lang === 'zh' ? '来源范围与限制' : 'Source scope and limitations'}: ${item.startRecord}–${item.endRecord}\n${JSON.stringify(item.limitations)}\n${item.sourcePath}`;
  if ('title' in item) return `${item.title}\n${item.knowledgeId} / ${item.revisionId} · generation ${item.generation} · ${lang === 'zh' ? '维护决定' : 'maintenance'}: ${item.choice ?? '—'}`;
  return JSON.stringify(value, null, 2);
}

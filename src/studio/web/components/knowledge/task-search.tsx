'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Select, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeTaskQuery, KnowledgeTaskRetrieval } from '../../../view-models/knowledge/knowledge-candidates';
import type { KnowledgeReaderSelection } from './reader';
import { requestTaskKnowledge } from './library-request';

type BodyRef = KnowledgeTaskRetrieval['knowledge'][number]['bodyRef'];
type SourceRef = { snapshotId: string; sourceVersion: string; title?: string };
type Props = {
  workspace: string; lang: Language; sources?: SourceRef[];
  onOpen(ref: BodyRef, selection: KnowledgeReaderSelection): void;
  onFeedback?(ref: BodyRef, segmentId: string, query: string): void;
};
const sourceKey = (source: SourceRef) => `${source.snapshotId}/${source.sourceVersion}`;

/** Each workspace owns its form, pending request and returned snapshot. */
export function KnowledgeTaskSearch(props: Props) {
  return <TaskSearchSession key={props.workspace} {...props}/>;
}

function TaskSearchSession({ workspace, lang, sources = [], onOpen, onFeedback }: Props) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [query, setQuery] = useState(''), [includeCandidates, setIncludeCandidates] = useState(false);
  const [maxBytes, setMaxBytes] = useState<number | null>(65_536), [scope, setScope] = useState<SourceRef>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [answer, setAnswer] = useState<{ request: KnowledgeTaskQuery; result: KnowledgeTaskRetrieval }>();
  const [retrievedSources, setRetrievedSources] = useState<SourceRef[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function invalidate() {
    controller.current?.abort(); controller.current = null; setBusy(false); setError(''); setAnswer(undefined);
  }
  const knownSources = new Map<string, SourceRef>([...retrievedSources, ...sources, ...(scope ? [scope] : [])].map(source => [sourceKey(source), source]));
  const valid = !!query.trim() && query.trim().length <= 512 && maxBytes !== null && Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 1_048_576;
  async function search() {
    if (!valid || busy || controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError(''); setAnswer(undefined);
    const request: KnowledgeTaskQuery = { query: query.trim(), includeCandidates, maxBytes: maxBytes!,
      ...(scope ? { snapshot: scope.snapshotId, sourceVersion: scope.sourceVersion } : {}) };
    try {
      const result = await requestTaskKnowledge(workspace, request, active.signal);
      if (!active.signal.aborted && controller.current === active) { setAnswer({ request, result }); setRetrievedSources(result.sources); }
    } catch {
      if (!active.signal.aborted) setError(t('未能读取检索结果。请检查问题、来源范围和预算后重新查找；读取失败不表示没有知识。', 'Could not read retrieval results. Check the question, source scope and budget, then search again. A failed read does not mean no knowledge exists.'));
    } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <section className="knowledge-task-search" aria-label={t('按任务查找知识', 'Find knowledge for a task')}>
    <form className="knowledge-task-form" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label className="knowledge-field">{t('当前要解决的问题', 'Question for the current task')}<Input.TextArea aria-label={t('当前要解决的问题', 'Question for the current task')} rows={2} maxLength={512} value={query}
        placeholder={t('例如：什么情况下应复用已有诊断结果？', 'For example: when should existing diagnostic results be reused?')}
        onChange={event => { invalidate(); setQuery(event.target.value); }}/></label>
      <Checkbox checked={includeCandidates} onChange={event => { invalidate(); setIncludeCandidates(event.target.checked); }}>{t('同时查找未保留候选', 'Include candidates without a retain decision')}</Checkbox>
      <p className="candidate-help">{t('默认查找已保留正文；已舍弃修订不纳入。候选或保留均不代表内容已证实。', 'Search retained content by default; discarded revisions are excluded. Candidates and retained content are not verified truth.')}</p>
      <details><summary>{t('来源范围与响应预算', 'Source scope and response budget')}</summary>
        <label className="knowledge-field">{t('来源快照', 'Source snapshot')}<Select aria-label={t('任务检索来源快照', 'Task retrieval source snapshot')} value={scope ? sourceKey(scope) : ''}
          options={[{ value: '', label: t('当前工作区全部来源', 'All sources in this workspace') }, ...[...knownSources.values()].map((source, index) => ({ value: sourceKey(source), label: `${source.title || t(`来源 ${index + 1}`, `Source ${index + 1}`)} · ${source.snapshotId.slice(0, 8)}` }))]}
          onChange={value => { const next = knownSources.get(value); invalidate(); setScope(next ? { snapshotId: next.snapshotId, sourceVersion: next.sourceVersion, ...('title' in next ? { title: next.title } : {}) } : undefined); }}/></label>
        <p className="candidate-help">{t('来源选项来自当前打开知识和上次检索；限定的是精确快照与版本，不按对象名称推断归属。', 'Source choices come from the open knowledge and the last search. Scope uses an exact snapshot and version, without inferring identity from names.')}</p>
        {scope && <p className="candidate-help"><code>{scope.snapshotId} / {scope.sourceVersion}</code></p>}
        <label className="knowledge-field">{t('响应预算（UTF-8 字节）', 'Response budget (UTF-8 bytes)')}<InputNumber aria-label={t('任务检索响应预算', 'Task retrieval response budget')} min={1024} max={1_048_576} step={1024} value={maxBytes} onChange={value => { invalidate(); setMaxBytes(value); }}/></label>
        <p className="candidate-help">{t('预算包含正文与引用元信息；装不下时整段省略，不截断适用条件。', 'The budget includes content and reference metadata. Segments that do not fit are omitted whole, preserving their conditions.')}</p>
      </details>
      <Space wrap><Button type="primary" htmlType="submit" disabled={!valid || busy} loading={busy}>{t('查找适用知识', 'Find applicable knowledge')}</Button>{busy && <Button onClick={invalidate}>{t('取消查找', 'Cancel search')}</Button>}</Space>
      <p className="candidate-help">{t('本地字面检索，0 次模型调用；措辞不同可能漏召回。', 'Local literal retrieval, with zero model calls; different wording can miss relevant content.')}</p>
    </form>
    <div className="knowledge-task-results" aria-live="polite" aria-busy={busy}>
      {busy && <Spin tip={t('正在查找正文…', 'Searching content…')}><div className="knowledge-task-loading"/></Spin>}
      {error && <Alert type="warning" title={error}/>}
      {!busy && !error && !answer && <p className="candidate-help">{t('输入任务问题后查找；结果可直接打开精确正文和依据。', 'Enter a task question to find content and open its exact revision and evidence.')}</p>}
      {answer && <>
        <p role="status">{t(`返回 ${answer.result.items.length} 个完整段落，来自 ${answer.result.knowledge.length} 条知识。`, `${answer.result.items.length} complete segments from ${answer.result.knowledge.length} knowledge items.`)}</p>
        <p className="candidate-help">{answer.request.snapshot ? t('范围：选定来源的精确版本', 'Scope: the selected exact source version') : t('范围：当前工作区全部来源', 'Scope: all sources in this workspace')} · {t(`预算 ${answer.request.maxBytes} 字节`, `Budget ${answer.request.maxBytes} bytes`)} · {answer.request.includeCandidates ? t('含未保留候选', 'Includes candidates') : t('仅已保留知识', 'Retained knowledge only')}</p>
        {(answer.result.omitted.budgetSegments > 0 || answer.result.omitted.oversizedSegments > 0) && <Alert type="warning" title={t(`部分段落未提供：预算省略 ${answer.result.omitted.budgetSegments} 段，超限 ${answer.result.omitted.oversizedSegments} 段。请扩大预算重新查找，或打开完整正文。`, `Some segments were not provided: ${answer.result.omitted.budgetSegments} omitted by budget; ${answer.result.omitted.oversizedSegments} oversized. Increase the budget and search again, or open the complete content.`)}/>}
        {answer.result.scopeDiagnostics?.source?.status === 'unavailable' && <Alert type="warning" title={t('限定来源当前不可读；保存正文与引文可供参考，无法完整核对原文。', 'The scoped source is unavailable. Saved content and quotations remain available, but the original cannot be fully checked.')}/>}
        {!answer.result.items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('当前文字、来源范围与预算下未返回正文。可调整问题，或明确纳入候选。', 'No content returned for these terms, source scope and budget. Adjust the question or explicitly include candidates.')}/>}
        {answer.result.items.map(item => {
          const knowledge = answer.result.knowledge[item.knowledge];
          return <section className="knowledge-task-result" key={`${knowledge.bodyRef.knowledgeId}/${knowledge.bodyRef.revisionId}/${item.segment.segmentId}`}>
            <h3>{knowledge.title}</h3><p className="candidate-help">{knowledge.choice === 'retain' ? t('已保留', 'Retained') : t('未作保留决定', 'No retain decision')} · {t(`本知识提供 ${knowledge.segmentScope.returned}／${knowledge.segmentScope.total} 段`, `${knowledge.segmentScope.returned}/${knowledge.segmentScope.total} segments provided for this knowledge`)}</p>
            <p className="knowledge-task-segment-text">{item.segment.text}</p>
            <Space wrap><Button size="small" onClick={() => onOpen(knowledge.bodyRef, { tab: 'body', segmentId: item.segment.segmentId })}>{t('打开完整正文', 'Open complete content')}</Button>
              {onFeedback && <Button size="small" onClick={() => onFeedback(knowledge.bodyRef, item.segment.segmentId, answer.request.query)}>{t('核对这段知识', 'Review this segment')}</Button>}</Space>
            <details><summary>{t('核对依据与精确修订', 'Inspect evidence and exact revision')}</summary><p className="candidate-help"><code>{knowledge.bodyRef.knowledgeId} / {knowledge.bodyRef.revisionId}</code></p>
              {item.evidenceChecks.map(check => {
                const evidence = item.segment.evidence[check.evidenceIndex], source = answer.result.sources[check.source];
                return <p className="candidate-help" key={check.evidenceIndex}>{check.positionStatus === 'matched' ? t('引文位置匹配，含义仍需核对', 'Quotation position matches; meaning still needs review') : check.positionStatus === 'mismatch' ? t('引文位置不匹配', 'Quotation position mismatch') : t('来源不可读', 'Source unavailable')} · {({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[evidence.basis]}<br/>
                  <Button type="link" size="small" onClick={() => onOpen(knowledge.bodyRef, { tab: 'evidence', segmentId: item.segment.segmentId, evidence: { ...evidence.source, evidenceRef: evidence.selection.evidenceRef, start: evidence.selection.start, end: evidence.selection.end } })}>{source.status === 'available' ? t('打开精确依据', 'Open exact evidence') : t('查看保存引文', 'Read saved quotation')}</Button></p>;
              })}
            </details>
          </section>;
        })}
      </>}
    </div>
  </section>;
}

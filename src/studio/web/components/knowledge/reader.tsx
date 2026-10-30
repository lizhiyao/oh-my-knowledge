'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Input, Select, Space, Tag, Typography } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { displayTime } from '../../../application/display/format';
import { candidateDecisionLabel } from '../../../application/knowledge/candidate-status';
import { KnowledgeReviewSummary } from './review-summary';
import { KNOWLEDGE_ENTITIES_PATH } from '../../../http/page-paths';

export type KnowledgeReaderSelection = {
  tab?: 'body' | 'evidence' | 'associations' | 'history'; segmentId?: string; mentionId?: string; relationId?: string;
  catalogRef?: { analysisId: string; entityRevisionId: string };
  evidence?: { snapshotId: string; sourceVersion: string; evidenceRef: string; start: number; end: number };
};
export type KnowledgeReaderEntityTarget = { analysisId: string; entityRevisionId: string; entityId: string };

export function CandidateDecisionHeader({ title, maintenance, lang }: {
  title: string; maintenance: KnowledgeCandidateDetail['maintenance']; lang: Language;
}) {
  const zh = lang === 'zh';
  const t = (cn: string, en: string) => zh ? cn : en;
  return <>
    <h2>{title}</h2><Tag>{candidateDecisionLabel(maintenance?.choice ?? null, lang)}</Tag>
    {maintenance && <p className="candidate-help">{zh
      ? `决定理由：「${maintenance.reason}」 · 决定人 ${maintenance.actor.actorId} · ${displayTime(maintenance.at)}`
      : `Decision reason: "${maintenance.reason}" · by ${maintenance.actor.actorId} · ${displayTime(maintenance.at)}`}</p>}
    <Typography.Paragraph type="secondary">{t('保留表示愿意维护，不等于内容已得到证实。', 'Retaining means choosing to maintain this content, not verifying its truth.')}</Typography.Paragraph>
  </>;
}

/** Canonical text remains readable independently of source availability and derived associations. */
export function KnowledgeReader({ detail, lang, busy = false, header, tools, footer, workspace, selection, onSelectionChange, onRevision, onEntities, onEntity, onMapAssociations, onReviewAssociations, onRebuildAssociations, onDeleteSource, onRetry, onReviewContent }: {
  detail: KnowledgeCandidateDetail; lang: Language; busy?: boolean; header?: ReactNode; tools?: ReactNode; footer?: ReactNode;
  onReviewContent?(): void; workspace?: string; selection?: KnowledgeReaderSelection; onSelectionChange?(selection: KnowledgeReaderSelection): void; onEntity?(target: KnowledgeReaderEntityTarget): void;
  onRevision(revision: string): void; onEntities?(): void; onMapAssociations?(): void; onReviewAssociations?(choice: 'accept' | 'reject', reason: string): void; onRebuildAssociations?(): void; onDeleteSource?(snapshot: string): void; onRetry(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [localSelection, setLocalSelection] = useState<KnowledgeReaderSelection>({ tab: 'body' });
  const active = selection ?? localSelection, tab = active.tab ?? 'body';
  const scroll = useRef<HTMLDivElement>(null);
  function choose(next: KnowledgeReaderSelection) { setLocalSelection(next); onSelectionChange?.(next); }
  const [associationReason, setAssociationReason] = useState('');
  useEffect(() => { setAssociationReason(''); }, [detail.derivedAssociations.generation, detail.revision.revisionId]);
  useEffect(() => { setLocalSelection({ tab: 'body' }); }, [detail.revision.knowledgeId, detail.revision.revisionId]);
  const segments = detail.revision.content.segments;
  const derived = detail.derivedAssociations;
  const catalogs = detail.derivedCatalogs;
  const catalogFor = (ref: { analysisId: string; entityRevisionId: string }) => catalogs.find(catalog => catalog.analysisId === ref.analysisId && catalog.entityRevisionId === ref.entityRevisionId);
  const selections = segments.flatMap(segment => segment.evidence.map(evidence => ({ segmentId: segment.segmentId, mentionId: undefined as string | undefined, relationId: undefined as string | undefined, catalogRef: undefined as KnowledgeReaderSelection['catalogRef'], ...evidence })));
  if (derived.status === 'available') {
    for (const ref of derived.revision?.segmentEntityRefs ?? []) for (const mentionId of ref.mentionIds) {
      const catalog = catalogFor(ref);
      const mention = catalog?.status === 'available' ? catalog.mentions.find(item => item.mentionId === mentionId && item.entityId === ref.entityId) : undefined;
      if (mention && catalog?.status === 'available') selections.push({ segmentId: ref.segmentId, mentionId, relationId: undefined,
        catalogRef: { analysisId: ref.analysisId, entityRevisionId: ref.entityRevisionId }, source: { snapshotId: catalog.snapshotId, sourceVersion: catalog.sourceVersion },
        selection: mention.selection, basis: mention.basis === 'explicit' ? 'source_assertion' : 'inference', interpretation: mention.rationale });
    }
  }
  for (const relation of derived.status === 'available' ? derived.revision?.typedRelations ?? [] : []) for (const segmentId of relation.segmentIds) for (const evidence of relation.evidence) {
    selections.push({ segmentId, mentionId: undefined, relationId: relation.relationId, catalogRef: undefined, ...evidence });
  }
  const requestedEvidence = active.evidence;
  const hasTarget = requestedEvidence !== undefined || active.segmentId !== undefined || active.mentionId !== undefined || active.relationId !== undefined || active.catalogRef !== undefined;
  const matchingCitations = hasTarget ? selections.flatMap((item, index) => (active.segmentId === undefined || item.segmentId === active.segmentId)
    && (active.mentionId === undefined || item.mentionId === active.mentionId)
    && (active.relationId === undefined || item.relationId === active.relationId)
    && (!active.catalogRef || (item.catalogRef?.analysisId === active.catalogRef.analysisId && item.catalogRef?.entityRevisionId === active.catalogRef.entityRevisionId))
    && (!requestedEvidence || (item.source.snapshotId === requestedEvidence.snapshotId && item.source.sourceVersion === requestedEvidence.sourceVersion
      && item.selection.evidenceRef === requestedEvidence.evidenceRef && item.selection.start === requestedEvidence.start && item.selection.end === requestedEvidence.end)) ? [index] : []) : [0];
  const citation = active.mentionId && matchingCitations.length > 1 ? -1 : matchingCitations[0] ?? -1;
  const selected = selections[citation];
  function inspect(index: number) {
    const item = selections[index];
    if (item) choose({ tab: 'evidence', segmentId: item.segmentId, mentionId: item.mentionId, relationId: item.relationId, ...(item.catalogRef ? { catalogRef: item.catalogRef } : {}), evidence: { ...item.source,
      evidenceRef: item.selection.evidenceRef, start: item.selection.start, end: item.selection.end } });
  }
  const source = detail.sources.find(entry => entry.status === 'available'
    && entry.window.snapshotId === selected?.source.snapshotId && entry.window.sourceVersion === selected?.source.sourceVersion);
  const excerpt = source?.status === 'available' ? source.window.excerpts.find(item => item.evidenceRef === selected?.selection.evidenceRef) : undefined;
  const organization = detail.revision.content.organization;
  const sourceMatches = !!excerpt && !!selected && excerpt.text.slice(selected.selection.start, selected.selection.end) === selected.selection.quote;
  const evidenceReady = tab === 'evidence' && sourceMatches;
  useEffect(() => {
    const container = scroll.current, focused = container?.querySelector<HTMLElement>('[data-mention-id][data-focused="true"], [data-relation-id][data-focused="true"]') ?? container?.querySelector<HTMLElement>('[data-focused="true"]');
    if (container && focused) container.scrollTop += focused.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
  }, [detail.revision.knowledgeId, detail.revision.revisionId, tab, active.segmentId, active.mentionId, active.relationId,
    active.catalogRef?.analysisId, active.catalogRef?.entityRevisionId, requestedEvidence?.snapshotId, requestedEvidence?.sourceVersion,
    requestedEvidence?.evidenceRef, requestedEvidence?.start, requestedEvidence?.end, evidenceReady]);
  const entityLabel = (ref: { analysisId: string; entityRevisionId: string; entityId: string }) => { const catalog = catalogFor(ref); return catalog?.status === 'available' ? catalog.entities.find(entity => entity.entityId === ref.entityId)?.label ?? ref.entityId : ref.entityId; };
  const referencesUnavailable = (derived.revision?.catalogRefs ?? []).some(ref => { const catalog = catalogFor(ref); return catalog?.status !== 'available'
    || !detail.sources.some(source => source.status === 'available' && source.window.snapshotId === catalog.snapshotId && source.window.sourceVersion === catalog.sourceVersion); });
  const tabs = [{ key: 'body', label: t('正文', 'Content') }, { key: 'evidence', label: t('依据', 'Evidence') },
    { key: 'associations', label: t('实体与关联', 'Entities and associations') }, { key: 'history', label: t('修订历史', 'Revision history') }];
  return <article className="knowledge-reader">
    <header className="knowledge-reader-heading">
      <CandidateDecisionHeader title={detail.revision.title} maintenance={detail.maintenance} lang={lang}/>
      <div className="knowledge-reader-meta">
        {organization && <span>{({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[organization.knowledgeKind]}</span>}
        <span>{t(`${segments.length} 个知识段落`, `${segments.length} knowledge segments`)}</span>
        {detail.revision.revisionId !== detail.history.writeHeadRevisionId && <span>{t('历史知识修订', 'Historical knowledge revision')}</span>}
      </div>
      {header}
      <nav className="knowledge-reader-tabs" aria-label={t('知识阅读视图', 'Knowledge reading view')}>
        {tabs.map(item => <button type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => choose({ ...active, tab: item.key as KnowledgeReaderSelection['tab'] })}>{item.label}</button>)}
      </nav>
    </header>
    <div className="knowledge-reader-scroll" ref={scroll} key={`${detail.revision.knowledgeId}/${detail.revision.revisionId}/${tab}`}>
      <div className="knowledge-reading">
        <KnowledgeReviewSummary detail={detail} workspace={workspace} lang={lang} onOpen={onReviewContent}/>
        {tab === 'body' && <>
          {detail.sources.some(entry => entry.status === 'unavailable') && <Alert type="warning" title={t('来源不可用；已保存正文可读，依据无法完整核对。', 'Source unavailable. Saved content remains readable; evidence cannot be fully reviewed.')} action={<Button disabled={busy} onClick={onRetry}>{t('重试读取', 'Retry reading')}</Button>}/>}
          {segments.map(segment => <section key={segment.segmentId} className="knowledge-statement" data-segment-id={segment.segmentId} data-focused={active.segmentId === segment.segmentId}>
            <p className="knowledge-segment-text">{segment.text}</p>
            <div className="knowledge-evidence-link"><Button type="link" disabled={busy} onClick={() => inspect(selections.findIndex(item => item.segmentId === segment.segmentId))}>{t('核对来源', 'Inspect sources')}</Button>
              {!!derived.revision?.segmentEntityRefs.some(ref => ref.segmentId === segment.segmentId) && <Button type="link" disabled={busy} onClick={() => choose({ tab: 'associations', segmentId: segment.segmentId })}>{t('查看段落关联', 'Inspect segment associations')}</Button>}
              <span>{t(`${segment.evidence.length} 条来源依据`, `${segment.evidence.length} source citations`)}</span></div>
          </section>)}
          <details><summary>{t('复用说明', 'Reuse notes')}</summary><p>{detail.revision.reuseRationale}</p></details>
          {!!detail.tagging.tags.length && <p className="candidate-help">{detail.tagging.tags.join(' · ')}</p>}
        </>}
        {tab === 'associations' && <>
          <h3>{t('正文的派生关联', 'Associations derived from this content')}</h3>
          <p>{t('关联与正文分别维护。关联待核对、失败或过期时，正文仍可阅读和使用；关联不是已证实事实。', 'Associations are maintained independently. Pending, failed or stale associations do not prevent reading the content and do not establish verified facts.')}</p>
          {derived.status === 'absent' && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('此正文修订尚无派生关联。', 'This content revision has no derived associations.')}/>}
          {derived.status === 'failed' && <Alert type="warning" title={t('关联未完成，已保存的正文保持不变。', 'Associations are incomplete. The saved content is unchanged.')}/>}
          {derived.status === 'stale' && <Alert type="warning" title={t('已有的关联对应另一正文修订，当前正文不使用它。', 'Existing associations refer to a different content revision and are not applied to this content.')}/>}
          {derived.status === 'available' && <>
            <p>{t('关联核对状态：', 'Association review: ')}{({ pending: t('待核对', 'Pending'), accepted: t('已接受', 'Accepted'), rejected: t('已拒绝', 'Rejected') })[derived.reviewStatus]}</p>
            <p className="candidate-help">{t('关联修订：', 'Association revision: ')}<code>{derived.revision?.revisionId}</code> · {t('正文修订：', 'Content revision: ')}<code>{detail.revision.revisionId}</code></p>
            <p>{t(`${derived.revision?.segmentEntityRefs.length ?? 0} 处段落关联。`, `${derived.revision?.segmentEntityRefs.length ?? 0} segment associations.`)}</p>
            {catalogs.map(catalog => <p className="candidate-help" key={`${catalog.analysisId}/${catalog.entityRevisionId}`}>{t('实体目录与修订：', 'Entity catalog and revision: ')}<code>{catalog.analysisId} / {catalog.entityRevisionId}</code>{catalog.status === 'available' && catalog.entityRevisionId !== catalog.currentHeadRevisionId && ` · ${t('目录已有新修订；此处显示原绑定版本，需明确应用新映射。', 'The catalog has a newer revision. This shows the bound version; apply a new mapping explicitly.')}`}{catalog.status === 'unavailable' && ` · ${t('目录不可读，其他目录及正文仍可核对。', 'Catalog unavailable; other catalogs and content remain inspectable.')}`}</p>)}
            {referencesUnavailable && <Alert type="warning" title={t('部分实体目录或来源暂不可读；精确 ID 和其他可读映射仍保留，暂不能接受此关联修订。', 'Some bound entity catalogs or sources are unavailable. Exact IDs and other readable mappings remain visible; accepting this projection is unavailable.')}/>}
            {derived.revision?.segmentEntityRefs.map(ref => { const catalog = catalogFor(ref); return <section className="candidate-statement" key={`${ref.segmentId}/${ref.analysisId}/${ref.entityRevisionId}/${ref.entityId}`} data-segment-id={ref.segmentId} data-focused={active.segmentId === ref.segmentId}>
              <p>{segments.find(segment => segment.segmentId === ref.segmentId)?.text ?? ref.segmentId}</p>
              <p>{t('关联对象：', 'Associated entity: ')}{entityLabel(ref)} <code>{ref.entityId}</code></p>
              <details><summary>{t('此映射的精确目录身份', 'Exact catalog identity for this mapping')}</summary><code>{ref.analysisId} / {ref.entityRevisionId}</code></details>
              <Space wrap><Button type="link" disabled={busy} onClick={() => choose({ tab: 'body', segmentId: ref.segmentId })}>{t('定位正文段落', 'Locate content segment')}</Button>
                {onEntity ? <Button type="link" disabled={busy} onClick={() => onEntity({ analysisId: ref.analysisId, entityRevisionId: ref.entityRevisionId, entityId: ref.entityId })}>{t('核对这个实体', 'Inspect this entity')}</Button>
                  : workspace && <Link href={`${KNOWLEDGE_ENTITIES_PATH}?${new URLSearchParams({ workspace, analysis: ref.analysisId, revision: ref.entityRevisionId, entity: ref.entityId })}`}>{t('核对这个实体', 'Inspect this entity')}</Link>}</Space>
              {ref.mentionIds.map(id => { const mention = catalog?.status === 'available' ? catalog.mentions.find(item => item.mentionId === id && item.entityId === ref.entityId) : undefined;
                const index = selections.findIndex(item => item.mentionId === id && item.segmentId === ref.segmentId && item.catalogRef?.analysisId === ref.analysisId && item.catalogRef.entityRevisionId === ref.entityRevisionId);
                return <div className="knowledge-mention" key={id} data-mention-id={id} data-focused={active.mentionId === id && (!active.catalogRef || (active.catalogRef.analysisId === ref.analysisId && active.catalogRef.entityRevisionId === ref.entityRevisionId))}>{mention ? <><blockquote>{mention.selection.quote}</blockquote><p className="candidate-help"><code>{id}</code> · {mention.selection.evidenceRef} · {mention.selection.start}–{mention.selection.end} · {mention.rationale}</p>
                  <Button type="link" disabled={busy || index < 0} onClick={() => inspect(index)}>{t('回查这处提及的原文', 'Inspect this mention in its source')}</Button></> : <p>{t('提及不可读：', 'Mention unavailable: ')}<code>{id}</code></p>}</div>;
              })}
            </section>; })}
            {!!derived.revision?.typedRelations?.length && <><h4>{t('已有的派生关系', 'Existing derived relations')}</h4>{derived.revision.typedRelations.map(relation => <section className="candidate-statement" key={relation.relationId} data-relation-id={relation.relationId} data-focused={active.relationId === relation.relationId}>
              <p>{entityLabel(relation.subject)} · {relation.relation}{relation.object ? ` · ${entityLabel(relation.object)}` : ''}</p>
              <p className="candidate-help"><code>{relation.subject.entityId}{relation.object ? ` → ${relation.object.entityId}` : ''}</code></p>
              <p className="candidate-help">{relation.modality} / {relation.polarity} · {relation.segmentIds.join(', ')}</p>
              {relation.evidence.map((evidence, index) => {
                const segmentId = relation.segmentIds.find(id => id === active.segmentId) ?? relation.segmentIds[0];
                const citationIndex = selections.findIndex(item => item.relationId === relation.relationId && item.segmentId === segmentId
                  && item.source.snapshotId === evidence.source.snapshotId && item.source.sourceVersion === evidence.source.sourceVersion
                  && item.selection.evidenceRef === evidence.selection.evidenceRef && item.selection.start === evidence.selection.start && item.selection.end === evidence.selection.end);
                return <div key={index}><blockquote>{evidence.selection.quote}</blockquote><p className="candidate-help">{evidence.basis} · {evidence.selection.evidenceRef} · {evidence.selection.start}–{evidence.selection.end}{evidence.interpretation ? ` · ${evidence.interpretation}` : ''}</p><p className="candidate-help"><code>{evidence.source.snapshotId} / {evidence.source.sourceVersion}</code></p>
                  <Button type="link" disabled={busy || citationIndex < 0} onClick={() => inspect(citationIndex)}>{t('回查这处关系依据', 'Inspect this relation evidence in its source')}</Button></div>;
              })}
              {relation.issues.map((issue, index) => <p key={index}>{issue}</p>)}
            </section>)}</>}
            {derived.revision?.issues.map((issue, index) => <p key={index}>{issue}</p>)}
            {onReviewAssociations && <><Input.TextArea aria-label={t('关联核对理由', 'Association review reason')} value={associationReason} disabled={busy} onChange={event => setAssociationReason(event.target.value)} placeholder={t('核对关联对象与正文是否对应，填写理由', 'Explain whether the associated entities match this content')}/>
              <Space wrap><Button disabled={busy || referencesUnavailable || !associationReason.trim()} onClick={() => onReviewAssociations('accept', associationReason.trim())}>{t('接受关联', 'Accept associations')}</Button>
                <Button disabled={busy || !associationReason.trim()} onClick={() => onReviewAssociations('reject', associationReason.trim())}>{t('拒绝关联', 'Reject associations')}</Button></Space></>}
          </>}
          <Space wrap>
            {onMapAssociations && <Button disabled={busy} onClick={onMapAssociations}>{t('编辑实体映射', 'Edit entity mappings')}</Button>}
            {onRebuildAssociations && <Button disabled={busy} onClick={onRebuildAssociations}>{t('重新生成关联', 'Regenerate associations')}</Button>}
            {onEntities && derived.status === 'available' && !!derived.revision?.catalogRefs.length && <Button disabled={busy} onClick={onEntities}>{t('核对关联对象', 'Inspect associated entities')}</Button>}
          </Space>
        </>}
        {tab === 'evidence' && <>
          <h3>{t('原始依据', 'Source evidence')}</h3>
          <Select aria-label={t('证据片段', 'Evidence excerpt')} value={citation >= 0 ? citation : undefined} style={{ width: '100%' }} options={selections.map((item, index) => ({ value: index,
            label: `${index + 1} · ${item.relationId ? t('关系依据', 'Relation evidence') : item.mentionId ? t('实体提及', 'Entity mention') : t('正文引文', 'Content citation')} · ${t('段落', 'Segment')} ${segments.findIndex(segment => segment.segmentId === item.segmentId) + 1} · ${item.selection.quote.slice(0, 90)}` }))} onChange={inspect}/>
          {hasTarget && !selected && <Alert type="warning" title={t('在指定的段落、提及、关系和来源范围中未找到精确依据，未替换为其他引文。请核对修订身份。', 'The requested exact evidence is absent from the specified segment, mention, relation and source scope. No other quotation was substituted. Check the revision identity.')}/>}
          {selected && <p className="candidate-help">{({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[selected.basis]}{selected.interpretation ? ` · ${selected.interpretation}` : ''}</p>}
          {excerpt && selected ? <><p className="candidate-help">{t('记录', 'Record')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind} · {excerpt.timestamp ?? t('来源时间未知', 'Source time unknown')}</p>
            {!sourceMatches && <Alert type="warning" title={t('保存的引文与此快照位置不匹配，不能当作已核对；原文与保存引文分别保留。', 'The saved quotation does not match this snapshot span. It is not verified; original text and saved quotation remain separate.')}/>}
            <pre className="knowledge-source">{sourceMatches ? <>{excerpt.text.slice(0, selected.selection.start)}<mark data-focused="true">{excerpt.text.slice(selected.selection.start, selected.selection.end)}</mark>{excerpt.text.slice(selected.selection.end)}</> : excerpt.text}</pre>
            {!sourceMatches && <blockquote>{selected.selection.quote}</blockquote>}
            {selected.segmentId && <Button type="link" disabled={busy} onClick={() => choose({ ...active, tab: 'body', segmentId: selected.segmentId })}>{t('返回对应正文段落', 'Return to this content segment')}</Button>}
            {source?.status === 'available' && <><p className="candidate-help">{source.window.limitations.join(' ')}</p><details><summary>{t('原始记录及相邻上下文', 'Original record and adjacent context')}</summary>{source.window.records.filter(record => Math.abs(record.recordIndex - excerpt.recordIndex) <= 1).map(record => <pre className="knowledge-source" key={record.recordIndex}>{record.recordIndex}: {record.raw}</pre>)}</details></>}
          </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={!selected
            ? t('指定依据尚未定位。请核对段落、提及、关系与修订身份。', 'Requested evidence was not located. Check the segment, mention, relation and revision identity.')
            : t('此来源不可用，不能核对完整证据。已保存引文仍可阅读。', 'This source is unavailable. Saved quotations remain readable, but full evidence cannot be checked.')}>
            {selected && <blockquote>{selected.selection.quote}</blockquote>}<Button disabled={busy} onClick={onRetry}>{t('重试读取', 'Retry reading')}</Button></Empty>}
          {selected && <details><summary>{t('精确依据身份', 'Exact evidence identity')}</summary><p className="candidate-help"><code>{selected.source.snapshotId} / {selected.source.sourceVersion}</code> · {selected.selection.evidenceRef} · {selected.selection.start}–{selected.selection.end}{selected.mentionId && <> · <code>{selected.mentionId}</code></>}{selected.relationId && <> · <code>{selected.relationId}</code></>}</p></details>}
          {detail.sources.map((entry, index) => entry.status === 'unavailable' ? <Alert key={index} type="warning" title={`${t('来源不可用', 'Source unavailable')}: ${entry.reason}`}/>
            : onDeleteSource && <Button key={index} danger size="small" disabled={busy} onClick={() => onDeleteSource(entry.window.snapshotId)}>{t('删除来源快照', 'Delete source snapshot')}</Button>)}
        </>}
        {tab === 'history' && <>
          <h3>{t('修订历史', 'Revision history')}</h3>
          <Select aria-label={t('历史修订', 'Revision history')} value={detail.revision.revisionId} disabled={busy} style={{ width: '100%' }} options={detail.history.revisions.map((revision, i) => ({ value: revision.revisionId, label: `${i + 1} · ${revision.title}` }))} onChange={onRevision}/>
          <p>{displayTime(detail.revision.revisedAt)} · {detail.revision.revisedBy.actorId}</p><p>{detail.revision.revisionReason}</p>
          <details><summary>{t('精确知识身份', 'Exact knowledge identity')}</summary><p><code>{detail.revision.knowledgeId} / {detail.revision.revisionId}</code></p><p>{t('正文摘要', 'Content digest')}：<code>{detail.revision.bodyDigest}</code></p></details>
          <h3>{t('维护决定', 'Maintenance decisions')}</h3>
          {detail.history.maintenance.filter(item => item.revisionId === detail.revision.revisionId).map((item, index) => <p key={index}>{candidateDecisionLabel(item.choice, lang)} · {item.reason} · {displayTime(item.at)} · {item.actor.actorId}</p>)}
          {tools && <details><summary>{t('维护主题标签', 'Maintain topic tags')}</summary>{tools}</details>}
        </>}
      </div>
    </div>
    {footer && <footer className="knowledge-reader-footer">{footer}</footer>}
  </article>;
}

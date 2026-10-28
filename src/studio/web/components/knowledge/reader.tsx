'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Input, Select, Space, Tag, Typography } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { displayTime } from '../../../application/display/format';
import { candidateDecisionLabel } from '../../../application/knowledge/candidate-status';

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
export function KnowledgeReader({ detail, lang, busy = false, header, tools, footer, onRevision, onEntities, onMapAssociations, onReviewAssociations, onRebuildAssociations, onDeleteSource, onRetry }: {
  detail: KnowledgeCandidateDetail; lang: Language; busy?: boolean; header?: ReactNode; tools?: ReactNode; footer?: ReactNode;
  onRevision(revision: string): void; onEntities?(): void; onMapAssociations?(): void; onReviewAssociations?(choice: 'accept' | 'reject', reason: string): void; onRebuildAssociations?(): void; onDeleteSource?(snapshot: string): void; onRetry(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [tab, setTab] = useState('body'); const [citation, setCitation] = useState(0);
  const [associationReason, setAssociationReason] = useState('');
  useEffect(() => { setAssociationReason(''); }, [detail.derivedAssociations.generation, detail.revision.revisionId]);
  useEffect(() => { setTab('body'); setCitation(0); }, [detail.revision.knowledgeId, detail.revision.revisionId]);
  const segments = detail.revision.content.segments;
  const selections = segments.flatMap(segment => segment.evidence.map(evidence => ({ segmentId: segment.segmentId, ...evidence })));
  const selected = selections[citation];
  const source = detail.sources.find(entry => entry.status === 'available'
    && entry.window.snapshotId === selected?.source.snapshotId && entry.window.sourceVersion === selected?.source.sourceVersion);
  const excerpt = source?.status === 'available' ? source.window.excerpts.find(item => item.evidenceRef === selected?.selection.evidenceRef) : undefined;
  const organization = detail.revision.content.organization;
  const derived = detail.derivedAssociations;
  const catalog = detail.derivedCatalog;
  const entityLabel = (id: string) => catalog.status === 'available' ? catalog.entities.find(entity => entity.entityId === id)?.label ?? id : id;
  const referencesUnavailable = catalog.status !== 'available' && !!(derived.revision?.segmentEntityRefs.length || derived.revision?.typedRelations?.length);
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
        {tabs.map(item => <button type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>{item.label}</button>)}
      </nav>
    </header>
    <div className="knowledge-reader-scroll" key={`${detail.revision.knowledgeId}/${detail.revision.revisionId}/${tab}`}>
      <div className="knowledge-reading">
        {tab === 'body' && <>
          {detail.sources.some(entry => entry.status === 'unavailable') && <Alert type="warning" title={t('来源不可用；已保存正文可读，依据无法完整核对。', 'Source unavailable. Saved content remains readable; evidence cannot be fully reviewed.')} action={<Button disabled={busy} onClick={onRetry}>{t('重试读取', 'Retry reading')}</Button>}/>}
          {segments.map(segment => <section key={segment.segmentId} className="knowledge-statement" data-segment-id={segment.segmentId}>
            <p className="knowledge-segment-text">{segment.text}</p>
            <div className="knowledge-evidence-link"><Button type="link" disabled={busy} onClick={() => { setCitation(Math.max(0, selections.findIndex(item => item.segmentId === segment.segmentId))); setTab('evidence'); }}>{t('核对来源', 'Inspect sources')}</Button>
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
            <p>{t(`${derived.revision?.segmentEntityRefs.length ?? 0} 处段落关联。`, `${derived.revision?.segmentEntityRefs.length ?? 0} segment associations.`)}</p>
            {catalog.status === 'available' && <p className="candidate-help">{t('实体修订：', 'Entity revision: ')}<code>{catalog.revisionId}</code>{catalog.revisionId !== catalog.currentHeadRevisionId && ` · ${t('目录已有新修订；此处显示原绑定版本，需明确应用新映射。', 'The catalog has a newer revision. This shows the bound version; apply a new mapping explicitly.')}`}</p>}
            {referencesUnavailable && <Alert type="warning" title={t('绑定的实体修订暂不可读；保留精确 ID，不能核对或接受这些映射。', 'The bound entity revision is unavailable. Exact IDs remain visible; these mappings cannot be checked or accepted.')}/>}
            {derived.revision?.segmentEntityRefs.map(ref => <section className="candidate-statement" key={`${ref.segmentId}/${ref.entityId}`}>
              <p>{segments.find(segment => segment.segmentId === ref.segmentId)?.text ?? ref.segmentId}</p>
              <p>{t('关联对象：', 'Associated entity: ')}{entityLabel(ref.entityId)} <code>{ref.entityId}</code></p>
              {ref.mentionIds.map(id => { const mention = catalog.status === 'available' ? catalog.mentions.find(item => item.mentionId === id && item.entityId === ref.entityId) : undefined;
                return <div key={id}>{mention ? <><blockquote>{mention.selection.quote}</blockquote><p className="candidate-help">{mention.selection.evidenceRef} · {mention.selection.start}–{mention.selection.end} · {mention.rationale}</p></> : <p>{t('提及不可读：', 'Mention unavailable: ')}<code>{id}</code></p>}</div>;
              })}
            </section>)}
            {!!derived.revision?.typedRelations?.length && <><h4>{t('已有的派生关系', 'Existing derived relations')}</h4>{derived.revision.typedRelations.map(relation => <section className="candidate-statement" key={relation.relationId}>
              <p>{entityLabel(relation.subject.entityId)} · {relation.relation}{relation.object ? ` · ${entityLabel(relation.object.entityId)}` : ''}</p>
              <p className="candidate-help"><code>{relation.subject.entityId}{relation.object ? ` → ${relation.object.entityId}` : ''}</code></p>
              <p className="candidate-help">{relation.modality} / {relation.polarity} · {relation.segmentIds.join(', ')}</p>
              {relation.evidence.map((evidence, index) => <div key={index}><blockquote>{evidence.selection.quote}</blockquote><p className="candidate-help">{evidence.basis} · {evidence.selection.evidenceRef} · {evidence.selection.start}–{evidence.selection.end}{evidence.interpretation ? ` · ${evidence.interpretation}` : ''}</p><p className="candidate-help"><code>{evidence.source.snapshotId} / {evidence.source.sourceVersion}</code></p></div>)}
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
            {onEntities && derived.status === 'available' && derived.revision?.entityAnalysisRef && <Button disabled={busy} onClick={onEntities}>{t('核对关联对象', 'Inspect associated entities')}</Button>}
          </Space>
        </>}
        {tab === 'evidence' && <>
          <h3>{t('原始依据', 'Source evidence')}</h3>
          <Select aria-label={t('证据片段', 'Evidence excerpt')} value={selections.length ? citation : undefined} style={{ width: '100%' }} options={selections.map((item, index) => ({ value: index, label: `${item.selection.quote.slice(0, 90)}` }))} onChange={setCitation}/>
          {selected && <p className="candidate-help">{({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[selected.basis]}{selected.interpretation ? ` · ${selected.interpretation}` : ''}</p>}
          {excerpt && selected ? <><p className="candidate-help">{t('记录', 'Record')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind} · {excerpt.timestamp ?? t('来源时间未知', 'Source time unknown')}</p>
            <pre className="knowledge-source">{excerpt.text.slice(0, selected.selection.start)}<mark>{excerpt.text.slice(selected.selection.start, selected.selection.end)}</mark>{excerpt.text.slice(selected.selection.end)}</pre>
            {source?.status === 'available' && <><p className="candidate-help">{source.window.limitations.join(' ')}</p><details><summary>{t('原始记录及相邻上下文', 'Original record and adjacent context')}</summary>{source.window.records.filter(record => Math.abs(record.recordIndex - excerpt.recordIndex) <= 1).map(record => <pre className="knowledge-source" key={record.recordIndex}>{record.recordIndex}: {record.raw}</pre>)}</details></>}
          </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('此来源不可用，不能核对完整证据。已保存引文仍可阅读。', 'This source is unavailable. Saved quotations remain readable, but full evidence cannot be checked.')}>
            {selected && <blockquote>{selected.selection.quote}</blockquote>}<Button disabled={busy} onClick={onRetry}>{t('重试读取', 'Retry reading')}</Button></Empty>}
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

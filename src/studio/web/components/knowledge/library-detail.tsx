'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Checkbox, Empty, Pagination, Select, Space, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeLibraryDetail } from '../../../view-models/knowledge/knowledge-library';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { displayTime } from '../../../application/display/format';
import { conversationPath } from '../conversation-link';
import { workspaceHref } from '../layout/workspace-link';
import { libraryEntityUrl, libraryUrl } from './library-request';

type Item = KnowledgeLibraryDetail['knowledge'][number];
export type LibraryFilter = 'retain' | 'pending' | 'discard' | 'needs_review';
function time(value: Item['content']['statements'][number]['context']['validDuring'], lang: Language): string {
  if (value.timeKind === 'unknown') return `${lang === 'zh' ? '未知' : 'Unknown'}：${value.reason}`;
  if (value.timeKind === 'not_applicable') return `${lang === 'zh' ? '不适用' : 'Not applicable'}：${value.reason}`;
  if (value.timeKind === 'instant') return displayTime(value.at);
  const bound = (item: typeof value.start) => item.boundKind === 'known' ? displayTime(item.at) : item.boundKind === 'unknown'
    ? `${lang === 'zh' ? '未知' : 'Unknown'}：${item.reason}` : lang === 'zh' ? '无边界' : 'Unbounded';
  return `${bound(value.start)} → ${bound(value.end)}`;
}
export function LibraryKnowledgeItem({ item, workspace, lang, selectable, selected, selectionFull, onSelect }: {
  item: Item; workspace: string; lang: Language; selectable: boolean; selected: boolean; selectionFull: boolean; onSelect(value: boolean): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const href = `${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ workspace, id: item.knowledgeId, revision: item.revisionId })}`;
  return <section className="library-knowledge-item">
    <Space wrap>{selectable && <Checkbox aria-label={t(`选择知识：${item.title}`, `Select knowledge: ${item.title}`)} disabled={selectionFull && !selected} checked={selected} onChange={event => onSelect(event.target.checked)}/>}
      <h3><Link href={href}>{item.title}</Link></h3><Tag>{({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[item.content.organization.knowledgeKind]}</Tag>
      <Tag>{item.choice === 'retain' ? t('已保留', 'Retained') : item.choice === 'discard' ? t('已舍弃', 'Discarded') : t('待核对', 'Pending')}</Tag></Space>
    {item.associationStatus === 'needs_review' && <Alert type="warning" title={t('知识绑定的实体修订与组织确认不一致。先核对关联，再将其归属此对象。', 'Knowledge and confirmed entity revisions differ. Review the link before attributing it to this object.')}/>}
    {item.sourceStatus === 'unavailable' && <Alert type="warning" title={t('原文不可用；以下为已保存知识，依据无法完整核对。', 'Source unavailable. Saved knowledge remains, but evidence cannot be fully reviewed.')}/>}
    <p className="candidate-help">{t('保留和知识类型不代表真实性已验证；各条主张须核对来源与适用范围。', 'Retention and knowledge type do not verify truth. Review evidence and scope for each claim.')}</p>
    {item.content.organization.knowledgeKind === 'case' && <><p>{item.content.organization.situation}</p>
      {!!item.content.organization.gaps.length && <p>{t('案例缺口：', 'Case gaps: ')}{item.content.organization.gaps.join('；')}</p>}</>}
    {item.content.organization.knowledgeKind === 'method' && <p>{t('方法目的：', 'Method purpose: ')}{item.content.organization.purpose}</p>}
    {item.content.statements.map(statement => {
      const name = (id: string) => item.entities.find(entity => entity.entityId === id)?.label ?? t('对象不可读', 'Entity unavailable');
      return <section className="library-claim" key={statement.statementId}>
        {item.content.organization.knowledgeKind === 'case' && item.content.organization.actionStatementIds.includes(statement.statementId) && <Tag>{t('行动', 'Action')}</Tag>}
        {item.content.organization.knowledgeKind === 'case' && item.content.organization.outcomeStatementIds.includes(statement.statementId) && <Tag>{t('结果', 'Outcome')}</Tag>}
        {item.content.organization.knowledgeKind === 'method' && item.content.organization.instructionStatementIds.includes(statement.statementId) && <Tag>{t('方法步骤', 'Instruction')}</Tag>}
        <p><strong>{statement.polarity === 'negative' && <Tag>{t('否定主张', 'Negative claim')}</Tag>}{name(statement.subject.entityId)} · {statement.relation}{statement.object ? ` · ${name(statement.object.entityId)}` : ''}</strong></p>
        <p>{statement.context.scenario}</p>
        <dl><dt>{t('条件', 'Conditions')}</dt><dd>{statement.context.conditions.join('；') || t('未记录额外条件，不代表普遍适用', 'No additional conditions recorded; not universally applicable')}</dd>
          <dt>{t('例外', 'Exceptions')}</dt><dd>{statement.context.exceptions.join('；') || '—'}</dd>
          <dt>{t('未知', 'Unknowns')}</dt><dd>{statement.context.unknowns.join('；') || '—'}</dd></dl>
        <details><summary>{t('时间、主张分类与依据', 'Time, claim classification, and evidence')}</summary>
          <p>{t('发生时间：', 'Occurrence: ')}{time(statement.context.occurredDuring, lang)}</p><p>{t('适用时间：', 'Validity: ')}{time(statement.context.validDuring, lang)}</p>
          <Tag>{({ descriptive: t('描述', 'Description'), normative: t('规范要求', 'Normative requirement'), capability: t('能力', 'Capability'), permission: t('许可', 'Permission') })[statement.modality]}</Tag>
          {item.evidence.filter(link => link.statementIds.includes(statement.statementId)).map((link, index) => <p key={index}>
            <Tag>{({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[link.basis]}</Tag>
            {({ supports: t('支持', 'Supports'), opposes: t('反对', 'Opposes'), background: t('背景', 'Background') })[link.relation]}：{link.interpretation}</p>)}
          <Link href={href}>{t('核对精确原文与知识修订', 'Inspect exact evidence and knowledge revision')}</Link>
        </details>
      </section>;
    })}
    {!!item.tags.length && <p>{item.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</p>}
    <Space wrap><Link href={href}>{t('核对、维护与查看知识历史', 'Review, maintain, and inspect knowledge history')}</Link>
      {item.bindings.map(ref => <Link key={`${ref.analysisId}:${ref.entityId}`} href={libraryEntityUrl(workspace, ref)}>{t('查看知识实际绑定的实体', 'Inspect the bound entity')}</Link>)}</Space>
    <p className="candidate-help">{displayTime(item.revisedAt)} · {t(`${item.revisionCount} 版知识`, `${item.revisionCount} knowledge revisions`)}</p>
  </section>;
}

export function LibraryObjectDetail({ detail, workspace, lang, filter, onFilter, selected, onSelect, onRevision }: {
  detail: KnowledgeLibraryDetail; workspace: string; lang: Language; filter: LibraryFilter; onFilter(value: LibraryFilter): void;
  selected: string[]; onSelect(id: string, value: boolean): void; onRevision(id: string): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filter, detail.revision.revisionId]);
  const historical = detail.revision.revisionId !== detail.history.writeHeadRevisionId;
  const items = detail.knowledge.filter(item => filter === 'needs_review' ? item.associationStatus === 'needs_review'
    : item.associationStatus === 'matched' && item.choice === (filter === 'pending' ? null : filter));
  return <article className="entity-library-article library-object-detail">
    <h2>{detail.revision.draft.label}</h2><p>{detail.revision.draft.description}</p>
    <p className="candidate-help">{t('简介由用户维护；知识与来源判断分别保留。', 'User-maintained description; knowledge and source judgments remain separate.')}</p>
    {historical && <Alert type="info" title={t('正在查看组织历史；下方仍为知识当前修订，不是过去时点的完整知识快照。', 'Viewing organization history with current knowledge, not a complete historical knowledge snapshot.')}/>}
    <details><summary>{t('来源实体与组织历史', 'Source entities and organization history')}</summary>
      <label className="entity-history-label">{t('组织修订', 'Organization revision')}<Select aria-label={t('组织修订', 'Organization revision')} value={detail.revision.revisionId} onChange={onRevision}
        options={detail.history.revisions.map((revision, index) => ({ value: revision.revisionId, label: `${index + 1} · ${displayTime(revision.revisedAt)} · ${revision.reason}` }))}/></label>
      <p>{displayTime(detail.revision.revisedAt)} · {detail.revision.revisedBy.actorId} · {detail.revision.reason}</p>
      {!detail.members.length && <p>{t('当前没有来源关联；旧关联仍在历史中。', 'No current source links; previous links remain in history.')}</p>}
      {detail.members.map(member => <section className="entity-mention" key={`${member.analysisId}:${member.entityId}`}>
        <Link href={libraryEntityUrl(workspace, member)}>{member.status === 'available' ? member.entity.label : t('来源实体不可读', 'Source entity unavailable')}</Link><p>{member.rationale}</p>
        {member.status === 'available' ? <>
          {!member.current && <Alert type="warning" title={t('实体已有新修订。更新组织关联前须重新核对；旧绑定仍保留。', 'Entity has a new revision. Review before updating the organization link; old bindings remain.')}/>}
          {member.sourceStatus === 'unavailable' && <Alert type="warning" title={t('原文不可用，暂不能增加或更新来源关联。', 'Source unavailable; adding or updating source links is unavailable.')}/>}
          {member.origin && <Link href={workspaceHref(conversationPath(member.origin.threadId), workspace)}>{member.origin.title || t('来源对话', 'Source conversation')}</Link>}
          <p>{member.entity.qualifiers.join(' · ')}</p>
          {member.evidence.map(evidence => <div key={evidence.mentionId}><p><q>{evidence.quote}</q> · {evidence.rationale}
            <Tag>{evidence.basis === 'explicit' ? t('明确提及', 'Explicit mention') : t('推断对应', 'Inferred assignment')}</Tag></p>
            {evidence.positionStatus === 'mismatch' && <Alert type="warning" title={t('提及与当前来源不匹配，不能当作已核对。', 'Mention no longer matches the source; it is not verified.')}/>}</div>)}
        </> : <Alert type="warning" title={t('只能回看保存的关联；来源身份不可完整核对。', 'Saved link remains; source identity cannot be fully inspected.')}/>}
      </section>)}
    </details>
    {!!detail.relatedEntities.length && <details><summary>{t('知识涉及的其它对象', 'Other entities in this knowledge')}</summary><Space wrap>
      {detail.relatedEntities.map(entity => <Link key={`${entity.analysisId}:${entity.entityId}:${entity.entityRevisionId}`} href={entity.object
        ? libraryUrl(workspace, entity.object.objectId) : libraryEntityUrl(workspace, entity)}>{entity.object?.label ?? entity.label}</Link>)}</Space></details>}
    <h3>{t('积累的知识', 'Accumulated knowledge')}</h3>
    <Select aria-label={t('知识状态', 'Knowledge status')} value={filter} onChange={onFilter} options={[
      { value: 'retain', label: t(`已保留 ${detail.counts.retained ?? '—'}`, `Retained ${detail.counts.retained ?? '—'}`) },
      { value: 'pending', label: t(`待核对 ${detail.counts.pending ?? '—'}`, `Pending ${detail.counts.pending ?? '—'}`) },
      { value: 'discard', label: t(`已舍弃 ${detail.counts.discarded ?? '—'}`, `Discarded ${detail.counts.discarded ?? '—'}`) },
      { value: 'needs_review', label: t(`关联待核对 ${detail.counts.needsReview ?? '—'}`, `Association review ${detail.counts.needsReview ?? '—'}`) },
    ]}/>
    {detail.knowledgeStatus === 'unavailable' ? <Alert type="warning" title={t('知识集合不可读，数量未知。修复后再选择知识。', 'Knowledge unavailable; counts are unknown. Restore access before selecting knowledge.')}/>
      : !items.length ? <Empty description={filter === 'retain' ? t('尚无已保留知识。可查看待核对内容，或从来源继续提炼。', 'No retained knowledge. Review pending items or extract from sources.') : t('此状态下没有知识。', 'No knowledge with this status.')}><Link href={`${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ workspace })}`}>{t('查看或提炼知识', 'Review or extract knowledge')}</Link></Empty>
        : items.slice((Math.min(page, Math.ceil(items.length / 10)) - 1) * 10, Math.min(page, Math.ceil(items.length / 10)) * 10).map(item => <LibraryKnowledgeItem key={item.knowledgeId} item={item} workspace={workspace} lang={lang}
          selectable={!historical && filter === 'retain'} selectionFull={selected.length >= 100} selected={selected.includes(item.knowledgeId)} onSelect={value => onSelect(item.knowledgeId, value)}/>)}
    {items.length > 10 && <Pagination size="small" current={Math.min(page, Math.ceil(items.length / 10))} pageSize={10} total={items.length} showSizeChanger={false} onChange={setPage}/>}
  </article>;
}

'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Select } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeLibraryDetail } from '../../../view-models/knowledge/knowledge-library';
import { displayTime } from '../../../application/display/format';
import { candidateDecisionLabel } from '../../../application/knowledge/candidate-status';
import { conversationPath } from '../conversation-link';
import { workspaceHref } from '../layout/workspace-link';
import { libraryEntityUrl, libraryUrl } from './library-request';

export function LibraryObjectDetail({ detail, workspace, lang, onRevision, onKnowledge, footer, initialTab = 'knowledge' }: {
  detail: KnowledgeLibraryDetail; workspace: string; lang: Language; onRevision(id: string): void; onKnowledge(id: string): void;
  footer?: ReactNode; initialTab?: 'knowledge' | 'sources' | 'history';
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [tab, setTab] = useState(initialTab);
  const historical = detail.revision.revisionId !== detail.history.writeHeadRevisionId;
  return <article className="knowledge-reader library-object-detail">
    <header className="knowledge-reader-heading"><h2>{detail.revision.draft.label}</h2>
      <p className="knowledge-reader-meta">{detail.knowledgeStatus === 'available' ? t(`${detail.knowledge.length} 条关联知识`, `${detail.knowledge.length} associated items`) : t('知识集合不可读，数量未知', 'Knowledge unavailable; counts unknown')} · {t(`${detail.members.length} 个来源关联`, `${detail.members.length} source links`)}</p>
      <nav className="knowledge-reader-tabs" aria-label={t('对象详情视图', 'Object detail view')}>
        {([{ key: 'knowledge', label: t('相关知识', 'Related knowledge') }, { key: 'sources', label: t('来源关联', 'Source links') }, { key: 'history', label: t('组织历史', 'Organization history') }] as const).map(item => <button type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>{item.label}</button>)}
      </nav></header>
    <div className="knowledge-reader-scroll"><div className="knowledge-reading">
      {historical && <Alert type="info" title={t('正在查看组织历史；相关知识仍为当前修订，不是过去时点的完整知识快照。', 'Viewing organization history with current knowledge, not a complete historical knowledge snapshot.')}/>}
      {tab === 'knowledge' && <><p>{detail.revision.draft.description}</p><p className="candidate-help">{t('简介由用户维护；知识与来源判断分别保留。', 'User-maintained description; knowledge and source judgments remain separate.')}</p>
        {detail.knowledgeStatus === 'unavailable' ? <Alert type="warning" title={t('知识集合不可读，数量未知。修复后再查看。', 'Knowledge unavailable; counts unknown. Restore access to continue.')}/>
          : !detail.knowledge.length ? <Empty description={t('尚无关联知识。核对来源关联或继续提炼。', 'No associated knowledge. Review source links or extract more knowledge.')}/>
            : detail.knowledge.map(item => <section className="knowledge-object-item" key={item.knowledgeId}><Button type="link" onClick={() => onKnowledge(item.knowledgeId)}>{item.title}</Button>
              <span>{candidateDecisionLabel(item.choice, lang)}</span>{item.associationStatus === 'needs_review' && <Alert type="warning" title={t('知识绑定的实体修订与组织确认不一致，需核对关联。', 'Knowledge and confirmed entity revisions differ; review the association.')}/>}
              {item.sourceStatus === 'unavailable' && <p className="candidate-help">{t('原文不可用；知识仍保留。', 'Source unavailable; knowledge remains.')}</p>}</section>)}
        {!!detail.relatedEntities.length && <details><summary>{t('知识涉及的其它对象', 'Other entities in this knowledge')}</summary>
          {detail.relatedEntities.map(entity => <p key={`${entity.analysisId}:${entity.entityId}:${entity.entityRevisionId}`}><Link href={entity.object ? libraryUrl(workspace, entity.object.objectId) : libraryEntityUrl(workspace, entity)}>{entity.object?.label ?? entity.label}</Link></p>)}</details>}
      </>}
      {tab === 'sources' && <>
        {!detail.members.length && <Empty description={t('当前没有来源关联；旧关联仍在组织历史中。', 'No current source links; previous links remain in organization history.')}/>}
        {detail.members.map(member => <section className="knowledge-statement" key={`${member.analysisId}:${member.entityId}`}>
          <Link href={libraryEntityUrl(workspace, member)}>{member.status === 'available' ? member.entity.label : t('来源实体不可读', 'Source entity unavailable')}</Link><p>{member.rationale}</p>
          {member.status === 'available' ? <>
            {!member.current && <Alert type="warning" title={t('实体已有新修订。更新组织关联前需核对身份。', 'Entity has a new revision. Review identity before updating the organization link.')}/>}
            {member.sourceStatus === 'unavailable' && <Alert type="warning" title={t('原文不可用，不能完整核对身份。', 'Source unavailable; identity cannot be fully reviewed.')}/>}
            {member.origin && <Link href={workspaceHref(conversationPath(member.origin.threadId), workspace)}>{member.origin.title || t('来源对话', 'Source conversation')}</Link>}
            <p>{member.entity.qualifiers.join(' · ')}</p>
            {member.evidence.map(evidence => <div key={evidence.mentionId}><blockquote>{evidence.quote}</blockquote><p>{evidence.rationale} · {evidence.basis === 'explicit' ? t('明确提及', 'Explicit mention') : t('推断对应', 'Inferred assignment')}</p>
              {evidence.positionStatus === 'mismatch' && <Alert type="warning" title={t('提及与当前来源不匹配，不能当作已核对。', 'Mention no longer matches the source; it is not verified.')}/>}</div>)}
          </> : <Alert type="warning" title={t('只能回看保存的关联；来源身份不可完整核对。', 'Saved link remains; source identity cannot be fully inspected.')}/>}
          <details><summary>{t('精确来源身份', 'Exact source identity')}</summary><code>{member.analysisId} / {member.entityId} / {member.entityRevisionId}</code></details>
        </section>)}
      </>}
      {tab === 'history' && <><label className="knowledge-field">{t('组织修订', 'Organization revision')}<Select aria-label={t('组织修订', 'Organization revision')} value={detail.revision.revisionId} onChange={onRevision} options={detail.history.revisions.map((revision, index) => ({ value: revision.revisionId, label: `${index + 1} · ${displayTime(revision.revisedAt)} · ${revision.reason}` }))}/></label>
        <p>{displayTime(detail.revision.revisedAt)} · {detail.revision.revisedBy.actorId}</p><p>{detail.revision.reason}</p>
        <p className="candidate-help">{t('组织修订不覆盖知识内容、来源或维护决定。', 'Organization revisions do not overwrite knowledge, sources, or maintenance decisions.')}</p>
        <details><summary>{t('精确组织身份', 'Exact organization identity')}</summary><code>{detail.history.objectId} / {detail.revision.revisionId}</code></details>
      </>}
    </div></div>
    {footer && <footer className="knowledge-reader-footer">{footer}</footer>}
  </article>;
}

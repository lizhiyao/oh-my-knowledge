'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Select, Space, Tag, Typography } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { displayTime } from '../../../application/display/format';
import { candidateDecisionLabel } from '../../../application/knowledge/candidate-status';

export function CandidateStatementHeading({ statement, entities, lang }: {
  statement: Pick<KnowledgeCandidateDetail['revision']['content']['statements'][number], 'subject' | 'object' | 'relation' | 'polarity'>;
  entities: Pick<KnowledgeCandidateDetail['revision']['entities'][number], 'entityId' | 'label'>[]; lang: Language;
}) {
  return <h3>{statement.polarity === 'negative' && <Tag>{lang === 'zh' ? '否定陈述' : 'Negative claim'}</Tag>}
    {entities.find(entity => entity.entityId === statement.subject.entityId)?.label} {statement.relation} {statement.object ? entities.find(entity => entity.entityId === statement.object!.entityId)?.label : ''}
  </h3>;
}

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

/** Both entry points read the same exact revision; only their available actions differ. */
export function KnowledgeReader({ detail, lang, busy = false, header, tools, footer, onRevision, onEntities, onApplyEntities, onDeleteSource, onRetry }: {
  detail: KnowledgeCandidateDetail; lang: Language; busy?: boolean; header?: ReactNode; tools?: ReactNode; footer?: ReactNode;
  onRevision(revision: string): void; onEntities?(): void; onApplyEntities?(): void; onDeleteSource?(snapshot: string): void; onRetry(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [tab, setTab] = useState('body'); const [citation, setCitation] = useState(0);
  useEffect(() => { setTab('body'); setCitation(0); }, [detail.revision.knowledgeId, detail.revision.revisionId]);
  const selections = [...detail.grounding.citations.map(item => ({ selection: item.selection, label: t('陈述依据', 'Statement evidence') })),
    ...detail.grounding.mentions.map(item => ({ selection: item.selection, label: t('实体提及', 'Entity mention') }))];
  const selected = selections[citation];
  const source = detail.sources.find(entry => entry.status === 'available' && entry.window.excerpts.some(excerpt => excerpt.evidenceRef === selected?.selection.evidenceRef));
  const excerpt = source?.status === 'available' ? source.window.excerpts.find(item => item.evidenceRef === selected?.selection.evidenceRef) : undefined;
  const organization = detail.revision.content.organization;
  type Time = KnowledgeCandidateDetail['revision']['content']['statements'][number]['context']['occurredDuring'];
  function time(value: Time): string {
    if (value.timeKind === 'unknown') return `${t('未知', 'Unknown')}：${value.reason}`;
    if (value.timeKind === 'not_applicable') return `${t('不适用', 'Not applicable')}：${value.reason}`;
    if (value.timeKind === 'instant') return displayTime(value.at);
    const bound = (item: typeof value.start) => item.boundKind === 'known' ? displayTime(item.at) : item.boundKind === 'unbounded' ? t('无界限', 'Unbounded') : `${t('未知', 'Unknown')}：${item.reason}`;
    return `${bound(value.start)} → ${bound(value.end)}`;
  }
  const tabs = [{ key: 'body', label: t('正文', 'Content') }, { key: 'evidence', label: t('依据', 'Evidence') }, { key: 'history', label: t('修订历史', 'Revision history') }];
  return <article className="knowledge-reader">
    <header className="knowledge-reader-heading">
      <CandidateDecisionHeader title={detail.revision.title} maintenance={detail.maintenance} lang={lang}/>
      <div className="knowledge-reader-meta"><span>{({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[organization.knowledgeKind]}</span>
        <span>{t(`${detail.revision.content.statements.length} 项陈述`, `${detail.revision.content.statements.length} statements`)}</span>
        {detail.revision.revisionId !== detail.history.writeHeadRevisionId && <span>{t('历史知识修订', 'Historical knowledge revision')}</span>}</div>
      {header}
      <nav className="knowledge-reader-tabs" aria-label={t('知识阅读视图', 'Knowledge reading view')}>
        {tabs.map(item => <button type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>{item.label}</button>)}
      </nav>
    </header>
    <div className="knowledge-reader-scroll" key={`${detail.revision.knowledgeId}/${detail.revision.revisionId}/${tab}`}>
      <div className="knowledge-reading">
        {tab === 'body' && <>
          {detail.sources.some(entry => entry.status === 'unavailable') && <Alert type="warning" title={t('来源不可用；已保存知识可读，依据无法完整核对。', 'Source unavailable. Saved knowledge remains readable; evidence cannot be fully reviewed.')} action={<Button disabled={busy} onClick={onRetry}>{t('重试读取', 'Retry reading')}</Button>}/>}
          {organization.knowledgeKind === 'case' && <><p>{organization.situation}</p><p>{t('案例缺口', 'Case gaps')}：{organization.gaps.join('；') || t('未列出', 'None listed')}</p></>}
          {organization.knowledgeKind === 'method' && <p>{t('方法目的', 'Method purpose')}：{organization.purpose}</p>}
          {detail.revision.content.statements.map(statement => <section key={statement.statementId} className="knowledge-statement">
            <CandidateStatementHeading statement={statement} entities={detail.revision.entities} lang={lang}/>
            <p>{statement.context.scenario}</p>
            <dl><dt>{t('条件', 'Conditions')}</dt><dd>{statement.context.conditions.join('；') || t('未记录附加条件，不代表普遍适用', 'No additional conditions recorded; not universally applicable')}</dd>
              <dt>{t('例外', 'Exceptions')}</dt><dd>{statement.context.exceptions.join('；') || '—'}</dd>
              <dt>{t('未知信息', 'Unknowns')}</dt><dd>{statement.context.unknowns.join('；') || '—'}</dd></dl>
            <details><summary>{t('陈述分类与时间', 'Claim classification and time')}</summary>
              <p>{({ descriptive: t('描述', 'Description'), normative: t('规范要求', 'Normative requirement'), capability: t('能力', 'Capability'), permission: t('许可', 'Permission') })[statement.modality]}</p>
              {organization.knowledgeKind === 'case' && organization.actionStatementIds.includes(statement.statementId) && <p>{t('行动', 'Action')}</p>}
              {organization.knowledgeKind === 'case' && organization.outcomeStatementIds.includes(statement.statementId) && <p>{t('结果', 'Outcome')}</p>}
              {organization.knowledgeKind === 'method' && organization.instructionStatementIds.includes(statement.statementId) && <p>{t('方法步骤', 'Instruction')}</p>}
              <p>{t('发生／适用时间', 'Occurrence / validity')}：{time(statement.context.occurredDuring)} / {time(statement.context.validDuring)}</p>
            </details>
            {detail.revision.evidence.filter(link => link.statementIds.includes(statement.statementId)).map(link => <div className="knowledge-evidence-link" key={link.evidenceLinkId}>
              <Button type="link" disabled={busy} onClick={() => { setCitation(Math.max(0, detail.grounding.citations.findIndex(item => item.evidenceLinkId === link.evidenceLinkId))); setTab('evidence'); }}>{t('核对原始依据', 'Inspect original evidence')}</Button>
              <span>{({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[link.basis]} · {({ supports: t('支持', 'Supports'), opposes: t('反对', 'Opposes'), background: t('背景', 'Background') })[link.relation]}：{link.interpretation}</span>
            </div>)}
          </section>)}
          <details><summary>{t('复用说明与实体', 'Reuse notes and entities')}</summary><p>{detail.grounding.reuseRationale}</p>
            {detail.grounding.identityUncertainties.map((item, index) => <Alert key={index} type="warning" title={item}/>)}
            {detail.grounding.entityAnalysisRef && <Space wrap>{onEntities && <Button disabled={busy} onClick={onEntities}>{t('核对绑定的实体修订', 'Inspect bound entity revision')}</Button>}
              {onApplyEntities && <Button disabled={busy || detail.revision.revisionId !== detail.history.writeHeadRevisionId} onClick={onApplyEntities}>{t('应用实体最新修订', 'Apply current entity revision')}</Button>}</Space>}
            {detail.grounding.mentions.map((mention, index) => <div key={mention.mentionId}><p><strong>{detail.revision.entities.find(entity => entity.entityId === mention.entityId)?.label}</strong> ← {mention.selection.quote}：{mention.rationale} ({mention.basis === 'explicit' ? t('明确提及', 'Explicit mention') : t('推断', 'Inference')})</p>
              <Button type="link" onClick={() => { setCitation(detail.grounding.citations.length + index); setTab('evidence'); }}>{t('核对原文提及', 'Inspect original mention')}</Button></div>)}
          </details>
          {!!detail.tagging.tags.length && <p className="candidate-help">{detail.tagging.tags.join(' · ')}</p>}
        </>}
        {tab === 'evidence' && <>
          <h3>{t('原始依据', 'Source evidence')}</h3>
          <Select aria-label={t('证据片段', 'Evidence excerpt')} value={citation} style={{ width: '100%' }} options={selections.map((item, index) => ({ value: index, label: `${item.label} · ${item.selection.quote.slice(0, 90)}` }))} onChange={setCitation}/>
          {excerpt && selected ? <><p className="candidate-help">{t('记录', 'Record')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind} · {excerpt.timestamp ?? t('时间未知', 'Time unknown')}</p>
            <pre className="knowledge-source">{excerpt.text.slice(0, selected.selection.start)}<mark>{excerpt.text.slice(selected.selection.start, selected.selection.end)}</mark>{excerpt.text.slice(selected.selection.end)}</pre>
            {source?.status === 'available' && <><p className="candidate-help">{source.window.limitations.join(' ')}</p><details><summary>{t('原始记录及相邻上下文', 'Original record and adjacent context')}</summary>{source.window.records.filter(record => Math.abs(record.recordIndex - excerpt.recordIndex) <= 1).map(record => <pre className="knowledge-source" key={record.recordIndex}>{record.recordIndex}: {record.raw}</pre>)}</details></>}
          </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('此来源不可用，不能核对完整证据。', 'This source is unavailable; full evidence cannot be checked.')}><Button disabled={busy} onClick={onRetry}>{t('重试读取', 'Retry reading')}</Button></Empty>}
          {detail.sources.map((entry, index) => entry.status === 'unavailable' ? <Alert key={index} type="warning" title={`${t('来源不可用', 'Source unavailable')}: ${entry.reason}`}/>
            : onDeleteSource && <Button key={index} danger size="small" disabled={busy} onClick={() => onDeleteSource(entry.window.snapshotId)}>{t('删除来源快照', 'Delete source snapshot')}</Button>)}
        </>}
        {tab === 'history' && <>
          <h3>{t('修订历史', 'Revision history')}</h3>
          <Select aria-label={t('历史修订', 'Revision history')} value={detail.revision.revisionId} disabled={busy} style={{ width: '100%' }} options={detail.history.revisions.map((revision, i) => ({ value: revision.revisionId, label: `${i + 1} · ${revision.title}` }))} onChange={onRevision}/>
          <p>{displayTime(detail.revision.revisedAt)} · {detail.revision.revisedBy.actorId}</p><p>{detail.revision.revisionReason}</p>
          <details><summary>{t('精确知识身份', 'Exact knowledge identity')}</summary><p><code>{detail.revision.knowledgeId} / {detail.revision.revisionId}</code></p></details>
          <h3>{t('维护决定', 'Maintenance decisions')}</h3>
          {detail.history.maintenance.filter(item => item.revisionId === detail.revision.revisionId).map((item, index) => <p key={index}>{candidateDecisionLabel(item.choice, lang)} · {item.reason} · {displayTime(item.at)} · {item.actor.actorId}</p>)}
          {tools && <details><summary>{t('维护主题标签', 'Maintain topic tags')}</summary>{tools}</details>}
        </>}
      </div>
    </div>
    {footer && <footer className="knowledge-reader-footer">{footer}</footer>}
  </article>;
}

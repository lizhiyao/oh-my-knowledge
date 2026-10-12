'use client';
import Link from 'next/link';
import { Alert, Collapse, Tag } from 'antd';
import type { CarrierKnowledgeReview, CarrierReviewSummary, ReviewedCarrierDraft } from '../../../view-models/knowledge/artifact-authoring';
import type { Language } from '../layout/shell';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';

export function CarrierReviewStatus({ review, lang }: { review: CarrierReviewSummary; lang: Language }) {
  return <Tag color={review.needsReviewCount ? 'warning' : 'default'}>{lang === 'zh' ? review.needsReviewCount ? `${review.needsReviewCount} 条需复核` : '未发现引用变化' : review.needsReviewCount ? `${review.needsReviewCount} need review` : 'No reference changes detected'}</Tag>;
}

export function CarrierKnowledgeReviewPanel({ review, workspace, lang }: { review: CarrierKnowledgeReview; workspace: string; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const reasons = { revision_changed: t('已有新修订', 'New revision available'), not_retained: t('当前修订未保留', 'Current revision is not retained'), source_unavailable: t('来源不可用', 'Source unavailable'), incorporated_unavailable: t('旧知识修订不可用', 'Incorporated revision unavailable'), current_unavailable: t('当前知识不可用', 'Current knowledge unavailable') };
  const fields = { title: t('标题', 'Title'), statements: t('陈述与适用条件', 'Statements and conditions'), organization: t('组织形式', 'Organization'), entities: t('实体', 'Entities'), evidence: t('依据', 'Evidence'), grounding: t('来源与引用', 'Sources and citations') };
  const changed = review.checks.filter(check => check.reasons.length);
  const href = (id: string, revision: string) => workspaceHref(`${KNOWLEDGE_CANDIDATES_PATH}?id=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision)}`, workspace);
  return <div className="carrier-knowledge-review">
    <Alert type={changed.length ? 'warning' : 'info'} showIcon title={t(changed.length ? `${changed.length} 条引用知识需要复核；尚未更新载体。` : '未发现已引用知识的变化。', changed.length ? `${changed.length} references need review; the artifact has not been updated.` : 'No changes detected in incorporated knowledge.')} />
    <p>{t('仅核对本版本已引用知识的当前修订、保留状态与来源；未覆盖未引用的新知识，不判断内容真伪或语义过时。重新读取可刷新检查。', 'Checks current revisions, retention and sources of this version’s references. Unreferenced new knowledge is outside this check; this does not assess truth or semantic expiry. Reload to refresh.')}</p>
    <p>{t('检查时间', 'Checked at')}：{review.checkedAt}</p>
    <Collapse defaultActiveKey={changed.length ? [`${changed[0].knowledgeId}/${changed[0].incorporatedRevisionId}`] : []} items={changed.map(check => ({ key: `${check.knowledgeId}/${check.incorporatedRevisionId}`, label: <span>{check.title} · {check.reasons.map(reason => reasons[reason]).join('；')}</span>, children: <>
      <p>{t('当前维护状态', 'Current maintenance')}：{check.currentRevisionId ? check.currentChoice === 'retain' ? t('保留', 'Retained') : check.currentChoice === 'discard' ? t('舍弃', 'Discarded') : t('未作保留决定', 'No retain decision') : t('无法读取', 'Unavailable')}</p>
      {check.changedFields.length > 0 && <p>{t('变化范围', 'Changed fields')}：{check.changedFields.map(field => fields[field]).join('；')}</p>}
      <div className="carrier-revision-comparison">
        <section><h3>{t('载体引用的旧修订', 'Incorporated revision')}</h3><Link href={href(check.knowledgeId, check.incorporatedRevisionId)}>{check.incorporatedRevisionId}</Link><pre>{check.incorporatedContent ?? t('无法读取；载体历史内容仍可回看。', 'Unavailable; historical artifact content remains readable.')}</pre></section>
        <section><h3>{t('知识当前修订', 'Current knowledge revision')}</h3>{check.currentRevisionId && <Link href={href(check.knowledgeId, check.currentRevisionId)}>{check.currentRevisionId}</Link>}<pre>{check.currentContent ?? t('当前知识无法读取，不能视为没有变化。', 'Current knowledge is unavailable; this is not evidence of no changes.')}</pre></section>
      </div>
    </> }))}/>
  </div>;
}

export function CarrierSelectionReview({ changes, lang }: { changes: ReviewedCarrierDraft['selectionChanges']; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const labels = { added: t('新增', 'Added'), replaced: t('替换修订', 'Revision replaced'), removed: t('移除', 'Removed'), kept: t('沿用修订', 'Revision kept') };
  return <div className="carrier-selection-review"><h3>{t('本次引用变化', 'Reference changes in this update')}</h3><ul>{changes.map(change => <li key={change.knowledgeId}><strong>{labels[change.changeKind]} · {change.title}</strong><p>{t('旧引用', 'Previous references')}：{change.previousRevisionIds.join('；') || t('无', 'None')} → {t('本次引用', 'Selected revision')}：{change.selectedRevisionId ?? t('无', 'None')}</p></li>)}</ul></div>;
}

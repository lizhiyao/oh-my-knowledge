'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Space } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import { reviewBodyRef, reviewProjectionRef, useKnowledgeReviewStatus } from './review-request';
import { KnowledgeReviewDrawer } from './review-drawer';

/** A separate read failure is visible without hiding the saved knowledge or its sources. */
export function KnowledgeReviewSummary({ detail, workspace, lang, onOpen }: { onOpen?(): void; detail: KnowledgeCandidateDetail; workspace?: string; lang: Language }) {
  const ref = reviewBodyRef(detail), review = useKnowledgeReviewStatus(workspace, ref, reviewProjectionRef(detail));
  const [editing, setEditing] = useState<KnowledgeCandidateDetail>();
  useEffect(() => setEditing(undefined), [workspace, ref.knowledgeId, ref.revisionId, ref.bodyDigest]);
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  if (!workspace) return null;
  const status = review.status;
  return <section className="knowledge-review-summary" aria-label={t('此正文修订的复核状态','Review state for this content revision')}>
    <Space wrap><strong>{t('内容与关联覆盖','Content and association coverage')}</strong><Button size="small" onClick={()=>onOpen ? onOpen() : setEditing(structuredClone(detail))}>{t('独立复核与使用记录','Review and record use')}</Button></Space>
    {review.loading&&!status?<p className="candidate-help">{t('正在读取独立复核记录…','Reading independent review records…')}</p>:review.failed||!status?<Alert type="warning" title={t('复核状态未能读取，不能判断是否已有意见；正文仍可读。','Review state could not be read; existing opinions are unknown. Content remains readable.')} action={<Button onClick={review.reload}>{t('重读复核','Reload reviews')}</Button>}/>:<>
      <p>{t('内容复核：','Content review: ')}{({not_reviewed:t('尚未复核','Not reviewed'),needs_revision:t('需要修订，仍有未解除意见','Needs revision; unresolved opinions remain'),reviewed_with_limits:t('已复核，保留限制','Reviewed with limits'),unavailable:t('记录不可读，状态未知','Ledger unavailable; state unknown')})[status.content.status]}</p>
      {status.content.status==='needs_revision'&&<ul className="candidate-help">{status.content.events.filter(event=>event.status==='needs_revision').flatMap(event=>event.findings.map((finding,index)=><li key={`${event.eventId}/${index}`}>{finding.description}</li>))}</ul>}
      {status.content.status==='reviewed_with_limits'&&<ul className="candidate-help">{status.content.events.flatMap(event=>event.limitations.map((limit,index)=><li key={`${event.eventId}/${index}`}>{limit}</li>))}</ul>}
      <p className="candidate-help">{status.coverage.status==='unavailable'?t('关联覆盖：投影或记录不可读，范围未知。','Association coverage: projection or ledger unavailable; scope unknown.'):t(`逐段覆盖：${status.coverage.decisions.filter(decision=>decision.status==='gap').length} 段有缺口，${status.coverage.decisions.filter(decision=>decision.status==='unknown').length} 段尚未评估或意见不一致。`,`Segment coverage: ${status.coverage.decisions.filter(decision=>decision.status==='gap').length} gaps; ${status.coverage.decisions.filter(decision=>decision.status==='unknown').length} unassessed or conflicting.`)}</p>
      <details><summary>{t('查看逐段覆盖与使用信号','Inspect segment coverage and use signals')}</summary>{status.coverage.decisions.map((decision,index)=><p key={decision.segmentId}>{t(`段落 ${index+1}：`,`Segment ${index+1}: `)}{({linked:t('已核对关联','Links reviewed'),no_reliable_object:t('无可靠对象','No reliable object'),gap:t('关联缺口','Association gap'),unknown:t('尚未评估或意见不一致','Unassessed or conflicting')})[decision.status]}{decision.opinions.map(opinion=><span key={opinion.eventId}> · {opinion.reason}</span>)}</p>)}
      <p>{t(`此修订记录了 ${status.usage.length} 条使用信号；没有记录不代表没有使用，已有信号也不等于效果已验证。`,`This revision has ${status.usage.length} recorded use signals. No record does not mean unused, and a signal does not establish verified effect.`)}</p></details>
    </>}
    {editing&&<KnowledgeReviewDrawer key={`${workspace}/${ref.knowledgeId}/${ref.revisionId}/${ref.bodyDigest}`} detail={editing} workspace={workspace} lang={lang} onClose={()=>setEditing(undefined)}/>}
  </section>;
}

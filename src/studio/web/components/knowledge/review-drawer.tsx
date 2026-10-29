'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, Select, Skeleton, Space } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { KnowledgeReviewStatus, KnowledgeReviewContentInput, KnowledgeReviewCoverageInput, KnowledgeReviewUseInput, KnowledgeReviewEvent } from '../../../view-models/knowledge/knowledge-reviews';
import type { Language } from '../layout/shell';
import { displayTime } from '../../../application/display/format';
import { KNOWLEDGE_CANDIDATES_PATH, KNOWLEDGE_LIBRARY_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';
import { reviewBodyRef, reviewProjectionRef, useKnowledgeReviewSave, useKnowledgeReviewStatus } from './review-request';
import { KnowledgeReviewEvidence } from './review-evidence';
import { notifyKnowledgeChange } from './workspace';

type ContentFinding = KnowledgeReviewContentInput['findings'][number];
type CoverageInput = KnowledgeReviewCoverageInput['decisions'][number];
type CoverageDecision = Omit<CoverageInput, 'entityRefs'> & { entityRefs: NonNullable<CoverageInput['entityRefs']> };
type Evidence = NonNullable<KnowledgeReviewUseInput['evidence']>[number];
type Mode = 'content' | 'coverage' | 'use';
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
const coverageLabel = (value: string, t: (zh: string, en: string) => string) => ({ linked: t('已核对关联', 'Links reviewed'), no_reliable_object: t('无可靠对象', 'No reliable object'), gap: t('存在关联缺口', 'Association gap'), unknown: t('尚未评估', 'Not assessed') })[value] ?? value;

/** The mounted editor freezes body, projection, sources and ledger CAS independently of later reader refreshes. */
type DrawerProps = {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; initialMode?: Mode; segmentId?: string; query?: string; onClose(): void;
};
export function KnowledgeReviewDrawer(props: DrawerProps) {
  const ref = props.detail.revision;
  return <ReviewDrawerSession key={`${props.workspace}/${ref.knowledgeId}/${ref.revisionId}/${ref.bodyDigest}`} {...props}/>;
}
function ReviewDrawerSession({ detail: initialDetail, workspace, lang, initialMode = 'content', segmentId, query = '', onClose }: DrawerProps) {
  const [detail] = useState(initialDetail), [bodyRef] = useState(() => reviewBodyRef(initialDetail)), [projection] = useState(() => reviewProjectionRef(initialDetail));
  const [locked, setLocked] = useState(false), [baseline, setBaseline] = useState<KnowledgeReviewStatus>();
  const review = useKnowledgeReviewStatus(workspace, bodyRef, projection);
  useEffect(() => { if (!baseline && review.status && review.status.storageStatus !== 'unavailable') setBaseline(review.status); }, [baseline, review.status]);
  const current = baseline ?? review.status;
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <Drawer open title={t('复核知识与记录使用', 'Review knowledge and record use')} size={760} onClose={onClose} closable={!locked} maskClosable={!locked} keyboard={!locked} destroyOnHidden>
    {review.loading && !current ? <Skeleton active/> : !current ? <Alert type="warning" title={t('复核记录未能读取。正文仍可阅读；尚不能判断是否已有意见，也不能写入。', 'Review records could not be read. Content remains readable; existing opinions are unknown and writing is unavailable.')} action={<Button onClick={review.reload}>{t('重新读取复核', 'Reload reviews')}</Button>}/>
      : current.storageStatus === 'unavailable' ? <Alert type="warning" title={t('复核记录不可读，不能当作“未复核”。请先恢复记录；已保存正文不受影响。', 'The review ledger is unavailable, which does not mean unreviewed. Restore the ledger first; saved content is unaffected.')} action={<Button onClick={review.reload}>{t('重新读取复核', 'Reload reviews')}</Button>}/>
      : <ReviewEditor key={`${workspace}/${bodyRef.revisionId}/${projection}`} detail={detail} workspace={workspace} lang={lang} baseline={current} initialMode={initialMode} segmentId={segmentId} query={query} onLockChange={setLocked} onClose={() => { notifyKnowledgeChange(workspace); onClose(); }}/>}
  </Drawer>;
}
function ReviewEditor({ detail, workspace, lang, baseline: initialBaseline, initialMode, segmentId, query: initialQuery, onClose, onLockChange }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; baseline: KnowledgeReviewStatus; initialMode: Mode; segmentId?: string; query: string; onClose(): void; onLockChange(value: boolean): void;
}) {
  const [baseline] = useState(initialBaseline), [requestId] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<Mode>(initialMode), [reason, setReason] = useState(''), [supersedes, setSupersedes] = useState<string[]>([]);
  const [contentStatus, setContentStatus] = useState<'needs_revision' | 'reviewed_with_limits'>('needs_revision'), [limitations, setLimitations] = useState('');
  const [findings, setFindings] = useState<ContentFinding[]>([]);
  const [coverage, setCoverage] = useState<CoverageDecision[]>(() => detail.revision.content.segments.map(segment => ({ segmentId: segment.segmentId, status: 'unknown', reason: '', entityRefs: [] })));
  const [taskRef, setTaskRef] = useState(''), [query, setQuery] = useState(initialQuery), [signal, setSignal] = useState<KnowledgeReviewUseInput['signal']>('provided');
  const [usedSegments, setUsedSegments] = useState<string[]>(segmentId ? [segmentId] : []), [evidenceRefs, setEvidenceRefs] = useState(''), [useEvidence, setUseEvidence] = useState<Evidence[]>([]);
  const [issueKind, setIssueKind] = useState<KnowledgeReviewUseInput['issueKind']>();
  const save = useKnowledgeReviewSave(workspace, baseline.bodyRef, reviewProjectionRef(detail), lang);
  useEffect(() => onLockChange(save.locked), [save.locked, onLockChange]);
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const segments = detail.revision.content.segments, projection = baseline.coverage.projectionRevisionId;
  const sources = baseline.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
  const eligible = mode === 'content' ? baseline.content.events : mode === 'coverage' ? baseline.coverage.events : baseline.usage.filter(event => event.taskRef === taskRef.trim() && event.signal === signal);
  const invalid = !reason.trim() || (mode === 'content' ? contentStatus === 'needs_revision' && !findings.length || contentStatus === 'reviewed_with_limits' && !lines(limitations).length || findings.some(finding => !finding.description.trim())
    : mode === 'coverage' ? baseline.coverage.status === 'unavailable' || projection === undefined || coverage.some(decision => !decision.reason.trim() || decision.status === 'linked' && !decision.entityRefs.length)
      : !taskRef.trim() || !query.trim() || !usedSegments.length || ['observed_help', 'controlled_effect'].includes(signal) && !lines(evidenceRefs).length && !useEvidence.length);
  async function submit() {
    if (invalid || save.locked || baseline.generation === null) return;
    const common = { requestId, bodyRef: baseline.bodyRef, sources, expectedGeneration: baseline.generation, expectedHeadEventId: baseline.headEventId, supersedesEventIds: supersedes, reason: reason.trim() };
    if (mode === 'content') await save.submit({ operation: 'review-content', ...common, status: contentStatus, limitations: lines(limitations), findings });
    else if (mode === 'coverage') await save.submit({ operation: 'review-coverage', ...common, projectionRevisionId: projection!, decisions: coverage });
    else await save.submit({ operation: 'record-use', ...common, taskRef: taskRef.trim(), query: query.trim(), segmentIds: usedSegments, signal, evidenceRefs: lines(evidenceRefs), evidence: useEvidence, ...(issueKind ? { issueKind } : {}) });
  }
  function updateFinding(index: number, edit: Partial<ContentFinding>) { if (!save.locked) setFindings(findings.map((finding, at) => at === index ? { ...finding, ...edit } : finding)); }
  function updateCoverage(index: number, edit: Partial<CoverageDecision>) { if (!save.locked) setCoverage(coverage.map((decision, at) => at === index ? { ...decision, ...edit } : decision)); }
  const revisionHref = workspaceHref(`${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ id: baseline.bodyRef.knowledgeId, revision: baseline.bodyRef.revisionId, edit: 'true', ...(segmentId ? { segment: segmentId } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) })}`, workspace);
  const sourceEvidence = segments.find(segment => segment.segmentId === segmentId)?.evidence[0] ?? segments[0]?.evidence[0];
  const sourceHref = workspaceHref(`${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({ knowledge: baseline.bodyRef.knowledgeId, revision: baseline.bodyRef.revisionId, section: 'evidence', ...(segmentId ? { segment: segmentId } : {}), ...(sourceEvidence ? { evidence: JSON.stringify({ ...sourceEvidence.source, evidenceRef: sourceEvidence.selection.evidenceRef, start: sourceEvidence.selection.start, end: sourceEvidence.selection.end }) } : {}) })}`, workspace);
  return <div className="knowledge-review-editor">
    <p>{t('复核意见、关联覆盖与使用信号独立记录。它们是认知和维护线索，不是人工 Gold，也不改变保留或关联接受决定。', 'Content opinions, association coverage and use signals are separate records. They guide understanding and maintenance; they are not human Gold and do not change retention or association acceptance.')}</p>
    <details><summary>{t('本次固定的正文与来源', 'Content and sources fixed for this review')}</summary><p>{detail.revision.title}</p><code>{baseline.bodyRef.knowledgeId} / {baseline.bodyRef.revisionId} / {baseline.bodyRef.bodyDigest}</code>{baseline.sources.map(source => <p key={`${source.snapshotId}/${source.sourceVersion}`} className="candidate-help"><code>{source.snapshotId} / {source.sourceVersion}</code> · {source.status === 'available' ? t('原文可读', 'Original available') : t('原文不可读', 'Original unavailable')}</p>)}</details>
    {baseline.content.status === 'needs_revision' && <Alert type="warning" title={t('此修订仍有未解除的待修意见。新增“有条件复核”不会自动解除；需要明确替代相应旧意见。', 'This revision has unresolved revision requests. A new limited review does not clear them; explicitly supersede the relevant opinion.')}/>}
    <nav className="knowledge-reader-tabs" aria-label={t('复核记录类型', 'Review record type')}>{([{ key: 'content', label: t('内容复核', 'Content review') }, { key: 'coverage', label: t('逐段关联覆盖', 'Segment coverage') }, { key: 'use', label: t('任务使用', 'Task use') }] as const).map(item => <button type="button" key={item.key} disabled={save.locked} aria-pressed={mode === item.key} onClick={() => { setMode(item.key); setSupersedes([]); }}>{item.label}</button>)}</nav>
    {save.error && <Alert type="warning" title={save.error} action={save.unknown ? <Button loading={save.busy} onClick={() => void save.inspect()}>{t('按请求回执核对（只读）', 'Check request receipt (read-only)')}</Button> : undefined}/>}
    {save.receipt && <Alert type="success" title={t('已找到本次复核事件的保存回执。记录不代表内容或收益已证实。', 'A save receipt identifies this review event. It does not establish truth or benefit.')} description={<code>{save.receipt.requestId} / {save.receipt.eventId}</code>}/>}
    <fieldset disabled={save.locked} className="knowledge-review-fields">
    {mode === 'content' && <div className="candidate-form">
      <label>{t('内容复核结论', 'Content review decision')}<Select<'needs_revision' | 'reviewed_with_limits'> disabled={save.locked} aria-label={t('内容复核结论', 'Content review decision')} value={contentStatus} onChange={setContentStatus} options={[{ value: 'needs_revision', label: t('需要修订', 'Needs revision') }, { value: 'reviewed_with_limits', label: t('已复核，保留适用限制', 'Reviewed with limits') }]}/></label>
      <label>{t('适用限制（每行一项）', 'Limits (one per line)')}<Input.TextArea aria-label={t('复核适用限制', 'Review limits')} rows={3} value={limitations} onChange={event => setLimitations(event.target.value)}/></label>
      {findings.map((finding, index) => <section className="candidate-form candidate-statement" key={index}>
        <label>{t(`问题 ${index + 1} 的类型`, `Finding ${index + 1} type`)}<Select<ContentFinding['problemKind']> disabled={save.locked} value={finding.problemKind} onChange={problemKind => updateFinding(index, { problemKind })} options={[['omission',t('遗漏','Omission')],['unsupported_claim',t('依据不足','Unsupported claim')],['scope_error',t('范围错误','Scope error')],['contradiction',t('矛盾','Contradiction')],['unclear',t('表述不清','Unclear')],['other',t('其他','Other')]].map(([value,label])=>({value,label}))}/></label>
        <label>{t(`问题 ${index + 1} 的说明`, `Finding ${index + 1} description`)}<Input.TextArea aria-label={t(`问题 ${index + 1} 的说明`, `Finding ${index + 1} description`)} value={finding.description} rows={3} onChange={event => updateFinding(index, { description: event.target.value })}/></label>
        <label>{t('涉及段落（留空表示整块遗漏或全文问题）', 'Segments (empty means a missing block or whole-content issue)')}<Select disabled={save.locked} mode="multiple" aria-label={t(`问题 ${index + 1} 的段落`, `Finding ${index + 1} segments`)} value={finding.segmentIds} onChange={segmentIds => updateFinding(index, { segmentIds })} options={segments.map((segment, at)=>({value:segment.segmentId,label:t(`段落 ${at+1}`,`Segment ${at+1}`)}))}/></label>
        <KnowledgeReviewEvidence detail={detail} value={finding.evidence ?? []} lang={lang} disabled={save.locked} onChange={evidence => updateFinding(index, { evidence })}/>
        <Button danger onClick={()=>setFindings(findings.filter((_,at)=>at!==index))}>{t(`移除问题 ${index+1}`,`Remove finding ${index+1}`)}</Button>
      </section>)}
      <Button onClick={()=>setFindings([...findings,{problemKind:'omission',description:'',segmentIds:[],evidence:[]}])}>{t('添加具体问题', 'Add a finding')}</Button>
      <p><Link href={revisionHref} target="_blank">{t('进入此修订的正文编辑', 'Edit this exact content revision')}</Link></p><p className="candidate-help">{t('修订会产生新正文：内容复核与保留决定不继承，关联和载体需重新核对。历史意见仍绑定原修订。', 'Editing creates a new revision. Content reviews and retention do not transfer; associations and artifacts need review. Historical opinions stay bound to the original revision.')}</p>
    </div>}
    {mode === 'coverage' && <div className="candidate-form"><p>{t('固定关联投影：', 'Fixed association projection: ')}<code>{projection ?? t('无投影', 'No projection')}</code></p><p className="candidate-help">{t('已有映射不等于已经评估。逐段记录已核对关联、无可靠对象、缺口或尚未评估；新投影不继承本次判断。', 'Existing mappings do not establish assessed coverage. Record reviewed links, no reliable object, a gap, or not assessed for each segment. A new projection does not inherit these decisions.')}</p>
      {baseline.coverage.status === 'unavailable' && <Alert type="warning" title={t('关联投影不可读，覆盖状态未知；内容复核和任务记录仍独立可用。', 'The projection is unreadable and coverage is unknown. Content review and task records remain independent.')}/>}
      <Button onClick={()=>setCoverage(coverage.map(decision=>decision.status==='unknown'&&!decision.reason.trim()?{...decision,reason:t('本次尚未评估此段落的关联覆盖。','This segment’s association coverage was not assessed in this review.')}:decision))}>{t('明确记录其余段落尚未评估', 'Explicitly mark remaining segments as not assessed')}</Button>
      {segments.map((segment,index)=>{const decision=coverage[index],mappings=projection && projection===detail.derivedAssociations.revision?.revisionId ? detail.derivedAssociations.revision.segmentEntityRefs.filter(ref=>ref.segmentId===segment.segmentId) : [];return <section className="knowledge-review-coverage-segment" key={segment.segmentId}>
        <h3>{t(`段落 ${index+1}`,`Segment ${index+1}`)}</h3><div className="knowledge-review-coverage-context"><div><h4>{t('正文','Content')}</h4><p className="knowledge-segment-text">{segment.text}</p></div>
        <div><h4>{t('已有映射','Existing mappings')}</h4>{mappings.length?mappings.map(ref=>{const catalog=detail.derivedCatalogs.find(catalog=>catalog.analysisId===ref.analysisId&&catalog.entityRevisionId===ref.entityRevisionId);return <details key={`${ref.analysisId}/${ref.entityRevisionId}/${ref.entityId}`}><summary>{catalog?.status==='available'?catalog.entities.find(entity=>entity.entityId===ref.entityId)?.label??ref.entityId:ref.entityId}</summary><code>{ref.analysisId} / {ref.entityRevisionId} / {ref.entityId}</code><p>{ref.mentionIds.join(', ')}</p></details>;}):<p className="candidate-help">{t('当前固定投影无已发布映射；覆盖尚需判断。','No published mapping in this fixed projection; coverage still needs assessment.')}</p>}</div>
        <div><h4>{t('来源依据','Source evidence')}</h4><details><summary>{t(`查看 ${segment.evidence.length} 条精确引文`,`Inspect ${segment.evidence.length} exact citations`)}</summary>{segment.evidence.map((evidence,at)=><blockquote key={at}>{evidence.selection.quote}<p className="candidate-help"><code>{evidence.source.snapshotId} / {evidence.source.sourceVersion}</code> · {evidence.selection.evidenceRef} · {evidence.selection.start}–{evidence.selection.end}</p></blockquote>)}</details></div></div>
        <p className="candidate-help">{t(`已有 ${mappings.length} 处映射；下面明确选择本次核对的关联。`,`${mappings.length} existing mappings; explicitly choose links assessed in this review.`)}</p>
        <Select<CoverageDecision['status']> disabled={save.locked} aria-label={t(`段落 ${index+1} 的覆盖判断`,`Coverage decision for segment ${index+1}`)} value={decision.status} onChange={status=>updateCoverage(index,{status,entityRefs:[]})} options={['linked','no_reliable_object','gap','unknown'].map(value=>({value,label:coverageLabel(value,t),disabled:value==='linked'&&!mappings.length}))}/>
        {decision.status==='linked'&&mappings.map(ref=>{const catalog=detail.derivedCatalogs.find(catalog=>catalog.analysisId===ref.analysisId&&catalog.entityRevisionId===ref.entityRevisionId),label=catalog?.status==='available'?catalog.entities.find(entity=>entity.entityId===ref.entityId)?.label:ref.entityId;const present=decision.entityRefs.some(item=>item.analysisId===ref.analysisId&&item.entityRevisionId===ref.entityRevisionId&&item.entityId===ref.entityId);return <label className="knowledge-review-mapping" key={`${ref.analysisId}/${ref.entityRevisionId}/${ref.entityId}`}><Checkbox checked={present} onChange={event=>updateCoverage(index,{entityRefs:event.target.checked?[...decision.entityRefs,{analysisId:ref.analysisId,entityRevisionId:ref.entityRevisionId,entityId:ref.entityId,mentionIds:[...ref.mentionIds]}]:decision.entityRefs.filter(item=>!(item.analysisId===ref.analysisId&&item.entityRevisionId===ref.entityRevisionId&&item.entityId===ref.entityId))})}/>{label}<code>{ref.analysisId} / {ref.entityRevisionId} / {ref.entityId}</code></label>;})}
        <label>{t('本段判断理由','Reason for this segment')}<Input.TextArea aria-label={t(`段落 ${index+1} 的覆盖理由`,`Coverage reason for segment ${index+1}`)} value={decision.reason} rows={2} onChange={event=>updateCoverage(index,{reason:event.target.value})}/></label>

      </section>;})}
    </div>}
    {mode === 'use' && <div className="candidate-form">
      <p>{t('五种信号分别记录，不自动递进。已提供、已读取和自述使用都不能证明帮助或效果。', 'The five signals are independent and do not advance automatically. Provision, reading and reported use do not establish help or effect.')}</p>
      <label>{t('实际任务引用', 'Actual task reference')}<Input aria-label={t('实际任务引用','Actual task reference')} maxLength={256} value={taskRef} placeholder={t('任务、来源会话或运行的稳定引用','Stable task, conversation or run reference')} onChange={event=>{setTaskRef(event.target.value);setSupersedes([]);}}/></label>
      <label>{t('消费时的问题','Question at consumption')}<Input.TextArea aria-label={t('消费时的问题','Question at consumption')} maxLength={512} value={query} readOnly={!!initialQuery} onChange={event=>setQuery(event.target.value)} rows={3}/></label>
      <label>{t('实际交付的段落','Segments actually delivered')}<Select disabled={save.locked || !!segmentId} aria-label={t('实际交付的段落','Segments actually delivered')} mode="multiple" value={usedSegments} onChange={setUsedSegments} options={segments.map((segment,index)=>({value:segment.segmentId,label:t(`段落 ${index+1}`,`Segment ${index+1}`)}))}/></label>
      <label>{t('本次使用信号','Use signal')}<Select<KnowledgeReviewUseInput['signal']> disabled={save.locked} aria-label={t('本次使用信号','Use signal')} value={signal} onChange={signal=>{setSignal(signal);setSupersedes([]);}} options={[['provided',t('已提供','Provided')],['read',t('已读取','Read')],['reported_use',t('自述使用','Reported use')],['observed_help',t('观察到帮助（需依据）','Observed help (evidence required)')],['controlled_effect',t('受控效果（需依据）','Controlled effect (evidence required)')]].map(([value,label])=>({value,label}))}/></label>
      <label>{t('使用中发现的问题（可选）','Issue found during use (optional)')}<Select<NonNullable<KnowledgeReviewUseInput['issueKind']>> aria-label={t('使用问题分类','Use issue category')} disabled={save.locked} allowClear value={issueKind} onChange={setIssueKind} options={[{value:'content_missing',label:t('内容缺失','Content missing')},{value:'association_wrong',label:t('关联错误','Wrong association')},{value:'source_unavailable',label:t('来源不可读','Source unavailable')},{value:'other',label:t('其他问题','Other issue')}]}/></label>
      {issueKind && <p className="candidate-help">{t('问题分类只记录维护线索，不自动改变内容复核、关联接受、保留或效果。','The category records a maintenance lead. It does not change content review, association acceptance, retention or effect.')}</p>}
      {issueKind==='content_missing'&&<Link href={revisionHref} target="_blank">{t('在新页面修订这份正文','Edit this content in a new page')}</Link>}
      {issueKind==='association_wrong'&&<Link href={workspaceHref(`${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({knowledge:baseline.bodyRef.knowledgeId,revision:baseline.bodyRef.revisionId,section:'associations',...(segmentId?{segment:segmentId}:{})})}`,workspace)} target="_blank">{t('在新页面核对该正文的关联','Review associations for this content in a new page')}</Link>}
      {issueKind==='source_unavailable'&&<Link href={sourceHref} target="_blank">{t('在新页面查看来源状态','Inspect source state in a new page')}</Link>}
      <label>{t('任务或对照依据引用（每行一项）','Task or comparison evidence references (one per line)')}<Input.TextArea aria-label={t('使用依据引用','Use evidence references')} value={evidenceRefs} rows={3} onChange={event=>setEvidenceRefs(event.target.value)}/></label>
      <KnowledgeReviewEvidence detail={detail} value={useEvidence} lang={lang} disabled={save.locked} onChange={setUseEvidence}/>
      <p className="candidate-help">{t('引用由记录者提供；保存不会自动复现任务，也不会验证收益。','The recorder supplies these references. Saving does not rerun the task or verify benefit.')}</p>
    </div>}
    <label>{t('本次记录理由','Reason for this record')}<Input.TextArea aria-label={t('本次记录理由','Reason for this record')} rows={3} value={reason} onChange={event=>setReason(event.target.value)}/></label>
    {!!eligible.length&&<details><summary>{t('明确替代旧意见（可选，默认保留）','Explicitly supersede prior opinions (optional; retained by default)')}</summary>{eligible.map(event=><label key={event.eventId} className="knowledge-review-mapping"><Checkbox checked={supersedes.includes(event.eventId)} onChange={checked=>setSupersedes(checked.target.checked?[...supersedes,event.eventId]:supersedes.filter(id=>id!==event.eventId))}/>{event.reason}<code>{event.eventId} · {event.actor.actorKind}/{event.actor.actorId}</code></label>)}</details>}
    </fieldset>
    <Space wrap className="knowledge-review-actions"><Button type="primary" disabled={invalid||save.locked} loading={save.busy} onClick={()=>void submit()}>{t('保存本次记录','Save this record')}</Button><Button disabled={save.busy} onClick={onClose}>{save.receipt?t('关闭并查看记录','Close and read records'):t('关闭草稿（不会重发）','Close draft (no resubmission)')}</Button></Space>
    {(save.unknown||save.conflicted)&&<p className="candidate-help">{t('当前草稿保留在此面板中。关闭会放弃草稿；未确认前不会重新保存。','The draft remains in this panel. Closing discards it; saving will not be repeated while unconfirmed.')}</p>}
    <details><summary>{t('复核与使用历史（包含其它正文修订）','Review and use history (including other content revisions)')}</summary>{baseline.history?.events.map(event=><ReviewEvent key={event.eventId} event={event} lang={lang}/>)??<p>{t('尚无复核或使用记录。','No review or use records yet.')}</p>}</details>
  </div>;
}
function ReviewEvent({ event, lang }: { event: KnowledgeReviewEvent; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const signalLabel = (signal: KnowledgeReviewUseInput['signal']) => ({provided:t('已提供','Provided'),read:t('已读取','Read'),reported_use:t('自述使用','Reported use'),observed_help:t('观察到帮助','Observed help'),controlled_effect:t('受控效果','Controlled effect')})[signal];
  return <section className="candidate-statement">
    <p>{event.eventKind==='content_review'?t(event.status==='needs_revision'?'内容需要修订':'内容已复核并保留限制',event.status==='needs_revision'?'Content needs revision':'Content reviewed with limits'):event.eventKind==='association_coverage'?t('关联覆盖意见','Association coverage opinion'):signalLabel(event.signal)} · {displayTime(event.at)}</p>
    <p>{event.reason}</p><p className="candidate-help"><code>{event.eventId} / {event.bodyRef.revisionId}</code> · {event.actor.actorKind}/{event.actor.actorId}</p>
    {event.eventKind==='content_review'&&<><ul>{event.findings.map((finding,index)=><li key={index}>{finding.description} · {finding.segmentIds.length?finding.segmentIds.join(', '):t('整块遗漏或全文问题','Missing block or whole-content issue')}{finding.evidence.map((evidence,at)=><ReviewHistoryEvidence key={at} evidence={evidence} lang={lang}/>)}</li>)}</ul><ul>{event.limitations.map((limit,index)=><li key={index}>{limit}</li>)}</ul></>}
    {event.eventKind==='association_coverage'&&<><p className="candidate-help">{t('关联投影：','Association projection: ')}<code>{event.projectionRevisionId??t('无投影','No projection')}</code></p>{event.decisions.map(decision=><p key={decision.segmentId}>{decision.segmentId} · {coverageLabel(decision.status,t)} · {decision.reason}</p>)}</>}
    {event.eventKind==='task_use'&&<><p>{t('任务：','Task: ')}{event.taskRef}</p><p>{event.query} · {event.segmentIds.join(', ')}</p>{event.issueKind&&<p>{t('问题分类：','Issue category: ')}{({content_missing:t('内容缺失','Content missing'),association_wrong:t('关联错误','Wrong association'),source_unavailable:t('来源不可读','Source unavailable'),other:t('其他问题','Other issue')})[event.issueKind]}</p>}{event.evidenceRefs.map((reference,index)=><p key={index}>{reference}</p>)}{event.evidence.map((evidence,index)=><ReviewHistoryEvidence key={index} evidence={evidence} lang={lang}/>)}</>}
    {!!event.supersedesEventIds.length&&<p>{t('明确替代：','Explicitly supersedes: ')}{event.supersedesEventIds.join(', ')}</p>}
  </section>;
}

/** Saved quotations retain their independent source, position and epistemic basis on every readback. */
function ReviewHistoryEvidence({ evidence, lang }: { evidence: Evidence; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <section className="knowledge-review-history-evidence" aria-label={t('已保存的精确复核依据', 'Saved exact review evidence')}>
    <blockquote className="knowledge-segment-text">{evidence.selection.quote}</blockquote>
    <p>{t('依据性质：', 'Evidence basis: ')}{({ source_assertion: t('来源中的说法', 'Source assertion'), direct_observation: t('直接观测', 'Direct observation'), inference: t('推断', 'Inference') })[evidence.basis]}</p>
    {evidence.interpretation && <p className="knowledge-segment-text">{t('依据解释：', 'Interpretation: ')}{evidence.interpretation}</p>}
    <details><summary>{t('查看保存的来源与精确引文位置', 'Inspect saved source and exact quotation position')}</summary>
      <p>{t('来源快照：', 'Source snapshot: ')}<code>{evidence.source.snapshotId}</code></p>
      <p>{t('来源版本：', 'Source version: ')}<code>{evidence.source.sourceVersion}</code></p>
      <p>{t('原始片段：', 'Original excerpt: ')}<code>{evidence.selection.evidenceRef}</code></p>
      <p>{t('引文位置（从 0 开始，UTF-16）：', 'Quotation span (zero-based UTF-16): ')}<code>{evidence.selection.start}–{evidence.selection.end}</code></p>
    </details>
  </section>;
}

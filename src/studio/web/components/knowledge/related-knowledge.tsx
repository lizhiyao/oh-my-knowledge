'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Select, Skeleton, Space, Tag } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { KnowledgeLibraryKnowledge } from '../../../view-models/knowledge/knowledge-library';
import type { KnowledgeRelationStatus, KnowledgeRelationProposeInput } from '../../../view-models/knowledge/knowledge-relations';
import type { KnowledgeBodyRef } from '../../../../knowledge/contracts';
import type { Language } from '../layout/shell';
import { displayTime } from '../../../application/display/format';
import { requestKnowledge } from './request';
import { reviewBodyRef } from './review-request';
import { useRelationSave } from './relation-request';
import { SourceLocator, SourceOriginalContext } from './source-locator';

type Relation = Extract<KnowledgeRelationStatus, { storageStatus: 'available' }>;
type Evidence = KnowledgeRelationProposeInput['evidence'][number];
type RelationList = { bodyRef: KnowledgeBodyRef; relations: Relation[]; unavailable: { relationId?: string; reason: string }[]; completeness: 'complete' | 'partial' };
type Draft = { type: 'supplements' | 'conflicts_with'; direction: 'from' | 'to'; question: string; conditions: string; reason: string; limitations: string;
  basis: 'source_assertion' | 'inference'; comparisonScope: KnowledgeRelationProposeInput['comparisonScope'] };
const blankDraft = (): Draft => ({ type: 'supplements', direction: 'from', question: '', conditions: '', reason: '', limitations: '', basis: 'inference',
  comparisonScope: { status: 'unknown', subject: '', modality: '', time: '', version: '', reason: '' } });
const lines = (text: string) => text.split('\n').map(value => value.trim()).filter(Boolean);
const sameBody = (a: KnowledgeBodyRef, b: KnowledgeBodyRef) => a.knowledgeId === b.knowledgeId && a.revisionId === b.revisionId && a.bodyDigest === b.bodyDigest;
function relationLabel(type: string, lang: Language) { return type === 'supplements' ? lang === 'zh' ? '补充' : 'Supplements' : lang === 'zh' ? '冲突意见' : 'Conflict opinion'; }
function opinionLabel(status: Relation['opinionStatus'], lang: Language) {
  return ({ pending: ['待核对', 'Pending'], accepted: ['有限接受', 'Accepted with limits'], rejected: ['已拒绝', 'Rejected'], disputed: ['意见有争议', 'Disputed'], withdrawn: ['已撤回', 'Withdrawn'] })[status][lang === 'zh' ? 0 : 1];
}
function sourceReady(detail: KnowledgeCandidateDetail) {
  return detail.revision.content.segments.every(segment => segment.evidence.every(evidence => {
    const source = detail.sources.find(item => item.status === 'available' && item.snapshot.snapshotId === evidence.source.snapshotId && item.snapshot.sourceVersion === evidence.source.sourceVersion);
    const excerpt = source?.status === 'available' ? source.snapshot.excerpts.find(value => value.evidenceRef === evidence.selection.evidenceRef) : undefined;
    return excerpt?.text.slice(evidence.selection.start, evidence.selection.end) === evidence.selection.quote;
  }));
}
async function readBody(workspace: string, ref: KnowledgeBodyRef, signal: AbortSignal) {
  const detail = await requestKnowledge<KnowledgeCandidateDetail>('candidates', { workspace, operation: 'show', id: ref.knowledgeId, revision: ref.revisionId }, signal);
  if (!sameBody(reviewBodyRef(detail), ref)) throw new Error('Relation endpoint identity mismatch.');
  return detail;
}

/** Both complete bodies and their registered evidence stay visible; evidence is selected, never hand-authored. */
function EndpointBody({ detail, side, lang, workspace, selected, onSelect, disabled }: {
  detail: KnowledgeCandidateDetail; side: string; lang: Language; workspace: string; selected?: string[]; onSelect?(ids: string[]): void; disabled?: boolean;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <section className="knowledge-relation-endpoint" aria-label={`${side}${t('完整正文与来源', ' complete content and sources')}`}>
    <h4>{side} · {detail.revision.title}</h4>
    <details><summary>{t('绑定的精确正文版本', 'Exact bound content revision')}</summary><p><code>{detail.revision.knowledgeId} / {detail.revision.revisionId}</code></p><p><code>{detail.revision.bodyDigest}</code></p></details>
    {!sourceReady(detail) && <Alert type="warning" title={t('部分精确来源不可用或引文不匹配，不能完整核对或接受关系。', 'Some exact sources are unavailable or quotations do not match. The relation cannot be fully checked or accepted.')}/>}
    {detail.revision.content.segments.map(segment => <section className="knowledge-statement" key={segment.segmentId}>
      <p className="knowledge-segment-text">{segment.text}</p>
      {onSelect && <Checkbox disabled={disabled} checked={selected?.includes(segment.segmentId)} onChange={event => onSelect(event.target.checked ? [...(selected ?? []), segment.segmentId] : (selected ?? []).filter(id => id !== segment.segmentId))}>{t('将此段作为关系依据', 'Use this segment as relation evidence')}</Checkbox>}
      {segment.evidence.map((evidence, index) => {
        const source = detail.sources.find(item => item.status === 'available' && item.snapshot.snapshotId === evidence.source.snapshotId && item.snapshot.sourceVersion === evidence.source.sourceVersion);
        const excerpt = source?.status === 'available' ? source.snapshot.excerpts.find(value => value.evidenceRef === evidence.selection.evidenceRef) : undefined;
        const matched = excerpt?.text.slice(evidence.selection.start, evidence.selection.end) === evidence.selection.quote;
        return <details key={index} className="knowledge-relation-source"><summary>{t(`核对来源依据 ${index + 1}`, `Inspect source evidence ${index + 1}`)} · {evidence.basis === 'inference' ? t('推断', 'Inference') : evidence.basis === 'direct_observation' ? t('直接观测', 'Direct observation') : t('来源中的说法', 'Source assertion')}</summary>
          <blockquote>{evidence.selection.quote}</blockquote>{evidence.interpretation && <p>{evidence.interpretation}</p>}
          {source?.status === 'available' && excerpt ? <><SourceLocator source={source.snapshot} excerpt={excerpt} workspace={workspace} lang={lang}/>
            {!matched && <p role="alert">{t('引文位置不匹配。', 'Quotation position does not match.')}</p>}
            <pre className="knowledge-source">{matched ? <>{excerpt.text.slice(0, evidence.selection.start)}<mark>{evidence.selection.quote}</mark>{excerpt.text.slice(evidence.selection.end)}</> : excerpt.text}</pre>
            <SourceOriginalContext snapshot={source.snapshot} excerpt={excerpt} workspace={workspace} lang={lang}/></>
            : <p className="candidate-help">{t('此处保留已保存引文，精确原文暂不可读。', 'The saved quotation remains; the exact original source cannot currently be read.')}</p>}
        </details>;
      })}
    </section>)}
  </section>;
}

function RelationOpinion({ relation, lang }: { relation: Relation; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en, proposal = relation.revision;
  return <><Space wrap><Tag>{relationLabel(proposal.relationType, lang)}</Tag><Tag>{opinionLabel(relation.opinionStatus, lang)}</Tag>
    {relation.bodyStatus !== 'current' && <Tag>{relation.bodyStatus === 'stale' ? t('绑定旧正文', 'Older content binding') : t('正文不可完整读取', 'Content unavailable')}</Tag>}
    {relation.sourceStatus === 'unavailable' && <Tag>{t('来源不可用', 'Source unavailable')}</Tag>}</Space>
    <p><strong>{proposal.question}</strong></p><p>{proposal.reason}</p>
    <p>{t('关系依据：', 'Relation basis: ')}{proposal.basis === 'source_assertion' ? t('来源明确提出', 'Asserted by a source') : t('推断意见', 'Inferred relation')}</p>
    <p className="candidate-help">{t('补充方向：从一端补充另一端；冲突意见不裁决哪篇更真。', 'Supplements run from one endpoint to the other; a conflict opinion does not decide which is true.')}</p>
    <p>{t('比较条件：', 'Comparison scope: ')}{proposal.comparisonScope.status === 'same' ? t('可比', 'Same') : proposal.comparisonScope.status === 'different' ? t('不同', 'Different') : t('未知，尚未确认可比', 'Unknown; comparability not established')}</p>
    <dl>{(['subject', 'modality', 'time', 'version', 'reason'] as const).map((field, i) => <div key={field}><dt>{[t('主体', 'Subject'), t('语气／主张方式', 'Modality'), t('时间', 'Time'), t('版本', 'Version'), t('比较理由', 'Comparison reason')][i]}</dt><dd>{proposal.comparisonScope[field]}</dd></div>)}</dl>
    <p>{t('适用条件：', 'Conditions: ')}{proposal.conditions.join('；')}</p><p>{t('限制：', 'Limitations: ')}{proposal.limitations.join('；') || t('未另行记录；不代表无局限。', 'None additionally recorded; this does not establish no limitations.')}</p>
    <p className="candidate-help">{t('提出者：', 'Proposed by: ')}{proposal.actor.actorKind} / {proposal.actor.actorId} · {displayTime(proposal.at)}</p>
    {relation.activeReviews.map(review => <section key={review.eventId} className="knowledge-network-citation"><p>{review.choice === 'accept' ? t('有限接受', 'Accepted with limits') : t('拒绝', 'Rejected')} · {review.actor.actorKind} / {review.actor.actorId} · {displayTime(review.at)}</p><p>{review.reason}</p>{review.limitations.map((value, i) => <p key={i}>{value}</p>)}</section>)}
  </>;
}

function RelationReview({ relation, workspace, lang, onSaved, onGuard }: { relation: Relation; workspace: string; lang: Language; onSaved(): void; onGuard(value: boolean): void }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const save = useRelationSave(workspace, `${relation.relationId}/${relation.revision.eventId}/review`, lang);
  useEffect(() => { onGuard(save.busy || save.unknown); }, [save.busy, save.unknown, onGuard]);
  const [bodies, setBodies] = useState<{ from: KnowledgeCandidateDetail; to: KnowledgeCandidateDetail }>(), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const [reason, setReason] = useState(''), [limitations, setLimitations] = useState(''), [checked, setChecked] = useState<number[]>([]), [complete, setComplete] = useState(false), [supersedes, setSupersedes] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController(); setBodies(undefined); setFailed(false);
    void Promise.all([readBody(workspace, relation.revision.from.bodyRef, controller.signal), readBody(workspace, relation.revision.to.bodyRef, controller.signal)])
      .then(([from, to]) => { if (!controller.signal.aborted) setBodies({ from, to }); }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [workspace, relation.revision.eventId, retry]);
  const accept = relation.permissions.canAccept && bodies && sourceReady(bodies.from) && sourceReady(bodies.to) && complete && checked.length === relation.revision.evidence.length;
  async function submit(choice: 'accept' | 'reject' | 'withdraw') {
    if (save.locked || !reason.trim() || (choice === 'accept' && !accept)) return;
    const common = { relationId: relation.relationId, relationRevisionId: relation.revision.eventId, requestId: crypto.randomUUID(), expectedGeneration: relation.generation,
      expectedHeadEventId: relation.headEventId, reason: reason.trim(), limitations: lines(limitations) };
    const result = choice === 'withdraw' ? await save.submit({ operation: 'withdraw-relation', ...common })
      : await save.submit({ operation: 'review-relation', ...common, choice, checkedEvidenceIndices: checked, supersedesReviewEventIds: supersedes });
    if (result?.current()) onSaved();
  }
  return <div className="candidate-form">
    <RelationOpinion relation={relation} lang={lang}/>
    <p>{t('从端 → 到端（精确绑定，不自动跟随新版本）', 'From → to (exact bindings; newer revisions are not followed automatically)')}</p>
    {failed ? <Alert type="warning" title={t('两端正文未能完整读回；可记录拒绝意见，不能接受。', 'The complete endpoint bodies could not be read. You may reject, but cannot accept.')} action={<Button onClick={() => setRetry(value => value + 1)}>{t('重读正文', 'Read bodies again')}</Button>}/>
      : !bodies ? <Skeleton active paragraph={{ rows: 3 }}/>
        : <><EndpointBody detail={bodies.from} side={t('从端', 'From')} lang={lang} workspace={workspace}/><EndpointBody detail={bodies.to} side={t('到端', 'To')} lang={lang} workspace={workspace}/></>}
    <h4>{t('本提案的两端精确依据', 'Exact evidence for this proposal')}</h4>
    {relation.revision.evidence.map((evidence, index) => <section className="candidate-statement" key={index}><p>{evidence.side === 'from' ? t('从端正文：', 'From content: ') : t('到端正文：', 'To content: ')}{evidence.bodySelection.quote}</p><blockquote>{evidence.selection.quote}</blockquote>
      <p className="candidate-help">{evidence.basis} · {evidence.selection.evidenceRef} · {evidence.selection.start}–{evidence.selection.end}</p>
      {evidence.interpretation && <p>{evidence.interpretation}</p>}<details><summary>{t('这条依据的精确来源与正文范围', 'Exact source and body range for this evidence')}</summary><p><code>{evidence.source.snapshotId} / {evidence.source.sourceVersion}</code></p><p>{evidence.bodySelection.segmentId} · UTF-16 {evidence.bodySelection.start}–{evidence.bodySelection.end}</p></details>
      <Checkbox disabled={save.locked || !bodies || !sourceReady(bodies.from) || !sourceReady(bodies.to)} checked={checked.includes(index)} onChange={event => setChecked(event.target.checked ? [...checked, index] : checked.filter(value => value !== index))}>{t(`已核对依据 ${index + 1}`, `Checked evidence ${index + 1}`)}</Checkbox></section>)}
    <Checkbox disabled={save.locked || !bodies || !sourceReady(bodies.from) || !sourceReady(bodies.to)} checked={complete} onChange={event => setComplete(event.target.checked)}>{t('已核读两端完整正文、来源与比较条件；接受只代表我的有限核对。', 'I checked both complete bodies, sources and comparison scope. Acceptance represents only my limited review.')}</Checkbox>
    <label>{t('复核／撤回理由', 'Review / withdrawal reason')}<Input.TextArea aria-label={t('关系复核理由', 'Relation review reason')} value={reason} disabled={save.locked} rows={3} maxLength={4096} onChange={event => setReason(event.target.value)}/></label>
    <label>{t('复核限制（每行一条）', 'Review limitations (one per line)')}<Input.TextArea value={limitations} disabled={save.locked} rows={2} onChange={event => setLimitations(event.target.value)}/></label>
    {!!relation.permissions.supersedableReviewEventIds.length && <fieldset><legend>{t('明确替换我在本修订的活跃意见（可选）', 'Explicitly replace my active opinions on this revision (optional)')}</legend>{relation.permissions.supersedableReviewEventIds.map(id => {
      const review = relation.activeReviews.find(value => value.eventId === id);
      return <Checkbox disabled={save.locked} key={id} checked={supersedes.includes(id)} onChange={event => setSupersedes(event.target.checked ? [...supersedes, id] : supersedes.filter(value => value !== id))}>{review?.reason ?? id}</Checkbox>;
    })}</fieldset>}
    {!relation.permissions.canAccept && <p className="candidate-help">{t('当前条件或来源不足以接受；未知条件不能当作已核对冲突。', 'Current scope or sources do not permit acceptance. Unknown comparability cannot be accepted as a verified conflict.')}</p>}
    {save.error && <Alert type="warning" title={save.error}/>}{save.unknown && <Button loading={save.busy} onClick={() => void save.inspect().then(result => { if (result?.current()) onSaved(); })}>{t('只读核对原请求回执', 'Check the original receipt (read-only)')}</Button>}
    {save.receipt && <p role="status">{t('已记录本次意见。', 'This opinion was recorded.')} <code>{save.receipt.eventId}</code></p>}
    <Space wrap>{relation.permissions.canReview && <><Button type="primary" disabled={save.locked || !accept || !reason.trim()} loading={save.busy} onClick={() => void submit('accept')}>{t('有限接受', 'Accept with limits')}</Button>
      <Button disabled={save.locked || !reason.trim()} onClick={() => void submit('reject')}>{t('拒绝此关系', 'Reject this relation')}</Button></>}
      {relation.permissions.canWithdraw && <Button danger disabled={save.locked || !reason.trim()} onClick={() => void submit('withdraw')}>{t('撤回我提出的此修订', 'Withdraw my proposal revision')}</Button>}</Space>
    <details><summary>{t('保留的关系历史', 'Preserved relation history')}</summary>{relation.history.events.map(event => <section className="knowledge-network-citation" key={event.eventId}><p>{event.eventKind === 'relation_proposed' ? t('提出修订（初始待核对）', 'Proposal revision (initially pending)') : event.eventKind === 'relation_reviewed' ? event.choice === 'accept' ? t('有限接受意见', 'Acceptance opinion') : t('拒绝意见', 'Rejection opinion') : t('作者撤回', 'Author withdrawal')} · {event.actor.actorKind} / {event.actor.actorId} · {displayTime(event.at)}</p><p>{event.reason}</p><code>{event.eventId}</code>{event.actor.actorKind === 'agent' && <p>{t('执行记录：', 'Execution reference: ')}<code>{event.actor.executionRef}</code></p>}{event.eventKind === 'relation_proposed' && <p><code>{event.from.bodyRef.revisionId} → {event.to.bodyRef.revisionId}</code></p>}</section>)}</details>
  </div>;
}

function RelationProposal({ detail, workspace, lang, catalog, previous, onSaved, onGuard }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; catalog?: KnowledgeLibraryKnowledge; previous?: Relation; onSaved(): void; onGuard(value: boolean): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en, bodyRef = reviewBodyRef(detail);
  const previousSide = previous && sameBody(previous.revision.from.bodyRef, bodyRef) ? 'from' : 'to';
  const [draft, setDraft] = useState<Draft>(() => previous ? { type: previous.revision.relationType, direction: previousSide, question: previous.revision.question,
    conditions: previous.revision.conditions.join('\n'), reason: previous.revision.reason, limitations: previous.revision.limitations.join('\n'), basis: previous.revision.basis, comparisonScope: { ...previous.revision.comparisonScope } } : blankDraft());
  const [otherId, setOtherId] = useState(previous ? previous.revision[previousSide === 'from' ? 'to' : 'from'].bodyRef.knowledgeId : '');
  const [other, setOther] = useState<KnowledgeCandidateDetail>(), [otherRevision, setOtherRevision] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [otherSelected, setOtherSelected] = useState<string[]>([]), [complete, setComplete] = useState(false);
  const [relationId] = useState(() => previous?.relationId ?? crypto.randomUUID());
  const save = useRelationSave(workspace, `${relationId}/${previous?.revision.eventId ?? 'new'}/proposal`, lang);
  useEffect(() => { onGuard(save.busy || save.unknown); }, [save.busy, save.unknown, onGuard]);
  useEffect(() => {
    setOther(undefined); setOtherSelected([]); setComplete(false); setError('');
    if (!otherId) return;
    const controller = new AbortController(); setLoading(true);
    void requestKnowledge<KnowledgeCandidateDetail>('candidates', { workspace, operation: 'show', id: otherId, ...(otherRevision ? { revision: otherRevision } : {}) }, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.revision.knowledgeId !== otherId || otherRevision && value.revision.revisionId !== otherRevision) throw new Error('Relation endpoint identity mismatch.');
      const expected = !otherRevision ? catalog?.rows.find(row => row.knowledgeId === otherId) : undefined;
      if (expected && !sameBody(reviewBodyRef(value), expected)) throw new Error('Relation endpoint changed; reload the directory.');
      setOther(value);
    }).catch(() => { if (!controller.signal.aborted) setError(t('另一篇的精确正文未能读回，不能提出关系。请重新选择或刷新目录。', 'The exact other body could not be read. Select it again or refresh the directory before proposing.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspace, otherId, otherRevision]);
  const evidenceFor = (body: KnowledgeCandidateDetail, ids: string[], side: 'from' | 'to'): Evidence[] => body.revision.content.segments.filter(segment => ids.includes(segment.segmentId)).flatMap(segment => segment.evidence.map(evidence => ({ ...evidence, side,
    bodySelection: { segmentId: segment.segmentId, start: 0, end: segment.text.length, quote: segment.text } })));
  const evidence = other ? [...evidenceFor(detail, selected, draft.direction), ...evidenceFor(other, otherSelected, draft.direction === 'from' ? 'to' : 'from')] : [];
  const valid = other && other.revision.knowledgeId !== bodyRef.knowledgeId && selected.length > 0 && otherSelected.length > 0 && evidence.length <= 256 && sourceReady(detail) && sourceReady(other)
    && complete && draft.question.trim() && draft.reason.trim() && lines(draft.conditions).length > 0 && lines(draft.conditions).length <= 64 && lines(draft.limitations).length <= 64
    && Object.entries(draft.comparisonScope).every(([, value]) => value.trim()) && !(draft.type === 'conflicts_with' && draft.comparisonScope.status === 'different');
  async function propose() {
    if (!valid || !other || save.locked) return;
    const endpoint = (body: KnowledgeCandidateDetail, ids: string[]) => ({ bodyRef: reviewBodyRef(body), ...(ids.length === body.revision.content.segments.length ? {} : { segmentIds: ids }) });
    const current = endpoint(detail, selected), target = endpoint(other, otherSelected);
    const result = await save.submit({ operation: 'propose-relation', relationId, requestId: crypto.randomUUID(), expectedGeneration: previous?.generation ?? 0, expectedHeadEventId: previous?.headEventId ?? null,
      parentRelationRevisionId: previous?.revision.eventId ?? null, relationType: draft.type, from: draft.direction === 'from' ? current : target, to: draft.direction === 'from' ? target : current,
      question: draft.question.trim(), conditions: lines(draft.conditions), comparisonScope: Object.fromEntries(Object.entries(draft.comparisonScope).map(([key, value]) => [key, value.trim()])) as Draft['comparisonScope'],
      reason: draft.reason.trim(), limitations: lines(draft.limitations), basis: draft.basis, evidence });
    if (result?.current()) onSaved();
  }
  const change = (patch: Partial<Draft>) => { setDraft(value => ({ ...value, ...patch })); setComplete(false); };
  return <div className="candidate-form">
    <h4>{previous ? t('修订关系提案', 'Revise the relation proposal') : t('提出相关知识', 'Propose a knowledge relation')}</h4>
    <p>{t('先选择同一工作区的另一篇，核读两端完整正文与已有来源，再说明关系。保存为待核对意见；不会修改正文或实体关联。', 'Choose another item in this workspace and inspect both complete bodies and existing sources. Saving records a pending opinion without changing content or entity associations.')}</p>
    <label>{t('另一篇知识', 'Other knowledge item')}<Select aria-label={t('另一篇知识', 'Other knowledge item')} showSearch optionFilterProp="label" value={otherId || undefined} disabled={save.locked}
      options={(catalog?.rows ?? []).filter(row => row.knowledgeId !== bodyRef.knowledgeId && (!previous || row.knowledgeId === otherId)).map(row => ({ value: row.knowledgeId, label: row.title }))}
      onChange={value => { setOtherId(value); setOtherRevision(''); }}/></label>
    {other && <label>{t('另一篇的精确版本', 'Exact revision of the other item')}<Select aria-label={t('另一篇的精确版本', 'Exact revision of the other item')} disabled={save.locked} value={other.revision.revisionId} options={other.history.revisions.map(body => ({ value: body.revisionId, label: `${body.title} · ${displayTime(body.revisedAt)}${body.revisionId === other.history.writeHeadRevisionId ? t(' · 当前', ' · current') : t(' · 历史', ' · historical')}` }))} onChange={value => setOtherRevision(value)}/></label>}
    {loading && <Skeleton active paragraph={{ rows: 3 }}/>} {error && <Alert type="warning" title={error}/>}
    <EndpointBody detail={detail} side={t('当前知识', 'Current item')} lang={lang} workspace={workspace} selected={selected} disabled={save.locked} onSelect={value => { setSelected(value); setComplete(false); }}/>
    {other && <EndpointBody detail={other} side={t('另一篇知识', 'Other item')} lang={lang} workspace={workspace} selected={otherSelected} disabled={save.locked} onSelect={value => { setOtherSelected(value); setComplete(false); }}/>}
    <label>{t('关系含义', 'Relation meaning')}<Select aria-label={t('关系含义', 'Relation meaning')} value={draft.type} disabled={save.locked} onChange={value => change({ type: value })} options={[{ value: 'supplements', label: t('补充：一篇为另一篇增加内容或限制', 'Supplements: adds content or limitations') }, { value: 'conflicts_with', label: t('冲突：条件可比且主张不能同时成立', 'Conflicts: comparable claims cannot both hold') }]}/></label>
    <label>{t('关系方向', 'Relation direction')}<Select aria-label={t('关系方向', 'Relation direction')} value={draft.direction} disabled={save.locked || !!previous} onChange={value => change({ direction: value })} options={[{ value: 'from', label: t('当前知识 → 另一篇', 'Current item → other item') }, { value: 'to', label: t('另一篇 → 当前知识', 'Other item → current item') }]}/></label>
    <label>{t('围绕什么问题比较', 'Question being compared')}<Input aria-label={t('关系问题', 'Relation question')} value={draft.question} maxLength={4096} disabled={save.locked} onChange={event => change({ question: event.target.value })}/></label>
    <label>{t('适用条件（每行一条）', 'Applicability conditions (one per line)')}<Input.TextArea aria-label={t('关系适用条件', 'Relation conditions')} rows={2} value={draft.conditions} disabled={save.locked} onChange={event => change({ conditions: event.target.value })}/></label>
    <label>{t('比较条件是否相同', 'Are the comparison conditions the same?')}<Select aria-label={t('比较条件是否相同', 'Are the comparison conditions the same?')} value={draft.comparisonScope.status} disabled={save.locked} onChange={value => change({ comparisonScope: { ...draft.comparisonScope, status: value } })} options={[{ value: 'unknown', label: t('未知：尚未确认可比', 'Unknown: comparability not established') }, { value: 'same', label: t('可比：已逐项说明', 'Same: described below') }, { value: 'different', label: t('不同：不能据此认定冲突', 'Different: cannot establish a conflict') }]}/></label>
    {(['subject', 'modality', 'time', 'version', 'reason'] as const).map((field, index) => <label key={field}>{[t('比较主体', 'Compared subject'), t('语气／主张方式', 'Claim modality'), t('适用时间（未知请说明）', 'Applicable time (explain if unknown)'), t('适用版本（未知请说明）', 'Applicable version (explain if unknown)'), t('比较条件的判断依据', 'Reason for comparability')][index]}<Input aria-label={`comparison-${field}`} value={draft.comparisonScope[field]} maxLength={4096} disabled={save.locked} onChange={event => change({ comparisonScope: { ...draft.comparisonScope, [field]: event.target.value } })}/></label>)}
    {draft.type === 'conflicts_with' && draft.comparisonScope.status !== 'same' && <Alert type="warning" title={draft.comparisonScope.status === 'different' ? t('条件不同，不能提出冲突；请改为补充或重新核对。', 'Different conditions cannot form a conflict. Choose supplements or check the scope again.') : t('条件未知时只能保留待核对提案，不能接受为已核对冲突。', 'Unknown scope may be recorded only as a pending proposal; it cannot be accepted as a verified conflict.')}/>}
    <label>{t('关系依据性质', 'Relation basis')}<Select aria-label={t('关系依据性质', 'Relation basis')} value={draft.basis} disabled={save.locked} onChange={value => change({ basis: value })} options={[{ value: 'inference', label: t('我的推断', 'My inference') }, { value: 'source_assertion', label: t('来源明确提出', 'Asserted by a source') }]}/></label>
    <label>{t('关系理由', 'Relation reason')}<Input.TextArea aria-label={t('关系理由', 'Relation reason')} rows={3} maxLength={4096} value={draft.reason} disabled={save.locked} onChange={event => change({ reason: event.target.value })}/></label>
    <label>{t('限制（每行一条）', 'Limitations (one per line)')}<Input.TextArea aria-label={t('关系限制', 'Relation limitations')} rows={2} value={draft.limitations} disabled={save.locked} onChange={event => change({ limitations: event.target.value })}/></label>
    <p className="candidate-help">{t(`已从所选正文段落及其原来源构造 ${evidence.length} 条精确依据。至少各选一段。`, `${evidence.length} exact evidence items come from the selected body segments and their original sources. Choose at least one segment on each side.`)}</p>
    <Checkbox checked={complete} disabled={save.locked || !other || !sourceReady(detail) || !sourceReady(other)} onChange={event => setComplete(event.target.checked)}>{t('已核读两端完整正文、原来源、比较条件及所选段落；新提案仍待核对。', 'I checked both complete bodies, original sources, comparison scope and selected segments. The new proposal remains pending.')}</Checkbox>
    {save.error && <Alert type="warning" title={save.error}/>}{save.unknown && <Button loading={save.busy} onClick={() => void save.inspect().then(result => { if (result?.current()) onSaved(); })}>{t('只读核对原请求回执', 'Check the original receipt (read-only)')}</Button>}
    {save.receipt && <p role="status">{t('提案已保存，仍待核对。', 'Proposal saved; it remains pending.')} <code>{save.receipt.eventId}</code></p>}
    <Button type="primary" disabled={!valid || save.locked} loading={save.busy} onClick={() => void propose()}>{t('保存待核对提案', 'Save pending proposal')}</Button>
  </div>;
}

/** This tab reads only explicit workspace/body selections and never starts a model. */
export function RelatedKnowledge({ detail, workspace, lang, active = true, selectionId, selectionRevisionId }: { detail: KnowledgeCandidateDetail; workspace: string; lang: Language; active?: boolean; selectionId?: string; selectionRevisionId?: string }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [list, setList] = useState<RelationList>(), [catalog, setCatalog] = useState<KnowledgeLibraryKnowledge>(), [failed, setFailed] = useState(false), [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0), [selected, setSelected] = useState(''), [relation, setRelation] = useState<KnowledgeRelationStatus>(), [reading, setReading] = useState(false);
  const [selectedRevision, setSelectedRevision] = useState<string>();
  const [editing, setEditing] = useState(false), [previous, setPrevious] = useState<Relation>();
  const [guarded, setGuarded] = useState(false);
  const [editorId, setEditorId] = useState(0);
  const [inspectionId, setInspectionId] = useState(0);
  const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [activated, setActivated] = useState(active);
  useEffect(() => { if (active) setActivated(true); }, [active]);
  useEffect(() => { if (active && selectionId) { setSelected(selectionId); setSelectedRevision(selectionRevisionId); setEditing(false); } }, [active, selectionId, selectionRevisionId]);
  const context = JSON.stringify([workspace, reviewBodyRef(detail)]);
  useEffect(() => {
    if (!activated) return;
    const controller = new AbortController(); setLoading(true); setFailed(false);
    void Promise.allSettled([requestKnowledge<RelationList>('relations', { workspace, operation: 'relations', bodyRef: reviewBodyRef(detail) }, controller.signal),
      requestKnowledge<KnowledgeLibraryKnowledge>('library', { workspace, operation: 'knowledge' }, controller.signal)])
      .then(([relations, directory]) => { if (controller.signal.aborted) return;
        if (relations.status === 'fulfilled' && sameBody(relations.value.bodyRef, reviewBodyRef(detail))) setList(relations.value); else setFailed(true);
        if (directory.status === 'fulfilled') setCatalog(directory.value); else setFailed(true);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [context, version, activated]);
  useEffect(() => {
    const controller = new AbortController(); setRelation(undefined); if (!selected) return;
    setReading(true);
    void requestKnowledge<KnowledgeRelationStatus>('relations', { workspace, operation: 'relation', relationId: selected, ...(selectedRevision ? { relationRevisionId: selectedRevision } : {}) }, controller.signal).then(value => {
      if (!controller.signal.aborted) { if (value.relationId !== selected || value.storageStatus === 'available' && selectedRevision && value.revision.eventId !== selectedRevision) throw new Error('Relation identity mismatch.'); setRelation(value); }
    }).catch(() => { if (!controller.signal.aborted) setRelation({ relationId: selected, storageStatus: 'unavailable', reason: 'Relation read failed.' }); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [workspace, selected, selectedRevision, version, inspectionId]);
  const saved = () => { if (mounted.current) { setVersion(value => value + 1); window.dispatchEvent(new CustomEvent('omk-knowledge-changed', { detail: workspace })); } };
  if (!activated) return null;
  return <section aria-label={t('相关知识', 'Related knowledge')} className="knowledge-relations">
    <h3>{t('相关知识', 'Related knowledge')}</h3><p>{t('补充与冲突是有条件、可追溯的意见。接受意见不等于事实已被证实。', 'Supplements and conflicts are conditional, traceable opinions. Acceptance does not establish truth.')}</p>
    {failed && <Alert type="warning" title={t('关系或知识目录不可读，不能据此判断没有关系。', 'The relation history or knowledge directory could not be read. This does not establish that no relations exist.')} action={<Button disabled={guarded} onClick={() => setVersion(value => value + 1)}>{t('重试读取', 'Retry reading')}</Button>}/>}
    {loading && <Skeleton active paragraph={{ rows: 2 }}/>} {list?.completeness === 'partial' && <Alert type="warning" title={t('关系目录覆盖不完整；不可读记录保留为缺口。', 'Relation coverage is partial; unreadable records remain explicit gaps.')}/>}
    {list && !list.relations.length && !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('此精确正文尚无可读关系。可选另一篇核对后提出。', 'No readable relation binds this exact body. Choose another item and compare them to propose one.')}/>}
    <Space wrap>{list?.relations.map(item => <Button disabled={guarded} key={item.relationId} onClick={() => { setSelected(item.relationId); setSelectedRevision(item.revision.eventId); setEditing(false); }}>{relationLabel(item.revision.relationType, lang)} · {item.revision.question} · {opinionLabel(item.opinionStatus, lang)}</Button>)}</Space>
    <p><Button disabled={!catalog || loading || guarded} onClick={() => { setPrevious(undefined); setEditing(true); setSelected(''); setEditorId(value => value + 1); }}>{t('选择另一篇并提出关系', 'Choose another item and propose a relation')}</Button></p>
    {reading && <Skeleton active paragraph={{ rows: 3 }}/>} {!editing && relation?.storageStatus === 'available' && <><RelationReview key={`${context}/${relation.relationId}/${relation.revision.eventId}/${inspectionId}`} relation={relation} workspace={workspace} lang={lang} onSaved={saved} onGuard={setGuarded}/>
      <p><Button disabled={guarded} onClick={() => setInspectionId(value => value + 1)}>{t('重新读取关系并开始新意见', 'Reload relation and start a new opinion')}</Button></p>
      {relation.isCurrentRevision ? <Button disabled={guarded} onClick={() => { setPrevious(relation); setEditing(true); }}>{t('修订提案／重新绑定版本（重新待审）', 'Revise proposal / rebind versions (pending again)')}</Button>
        : <Button disabled={guarded} onClick={() => setSelectedRevision(undefined)}>{t('查看本关系最新提案', 'Read the latest proposal for this relation')}</Button>}</>}
    {!editing && relation && relation.storageStatus !== 'available' && <Alert type="warning" title={relation.storageStatus === 'absent' ? t('该关系记录不存在；不能自动重发之前的写入。', 'This relation record is absent. Previous writes are not resent automatically.') : t('该关系记录不可读，无法确认状态。', 'This relation record cannot be read; its status is unknown.')}/>}
    {editing && <RelationProposal key={`${context}/${previous?.relationId ?? editorId}/${previous?.revision.eventId ?? ''}`} detail={detail} workspace={workspace} lang={lang} catalog={catalog} previous={previous} onSaved={saved} onGuard={setGuarded}/>}
  </section>;
}

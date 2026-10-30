'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, Space, Spin } from 'antd';
import type { SourceReviewApplication } from '../../../../knowledge/application/source-review';
import type { SourceLedgerRef, SourceCoverageRef, SourceCoverageDecisionRef, SourceCoverageWrite,
  SourceReviewReceipt, SourceCoverageData, SourceReviewEvidence } from '../../../../knowledge/source-review';
import type { Language } from '../layout/shell';
import { requestKnowledge, KnowledgeRequestError } from './request';
import { useKnowledgeSave } from './save-session';
import { notifyKnowledgeChange } from './workspace';

type Ledger = ReturnType<SourceReviewApplication['ledger']>;
type Coverage = ReturnType<SourceReviewApplication['coverage']> & { ledgerStatus: 'available' | 'unavailable'; unresolvedIds: string[] | null };
type Command = Exclude<SourceCoverageWrite, { commandKind: 'append_analysis' }>;
type Decision = Extract<Command, { commandKind: 'record_decision' }>['decision'];
type DraftDisposition = { disposition?: Decision['dispositions'][number]['disposition']; reason: string };
type ReviewIssue = { id: string; group: string; groupLabel: string; reason: string;
  target?: SourceCoverageData['checks'][number]['target']; sourceEvidence: SourceReviewEvidence[];
  bodyEvidence: SourceCoverageData['checks'][number]['bodyEvidence']; unknown?: boolean;
  boundedInput?: SourceCoverageData['checks'][number]['boundedInput'] };
type Props = { workspace: string; ledgerRef?: SourceLedgerRef; coverageRef?: SourceCoverageRef; lang?: Language;
  onProceed?(ref: SourceCoverageDecisionRef): void };
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
function comparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${comparable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const same = (left: unknown, right: unknown) => comparable(left) === comparable(right);
async function readCoverage(workspace: string, ref: SourceCoverageRef, signal: AbortSignal): Promise<Coverage> {
  const value = await requestKnowledge<Coverage>('candidates', { workspace, operation: 'source-coverage-status', id: ref.coverageId, revision: ref.revisionId }, signal);
  if (!same(value.ref, ref) || value.history.coverageId !== ref.coverageId || value.revision.revisionId !== ref.revisionId
    || value.revision.digest !== ref.digest || !['available', 'unavailable'].includes(value.ledgerStatus)
    || value.unresolvedIds !== null && (!Array.isArray(value.unresolvedIds) || value.unresolvedIds.some(id => typeof id !== 'string'))) {
    throw new Error('Source coverage response identity mismatch.');
  }
  return value;
}
async function readLedger(workspace: string, ref: SourceLedgerRef, signal: AbortSignal): Promise<Ledger> {
  const value = await requestKnowledge<Ledger>('candidates', { workspace, operation: 'source-ledger', id: ref.ledgerId, revision: ref.revisionId }, signal);
  if (!same(value.ref, ref)) throw new Error('Source ledger response identity mismatch.');
  return value;
}
function matchesReceipt(status: Coverage, command: Command): boolean {
  const receipt = status.history.receipts.find(receipt => receipt.requestId === command.requestId
    && receipt.eventId === command.requestId && receipt.committedGeneration === command.expectedGeneration + 1);
  const event = status.history.events.find(event => event.eventId === receipt?.eventId);
  if (!receipt || !/^sha256:[a-f0-9]{64}$/.test(receipt.commandDigest) || !event || event.parentEventId !== command.expectedHeadEventId) return false;
  return command.commandKind === 'record_decision' ? event.eventKind === 'decision' && same(event.decision, command.decision)
    : event.eventKind === 'revocation' && event.targetEventId === command.targetEventId && event.reason === command.reason;
}

/** Source analysis, actual review and the later model request stay separate actions. */
export function SourceReviewPanel(props: Props) {
  const context = comparable([props.workspace, props.ledgerRef, props.coverageRef]);
  return <SourceReviewSession key={context} {...props}/>;
}
function SourceReviewSession(props: Props) {
  const [{ workspace, ledgerRef, coverageRef }] = useState(() => structuredClone({ workspace: props.workspace, ledgerRef: props.ledgerRef, coverageRef: props.coverageRef }));
  const { lang = 'zh', onProceed } = props;
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [coverage, setCoverage] = useState<Coverage>(), [ledger, setLedger] = useState<Ledger>();
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [ledgerFailed, setLedgerFailed] = useState(false);
  const [version, setVersion] = useState(0), [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setFailed(false); setLedgerFailed(false);
    void (async () => {
      const current = coverageRef ? await readCoverage(workspace, coverageRef, controller.signal) : undefined;
      if (ledgerRef && current && !same(ledgerRef, current.revision.data.ledgerRef)) throw new Error('Source review ledger mismatch.');
      let selected: Ledger | undefined, unavailable = false;
      const ref = current?.revision.data.ledgerRef ?? ledgerRef;
      if (ref) try { selected = await readLedger(workspace, ref, controller.signal); } catch { unavailable = true; }
      if (!controller.signal.aborted) { setCoverage(current); setLedger(selected); setLedgerFailed(unavailable); }
    })().catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspace, ledgerRef, coverageRef, version]);
  const refresh = () => { notifyKnowledgeChange(workspace); setVersion(value => value + 1); };
  const ready = coverage && coverage.ledgerStatus === 'available' && coverage.unresolvedIds !== null && ledger && !ledgerFailed && coverage.sources.every(source => source.status === 'available')
    && coverage.bodies.every(body => body.status === 'available');
  return <section className="candidate-form" aria-label={t('来源完整性复核', 'Source completeness review')} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3>{t('核对来源与正文', 'Check sources against content')}</h3>
    <p className="candidate-help">{t('模型清单和覆盖判断仍是意见。请检查遗漏、未知和排除项，再记录本次决定。', 'The model inventory and coverage checks are opinions. Inspect omissions, unknowns and exclusions before recording your decision.')}</p>
    {notice && <p role="status">{notice}</p>}
    {loading ? <Spin aria-label={t('正在读取来源复核', 'Loading source review')}/> : failed ? <>
      <Alert type="warning" title={t('来源复核未能读取，不能据此判断没有问题。', 'Source review could not be read; this does not establish no findings.')}/>
      <Button onClick={() => setVersion(value => value + 1)}>{t('重新读取', 'Reload')}</Button>
    </> : <>
      {!ledger && ledgerFailed && <Alert type="warning" title={t('来源清单暂不可读。已有核对意见保留；目前不能保存新决定，仍可撤销旧意见。', 'The source inventory is unavailable. Existing opinions remain visible. New decisions are unavailable; prior opinions can still be revoked.')}/>}
      {ledger && <LedgerSummary ledger={ledger} lang={lang}/>}
      {!coverage ? <p>{t('尚未指定覆盖核对记录。请先单独准备并确认来源核对请求。', 'No coverage analysis was selected. Prepare and confirm a source coverage request separately.')}</p> : <>
        <CoverageSummary coverage={coverage} lang={lang}/>
        {!ready && <p role="status">{t('来源、正文或清单当前不可读；不会据此准备新的关联请求。', 'A source, body or inventory is unavailable; a new association request cannot be prepared here.')}</p>}
        <DecisionForm key={`${coverage.history.generation}/${coverage.history.writeHeadEventId}`} workspace={workspace} baseline={coverage} ledger={ledger}
          writable={!!ready} lang={lang} onSaved={() => { setNotice(t('已保存本次来源意见，正在读回记录。', 'The source opinion was saved; reloading its record.')); refresh(); }}/>
        {onProceed && coverage.decision.status === 'proceed_with_limits'
          && coverage.decision.events.map(event => <section key={event.eventId} className="candidate-statement">
            <p>{t('实际复核意见：', 'Actual review opinion: ')}{event.decision.reason}</p>
            <p className="candidate-help">{event.actor.actorKind}/{event.actor.actorId} · <code>{event.eventId}</code></p>
            <Button disabled={!ready} onClick={() => {
              const { coverageRef: ref, sourceSetId, ledgerRef: selectedLedger, bodyRefs } = event.decision;
              onProceed({ coverageRef: ref, sourceSetId, ledgerRef: selectedLedger, bodyRefs, eventId: event.eventId });
            }}>{coverage.revision.data.bodyRefs.length ? t('按此意见准备关联', 'Prepare associations with this opinion') : t('按此意见结束本轮（无正文）', 'End this run with this opinion (no content)')}</Button>
            <p className="candidate-help">{coverage.revision.data.bodyRefs.length ? t('只准备请求；发送到模型仍需另一次明确确认。', 'This only prepares a request. Sending it to a model requires separate confirmation.') : t('只结束本轮，不生成关联或调用模型。', 'This only ends the run, without generating associations or calling a model.')}</p>
          </section>)}
      </>}
    </>}
  </section>;
}
function LedgerSummary({ ledger, lang }: { ledger: Ledger; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const labels = { retain: t('建议保留', 'Proposed retention'), exclude: t('建议排除', 'Proposed exclusion'), pending: t('尚待判断', 'Pending') };
  return <details className="extraction-invocation"><summary>{t('来源清单、排除项与待定项', 'Inventory, exclusions and pending items')}</summary>
    <p>{t('来源单位：', 'Source units: ')}{ledger.revision.data.unitDispositions.length}</p>
    {ledger.revision.data.unitDispositions.map(unit => <p key={unit.unitKey}><code>{unit.unitKey}</code> · {labels[unit.disposition]} · {unit.reason}</p>)}
    {ledger.revision.data.items.map(item => <section key={item.itemId} className="candidate-statement"><p><code>{item.itemId}</code> · {item.statement}</p>
      <p>{labels[item.disposition]} · {item.reason}</p>
      {item.facets.map(facet => <div key={facet.facetId}><p><code>{facet.facetId}</code> · {facet.statement} · <code>{facet.epistemicStatus}</code></p><SourceQuotes evidence={facet.evidence} lang={lang}/></div>)}
      <SourceQuotes evidence={item.evidence} lang={lang}/>
    </section>)}
    <ul>{ledger.revision.data.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
  </details>;
}
function SourceQuotes({ evidence, lang }: { evidence: SourceReviewEvidence[]; lang: Language }) {
  if (!evidence.length) return null;
  return <details><summary>{lang === 'zh' ? '查看已保存的精确引文' : 'Inspect saved exact quotations'}</summary>
    {evidence.map((quote, index) => <blockquote key={index} className="knowledge-segment-text">{quote.quote}
      <p className="candidate-help">{quote.unitKind === 'source_metadata' ? (lang === 'zh' ? '来源元数据' : 'Source metadata') : (lang === 'zh' ? '来源原文片段' : 'Source excerpt')}
        {' · '}<code>{quote.unitKey} · {quote.start}–{quote.end}</code></p></blockquote>)}
  </details>;
}
function CoverageSummary({ coverage, lang }: { coverage: Coverage; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const labels = { covered: t('已表达', 'Expressed'), partial: t('部分遗漏', 'Partial'), omitted: t('遗漏', 'Omitted'),
    contradicted: t('矛盾', 'Contradicted'), not_retained: t('未保留', 'Not retained'), unassessable: t('无法判断', 'Unassessable') };
  const targets = { knowledge_meaning: t('知识含义', 'Knowledge meaning'), preserved_source_declared_unknown: t('保留来源明确的未知', 'Preserved source-declared unknown'),
    preserved_bounded_input_limitation: t('保留本次输入范围限制', 'Preserved input limitation'), factual_value: t('具体事实值', 'Factual value') };
  const opinions = { not_reviewed: t('尚未复核', 'Not reviewed'), disputed: t('存在相互冲突的意见', 'Conflicting opinions'),
    proceed_with_limits: t('已明确允许保留限制后继续', 'Proceed with limits recorded'), needs_revision: t('需要修订', 'Needs revision'), stop: t('已明确停止', 'Stop recorded') };
  return <>
    <p>{t('实际决定状态：', 'Actual decision status: ')}{opinions[coverage.decision.status]} · {coverage.unresolvedIds === null ? t('未决项状态未知，不能保存新决定。', 'Unresolved items are unknown; new decisions are unavailable.') : `${coverage.unresolvedIds.length} ${t('项需逐项处置', 'items requiring a disposition')}`}</p>
    {!coverage.revision.data.bodyRefs.length && <p role="status">{t('本轮没有保存正文，来源遗漏仍须核对。', 'No content was saved in this run; source omissions still require review.')}</p>}
    <ul>{coverage.revision.data.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
    <details open className="extraction-invocation"><summary>{t('逐项核对与额外发现', 'Checks and additional findings')}</summary>
      <div style={{ maxHeight: '32dvh', overflow: 'auto', overscrollBehavior: 'contain' }}>
        {coverage.revision.data.checks.map(check => <section key={check.checkId} className="candidate-statement"><p><code>{check.checkId}</code> · {targets[check.coverageTarget]} · {labels[check.status]}</p>
          <details><summary>{t('核对目标与精确版本', 'Target and exact versions')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(check.target, null, 2)}</pre></details>
          <p>{check.reason}</p>{check.factualValue === 'unknown' && <p>{t('具体事实值仍未知。', 'The factual value remains unknown.')}</p>}
          {check.boundedInput && <p>{t('仅限本次完整输入：', 'Bounded to this complete input: ')}{check.boundedInput.scope} · {check.boundedInput.inspectedFields.join(', ')}</p>}
          <SourceQuotes evidence={check.sourceEvidence} lang={lang}/>
          <BodyQuotes evidence={check.bodyEvidence} lang={lang}/>
        </section>)}
        {coverage.revision.data.findings.map(finding => <section key={finding.findingId} className="candidate-statement"><p>{t('额外发现：', 'Additional finding: ')}<code>{finding.findingKind}/{finding.findingId}</code></p>
          <p>{finding.reason}</p><SourceQuotes evidence={finding.sourceEvidence} lang={lang}/><BodyQuotes evidence={finding.bodyEvidence} lang={lang}/>
        </section>)}
      </div>
    </details>
    <details className="extraction-invocation"><summary>{t('意见与撤销历史', 'Opinion and revocation history')}</summary>
      {coverage.history.events.map(event => <section key={event.eventId} className="candidate-statement"><p><code>{event.eventId}</code> · {event.actor.actorKind}/{event.actor.actorId}</p>
        {event.eventKind === 'decision' ? <><p>{opinions[event.decision.decisionKind]} · {event.decision.reason}</p><ul>{event.decision.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></>
          : event.eventKind === 'revocation' ? <p>{t('撤销意见：', 'Revoked opinion: ')}<code>{event.targetEventId}</code> · {event.reason}</p>
            : <p>{t('模型核对版本：', 'Model analysis revision: ')}<code>{event.revision.revisionId}</code></p>}
      </section>)}
    </details>
  </>;
}
function BodyQuotes({ evidence, lang }: { evidence: SourceCoverageData['checks'][number]['bodyEvidence']; lang: Language }) {
  if (!evidence.length) return null;
  return <details><summary>{lang === 'zh' ? '查看对应正文引文' : 'Inspect matching content quotations'}</summary>
    {evidence.map((quote, index) => <blockquote key={index} className="knowledge-segment-text">{quote.quote}<p className="candidate-help">
      <code>{quote.bodyRef.knowledgeId}/{quote.bodyRef.revisionId} · {quote.segmentId} · {quote.start}–{quote.end}</code></p></blockquote>)}
  </details>;
}
function reviewIssues(coverage: Coverage, ledger: Ledger | undefined, lang: Language): ReviewIssue[] {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const dispositions = { retain: t('建议保留', 'Proposed retention'), exclude: t('建议排除', 'Proposed exclusion'), pending: t('尚待判断', 'Pending') };
  const statuses = { covered: t('已表达', 'Expressed'), partial: t('部分遗漏', 'Partial'), omitted: t('遗漏', 'Omitted'),
    contradicted: t('矛盾', 'Contradicted'), not_retained: t('未保留', 'Not retained'), unassessable: t('无法判断', 'Unassessable') };
  const targets = { knowledge_meaning: t('知识含义', 'Knowledge meaning'), preserved_source_declared_unknown: t('来源明确的未知', 'Source-declared unknown'),
    preserved_bounded_input_limitation: t('输入范围限制', 'Input limitation'), factual_value: t('具体事实值', 'Factual value') };
  const findingKinds = { ledger_omission: t('清单遗漏', 'Inventory omission'), ledger_error: t('清单错误', 'Inventory error'),
    body_unsupported: t('正文依据不足', 'Unsupported content'), body_omission: t('正文遗漏', 'Content omission'), scope_error: t('范围错误', 'Scope error'), other: t('其它发现', 'Other finding') };
  const units = new Map(ledger?.revision.data.unitDispositions.map(unit => [`unit:${unit.unitKey}`, unit]));
  const items = new Map(ledger?.revision.data.items.map(item => [`item:${item.itemId}`, item]));
  const checks = new Map(coverage.revision.data.checks.map(check => [`check:${check.checkId}`, check]));
  const findings = new Map(coverage.revision.data.findings.map(finding => [`finding:${finding.findingId}`, finding]));
  return (coverage.unresolvedIds ?? []).map<ReviewIssue>(id => {
    const unit = units.get(id), item = items.get(id), check = checks.get(id), finding = findings.get(id);
    if (unit) return { id, group: `unit:${unit.disposition}`, groupLabel: `${t('来源单位', 'Source units')} · ${dispositions[unit.disposition]}`,
      reason: unit.reason, target: { targetKind: 'source_unit', unitKey: unit.unitKey }, sourceEvidence: [], bodyEvidence: [] };
    if (item) return { id, group: `item:${item.disposition}`, groupLabel: `${t('清单条目', 'Inventory items')} · ${dispositions[item.disposition]}`,
      reason: item.reason, target: { targetKind: 'ledger_item', itemId: item.itemId }, sourceEvidence: item.evidence, bodyEvidence: [] };
    if (check) return { id, group: `check:${check.coverageTarget}:${check.status}`, groupLabel: `${targets[check.coverageTarget]} · ${statuses[check.status]}`,
      reason: check.reason, target: check.target, sourceEvidence: check.sourceEvidence, bodyEvidence: check.bodyEvidence,
      unknown: check.factualValue === 'unknown', boundedInput: check.boundedInput };
    if (finding) return { id, group: `finding:${finding.findingKind}`, groupLabel: `${t('额外发现', 'Additional findings')} · ${findingKinds[finding.findingKind]}`,
      reason: finding.reason, sourceEvidence: finding.sourceEvidence, bodyEvidence: finding.bodyEvidence };
    return { id, group: 'unavailable', groupLabel: t('问题详情不可读', 'Issue details unavailable'),
      reason: t('未能定位本项的原始判断，请重新读取后核对。', 'The original issue could not be located. Reload and inspect it.'), sourceEvidence: [], bodyEvidence: [] };
  });
}
function ReviewTarget({ target, coverage, ledger, lang }: { target: NonNullable<ReviewIssue['target']>; coverage: Coverage; ledger?: Ledger; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const unit = target.targetKind === 'source_unit' ? coverage.revision.data.manifest.units.find(unit => unit.unitKey === target.unitKey) : undefined;
  const source = unit && coverage.revision.data.manifest.sources.find(source => source.sourceKey === unit.sourceKey);
  const item = target.targetKind === 'ledger_item' || target.targetKind === 'ledger_facet' ? ledger?.revision.data.items.find(item => item.itemId === target.itemId) : undefined;
  const facet = target.targetKind === 'ledger_facet' ? item?.facets.find(facet => facet.facetId === target.facetId) : undefined;
  return <>
    {unit && <p>{unit.unitKind === 'source_metadata' ? t('来源元数据', 'Source metadata') : t('来源原文片段', 'Source excerpt')}
      {' · '}<code>{unit.sourceKey}{unit.evidenceRef ? ` · ${unit.evidenceRef}` : ''}</code></p>}
    {item && <p>{item.statement}</p>}{facet && <p>{facet.statement}</p>}
    {target.targetKind === 'body_segment' && <p>{t('正文段落：', 'Content segment: ')}<code>{target.segmentId}</code></p>}
    <details><summary>{t('核对目标与精确版本', 'Target and exact versions')}</summary>
      {unit?.unitKind === 'source_metadata' && <p className="candidate-help">{unit.fieldPaths.join(', ')}</p>}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(source ? { ...target, sourceRef: source.sourceRef } : target, null, 2)}</pre>
    </details>
  </>;
}
function DispositionGroup({ issues, coverage, ledger, dispositions, editable, lang, onChange }: {
  issues: ReviewIssue[]; coverage: Coverage; ledger?: Ledger; dispositions: Record<string, DraftDisposition>; editable: boolean; lang: Language;
  onChange(ids: string[], value: DraftDisposition): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [selected, setSelected] = useState<string[]>([]), [disposition, setDisposition] = useState<Decision['dispositions'][number]['disposition'] | ''>('');
  const [reason, setReason] = useState(''), [notice, setNotice] = useState('');
  const label = issues[0].groupLabel;
  const apply = () => {
    if (!editable || !selected.length || !disposition || !reason.trim()) return;
    onChange(selected, { disposition, reason: reason.trim() });
    setNotice(t(`已填入所选 ${selected.length} 项草稿，尚未保存。`, `Filled ${selected.length} selected drafts; nothing has been saved.`));
    setSelected([]); setDisposition(''); setReason('');
  };
  return <fieldset className="knowledge-review-fields">
    <legend>{label} · {issues.length}</legend>
    <details className="extraction-invocation"><summary>{t('批量填写本组草稿', 'Fill selected drafts in this group')} · {selected.length} {t('项已选', 'selected')}</summary>
      <div className="candidate-form">
        <p className="candidate-help">{t('先核对并选择同类事项，再填写共同处置和理由。只填入所选草稿，不保存意见或准备模型请求；已有草稿会被替换。', 'Inspect and select similar issues, then enter their shared disposition and reason. Only selected drafts are filled; existing drafts are replaced. No opinion is saved or model request prepared.')}</p>
        <Checkbox disabled={!editable} aria-label={t(`选择「${label}」本组全部事项`, `Select all issues in ${label}`)} checked={selected.length === issues.length}
          indeterminate={selected.length > 0 && selected.length < issues.length} onChange={event => setSelected(event.target.checked ? issues.map(issue => issue.id) : [])}>
          {t(`选择本组 ${issues.length} 项`, `Select all ${issues.length} issues in this group`)}
        </Checkbox>
        <label>{t('共同处置', 'Shared disposition')}<select disabled={!editable} style={{ maxWidth: '100%' }} aria-label={t(`「${label}」的共同处置`, `Shared disposition for ${label}`)}
          value={disposition} onChange={event => setDisposition(event.target.value as typeof disposition)}>
          <option value="">{t('请选择', 'Choose a disposition')}</option><option value="accepted_limit">{t('明确接受为限制', 'Accept as a limitation')}</option>
          <option value="resolved">{t('已核对解决', 'Reviewed as resolved')}</option><option value="blocks">{t('阻止继续', 'Blocks continuation')}</option>
        </select></label>
        <label>{t('共同理由', 'Shared reason')}<Input.TextArea readOnly={!editable} aria-label={t(`「${label}」的共同理由`, `Shared reason for ${label}`)}
          value={reason} rows={2} maxLength={4096} onChange={event => setReason(event.target.value)}/></label>
        <Button disabled={!editable || !selected.length || !disposition || !reason.trim()} onClick={apply}
          aria-label={t(`将「${label}」的处置和理由填入所选草稿`, `Fill selected drafts in ${label}`)}>{t(`填入所选 ${selected.length} 项草稿`, `Fill ${selected.length} selected drafts`)}</Button>
      </div>
    </details>
    {notice && <p role="status">{notice}</p>}
    {issues.map(issue => <section key={issue.id} className="candidate-statement">
      <Checkbox disabled={!editable} aria-label={t(`选择问题 ${issue.id}`, `Select issue ${issue.id}`)} checked={selected.includes(issue.id)}
        onChange={event => setSelected(values => event.target.checked ? [...values, issue.id] : values.filter(id => id !== issue.id))}><code>{issue.id}</code></Checkbox>
      {issue.target && <ReviewTarget target={issue.target} coverage={coverage} ledger={ledger} lang={lang}/>}
      <p>{issue.reason}</p>
      {issue.unknown && <p>{t('具体事实值仍未知。', 'The factual value remains unknown.')}</p>}
      {issue.boundedInput && <p>{t('仅限本次完整输入：', 'Bounded to this complete input: ')}{issue.boundedInput.scope} · {issue.boundedInput.inspectedFields.join(', ')}</p>}
      <SourceQuotes evidence={issue.sourceEvidence} lang={lang}/><BodyQuotes evidence={issue.bodyEvidence} lang={lang}/>
      <label>{t('本项处置', 'Disposition')}<select disabled={!editable} style={{ maxWidth: '100%' }} aria-label={t(`问题 ${issue.id} 的处置`, `Disposition for ${issue.id}`)}
        value={dispositions[issue.id]?.disposition ?? ''} onChange={event => onChange([issue.id], { reason: dispositions[issue.id]?.reason ?? '', disposition: event.target.value as DraftDisposition['disposition'] })}>
        <option value="">{t('请选择', 'Choose a disposition')}</option><option value="accepted_limit">{t('明确接受为限制', 'Accept as a limitation')}</option>
        <option value="resolved">{t('已核对解决', 'Reviewed as resolved')}</option><option value="blocks">{t('阻止继续', 'Blocks continuation')}</option>
      </select></label>
      <label>{t('本项理由', 'Reason for this item')}<Input.TextArea readOnly={!editable} aria-label={t(`问题 ${issue.id} 的理由`, `Reason for ${issue.id}`)}
        value={dispositions[issue.id]?.reason ?? ''} rows={2} maxLength={4096} onChange={event => onChange([issue.id], { ...dispositions[issue.id], reason: event.target.value })}/></label>
    </section>)}
  </fieldset>;
}
function DecisionForm({ workspace, baseline, ledger, writable, lang, onSaved }: { workspace: string; baseline: Coverage; ledger?: Ledger; writable: boolean; lang: Language; onSaved(): void }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [requestId] = useState(() => crypto.randomUUID()), [mode, setMode] = useState<'record' | 'revoke'>('record');
  const [decisionKind, setDecisionKind] = useState<Decision['decisionKind'] | ''>(''), [reason, setReason] = useState(''), [limitations, setLimitations] = useState('');
  const [dispositions, setDispositions] = useState<Record<string, DraftDisposition>>({}), [supersedes, setSupersedes] = useState<string[]>([]), [target, setTarget] = useState('');
  const [conflicted, setConflicted] = useState(false), save = useKnowledgeSave<Command>(`${workspace}/${baseline.ref.coverageId}/${requestId}`);
  const locked = save.busy || save.uncertain || conflicted;
  const unresolvedIds = baseline.unresolvedIds ?? [];
  const groups = new Map<string, ReviewIssue[]>();
  for (const issue of reviewIssues(baseline, ledger, lang)) {
    const group = groups.get(issue.group);
    if (group) group.push(issue); else groups.set(issue.group, [issue]);
  }
  const editDispositions = (ids: string[], draft: DraftDisposition) => setDispositions(values => ({ ...values,
    ...Object.fromEntries(ids.map(id => [id, { ...draft }])) }));
  const missing = unresolvedIds.some(id => !dispositions[id]?.disposition || !dispositions[id]?.reason.trim());
  const blocked = unresolvedIds.some(id => dispositions[id]?.disposition === 'blocks');
  const invalid = !reason.trim() || (mode === 'revoke' ? !target : !writable || baseline.unresolvedIds === null || !decisionKind || !lines(limitations).length || missing || decisionKind === 'proceed_with_limits' && blocked);
  const common = { coverageId: baseline.ref.coverageId, requestId, expectedGeneration: baseline.history.generation, expectedHeadEventId: baseline.history.writeHeadEventId };
  async function submit() {
    if (invalid || locked) return;
    const command: Command = mode === 'revoke' ? { ...common, commandKind: 'revoke_decision', targetEventId: target, reason: reason.trim() }
      : { ...common, commandKind: 'record_decision', decision: { coverageRef: baseline.ref, sourceSetId: baseline.revision.data.manifest.sourceSetId,
        ledgerRef: baseline.revision.data.ledgerRef, bodyRefs: baseline.revision.data.bodyRefs, decisionKind: decisionKind as Decision['decisionKind'], reason: reason.trim(),
        limitations: lines(limitations), dispositions: unresolvedIds.map(unresolvedId => ({ unresolvedId,
          disposition: dispositions[unresolvedId].disposition!, reason: dispositions[unresolvedId].reason.trim() })), supersedesEventIds: supersedes } };
    const result = await save.session.save(structuredClone(command), async (command, signal) => {
      const receipt = await requestKnowledge<SourceReviewReceipt>('candidates', { workspace, operation: 'review-source-coverage', command }, signal);
      if (receipt.requestId !== command.requestId || receipt.eventId !== command.requestId || receipt.committedGeneration !== command.expectedGeneration + 1
        || !/^sha256:[a-f0-9]{64}$/.test(receipt.commandDigest)) throw new Error('Unconfirmed source review receipt.');
      return receipt;
    }, cause => {
      if (!(cause instanceof KnowledgeRequestError) || !cause.definiteRejection) return;
      if (cause.message === 'knowledge_conflict') { setConflicted(true); return t('记录已有更新，草稿与原基线已保留。请关闭面板后重新核对，不会重发。', 'The history changed. Your draft and baseline remain. Close and reopen to inspect it; no resubmission occurs.'); }
      return t('保存已明确拒绝，草稿保留。请核对填写内容和来源状态。', 'Saving was explicitly rejected. Your draft remains; inspect its fields and source state.');
    }, t('保存结果未知。草稿已锁定，请核对回执；不会自动重发。', 'The save outcome is unknown. Your draft is locked; inspect its receipt. It will not be resubmitted automatically.'));
    if (result?.current()) onSaved();
  }
  async function inspect() {
    const result = await save.session.inspect((command, signal) => readCoverage(workspace, { ...baseline.ref, coverageId: command.coverageId }, signal), matchesReceipt,
      t('尚未找到与本次完整决定一致的回执，草稿仍锁定。', 'No receipt matching this complete command was found. The draft remains locked.'),
      t('回执暂不可读，草稿仍锁定；可以再次只读核对。', 'The receipt is unreadable. Your draft remains locked; retry the read-only check.'));
    if (result?.current()) onSaved();
  }
  return <div className="candidate-form">
    <h4>{t('记录本次实际决定', 'Record your actual decision')}</h4>
    {save.state.error && <Alert type="warning" title={save.state.error}/>}
    <fieldset className="knowledge-review-fields candidate-form">
      <label>{t('操作', 'Action')}<select disabled={locked} style={{ maxWidth: '100%' }} aria-label={t('来源复核操作', 'Source review action')} value={mode} onChange={event => setMode(event.target.value as 'record' | 'revoke')}>
        <option value="record">{t('记录决定', 'Record decision')}</option><option value="revoke" disabled={!baseline.decision.events.length}>{t('撤销已有意见', 'Revoke prior opinion')}</option>
      </select></label>
      {mode === 'record' ? <>
        <label>{t('本次决定', 'Your decision')}<select disabled={locked} style={{ maxWidth: '100%' }} aria-label={t('本次来源决定', 'Source decision')} value={decisionKind} onChange={event => setDecisionKind(event.target.value as Decision['decisionKind'] | '')}>
          <option value="">{t('请选择', 'Choose a decision')}</option><option value="proceed_with_limits">{t('保留限制，允许准备关联', 'Proceed with limits')}</option>
          <option value="needs_revision">{t('需要修订正文或清单', 'Needs revision')}</option><option value="stop">{t('停止本轮', 'Stop this run')}</option>
        </select></label>
        <label>{t('保留的限制（每行一项）', 'Limitations to preserve (one per line)')}<Input.TextArea readOnly={locked} aria-label={t('保留的限制', 'Preserved limitations')} value={limitations} rows={3} maxLength={32_768} onChange={event => setLimitations(event.target.value)}/></label>
        {[...groups].map(([key, issues]) => <DispositionGroup key={key} issues={issues} coverage={baseline} ledger={ledger} dispositions={dispositions}
          editable={!locked && writable} lang={lang} onChange={editDispositions}/>)}
        {decisionKind === 'proceed_with_limits' && blocked && <p role="status">{t('仍有阻止项，不能允许继续。', 'A blocking item prevents continuation.')}</p>}
        {!!baseline.decision.events.length && <details><summary>{t('明确替代旧意见（可选）', 'Explicitly supersede prior opinions (optional)')}</summary>
          {baseline.decision.events.map(event => <Checkbox disabled={locked} key={event.eventId} checked={supersedes.includes(event.eventId)} onChange={change => setSupersedes(values => change.target.checked ? [...values, event.eventId] : values.filter(id => id !== event.eventId))}>
            {event.decision.reason} · {event.actor.actorKind}/{event.actor.actorId} · <code>{event.eventId}</code>
          </Checkbox>)}
        </details>}
      </> : <label>{t('要撤销的意见', 'Opinion to revoke')}<select disabled={locked} style={{ maxWidth: '100%' }} aria-label={t('要撤销的意见', 'Opinion to revoke')} value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">{t('请选择', 'Choose an opinion')}</option>{baseline.decision.events.map(event => <option key={event.eventId} value={event.eventId}>{event.decision.reason} · {event.actor.actorId}</option>)}
      </select></label>}
      <label>{t('本次理由', 'Reason for this action')}<Input.TextArea readOnly={locked} aria-label={t('来源决定理由', 'Source decision reason')} value={reason} rows={3} maxLength={4096} onChange={event => setReason(event.target.value)}/></label>
    </fieldset>
    <Space wrap className="knowledge-review-actions"><Button type="primary" disabled={invalid || locked} loading={save.state.phase === 'saving'} onClick={() => void submit()}>{t('保存本次决定', 'Save this decision')}</Button>
      {save.uncertain && <Button disabled={save.state.phase === 'checking'} onClick={() => void inspect()}>{t('核对本次回执', 'Inspect this receipt')}</Button>}
    </Space>
    <p className="candidate-help">{t('保存决定不会发送模型。修改正文或清单后，需重新核对精确版本。', 'Saving a decision does not call a model. Changed content or inventory requires review of the new exact versions.')}</p>
  </div>;
}

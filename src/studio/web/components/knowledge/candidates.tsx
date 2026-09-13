'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail, KnowledgeCandidateRow, KnowledgeCandidateRun, KnowledgeCandidateSource } from '../../../view-models/knowledge-candidates';

export function KnowledgeCandidates({ lang, initialWorkspace = '' }: { lang: Language; initialWorkspace?: string }) {
  const zh = lang === 'zh';
  const t = (cn: string, en: string) => zh ? cn : en;
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [rows, setRows] = useState<KnowledgeCandidateRow[]>([]);
  const [detail, setDetail] = useState<KnowledgeCandidateDetail | null>(null);
  const [source, setSource] = useState('');
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [snapshot, setSnapshot] = useState<KnowledgeCandidateSource | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [runs, setRuns] = useState<KnowledgeCandidateRun[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [citation, setCitation] = useState(0);
  const controller = useRef<AbortController | null>(null);
  async function api<T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/knowledge/candidates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, operation, ...fields }), signal: controller.current?.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'knowledge_request_failed');
    return data as T;
  }
  async function work(action: () => Promise<void>) {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError('');
    try { await action(); } catch (cause) {
      if (active.signal.aborted) setNotice(t('已取消请求。可在生成记录中查看结果。', 'Request cancelled. Inspect generation history for its final state.'));
      else setError(cause instanceof Error && cause.message === 'knowledge_conflict'
        ? t('内容已被其他操作更新，请重新打开后再处理。', 'Content changed. Reopen it before editing.')
        : cause instanceof Error && cause.message === 'knowledge_capacity_exceeded'
          ? t('超出保存或输入上限，请缩小记录范围或删除不再需要的来源快照。', 'Capacity exceeded. Narrow the selection or delete unneeded snapshots.')
          : t('操作未完成。请检查路径、输入格式和执行器配置；生成详情可通过 CLI 查看。', 'Operation failed. Check paths, input format, and executor settings; use CLI for generation details.'));
    } finally { controller.current = null; setBusy(false); }
  }
  async function refresh() { setRows(await api<KnowledgeCandidateRow[]>('list')); }
  async function open(id: string, revision?: string) {
    const next = await api<KnowledgeCandidateDetail>('show', { id, ...(revision ? { revision } : {}) });
    setDetail(next); setCitation(0); setReason('');
  }
  useEffect(() => {
    if (initialWorkspace) void work(refresh);
    return () => controller.current?.abort();
    // Initial workspace comes from the explicit page URL; subsequent changes use Open.
  }, []);
  async function handleRun(run: KnowledgeCandidateRun) {
    setNotice(run.status === 'completed'
      ? t(`生成完成：${run.committed.length} 条候选，${run.rejections.length} 条输出未接纳。`, `Generated ${run.committed.length} candidates; ${run.rejections.length} outputs rejected.`)
      : t(`运行状态：${run.status}。请在生成记录中查看或恢复。`, `Run status: ${run.status}. Inspect or resume it in history.`));
    await refresh(); if (run.committed[0]) await open(run.committed[0].knowledgeId);
  }
  type EditableDraft = Pick<KnowledgeCandidateDetail['revision'], 'title' | 'content' | 'entities' | 'evidence'>;
  const editableDraft: EditableDraft | null = draft ? JSON.parse(draft) : null;
  function updateDraft(edit: (value: EditableDraft) => void) {
    const value: EditableDraft = JSON.parse(draft); edit(value); setDraft(JSON.stringify(value));
  }
  const selections = detail ? [
    ...detail.grounding.citations.map((item) => ({ selection: item.selection, label: t('陈述依据', 'Statement evidence') })),
    ...detail.grounding.mentions.map((item) => ({ selection: item.selection, label: t('实体提及', 'Entity mention') })),
  ] : [];
  const selectedCitation = selections[citation];
  type Time = KnowledgeCandidateDetail['revision']['content']['statements'][number]['context']['occurredDuring'];
  function formatTime(time: Time): string {
    if (time.timeKind === 'unknown') return `${t('未知', 'Unknown')}：${time.reason}`;
    if (time.timeKind === 'not_applicable') return `${t('不适用', 'Not applicable')}：${time.reason}`;
    if (time.timeKind === 'instant') return time.at;
    const bound = (value: typeof time.start) => value.boundKind === 'known' ? value.at
      : value.boundKind === 'unbounded' ? t('无界限', 'Unbounded') : `${t('未知', 'Unknown')}：${value.reason}`;
    return `${bound(time.start)} → ${bound(time.end)}`;
  }
  const organization = detail?.revision.content.organization;
  const evidenceSource = detail?.sources.find((entry) => entry.status === 'available'
    && entry.window.excerpts.some((excerpt) => excerpt.evidenceRef === selectedCitation?.selection.evidenceRef));
  const excerpt = evidenceSource?.status === 'available'
    ? evidenceSource.window.excerpts.find((entry) => entry.evidenceRef === selectedCitation?.selection.evidenceRef) : undefined;
  return <section className="knowledge-candidates">
    <header className="candidate-heading"><div><a href={`/knowledge${zh ? '' : '?lang=en'}`}>{t('知识载体', 'Knowledge artifacts')}</a><h1>{t('从工作中留下知识', 'Keep knowledge from your work')}</h1></div>
      <Space><Button disabled={busy || !workspace.trim()} onClick={() => void work(async () => { setRuns(await api('runs')); setShowRuns(true); })}>{t('生成记录', 'Generation history')}</Button><Button type="primary" disabled={busy || !workspace.trim()} onClick={() => setShowImport(true)}>{t('选择日志', 'Select a log')}</Button></Space></header>
    <div className="candidate-workspace"><Input aria-label={t('知识工作区', 'Knowledge workspace')} placeholder={t('本地知识工作区路径，与 CLI 共用', 'Local workspace path, shared with CLI')} value={workspace} disabled={busy} onChange={(event) => { setWorkspace(event.target.value); setSnapshot(null); setRows([]); setDetail(null); }}/>
      <Button loading={busy} disabled={!workspace.trim()} onClick={() => void work(async () => { await refresh(); const url = new URL(window.location.href); url.searchParams.set('workspace', workspace); window.history.replaceState(null, '', url); })}>{t('打开', 'Open')}</Button>
      {busy && <Button onClick={() => controller.current?.abort()}>{t('取消', 'Cancel')}</Button>}</div>
    {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')}/>}
    {notice && <Alert type="info" title={notice} closable onClose={() => setNotice('')}/>}
    <div className="candidate-columns">
      <aside className="candidate-list" aria-label={t('候选知识', 'Candidate knowledge')}>
        {rows.length ? rows.map((row) => <button key={row.knowledgeId} disabled={busy} className={detail?.revision.knowledgeId === row.knowledgeId ? 'selected' : ''} onClick={() => void work(() => open(row.knowledgeId))}>
          <strong title={row.title}>{row.title}</strong><span>{row.choice === 'retain' ? t('已保留', 'Retained') : row.choice === 'discard' ? t('已舍弃', 'Discarded') : t('待处理', 'Unreviewed')} · {t('待复核', 'Pending review')}</span></button>) : <Empty description={t('打开工作区或选择一份日志开始。', 'Open a workspace or select a log to begin.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/>}
      </aside>
      <article className="candidate-content">
        {!detail ? <Empty description={t('选择候选，与原始记录逐条核对。', 'Select a candidate to compare with the original records.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/> : <>
          <div className="candidate-scroll"><h2>{detail.revision.title}</h2><Tag>{t('待复核', 'Pending review')}</Tag><Typography.Paragraph type="secondary">{t('保留表示愿意维护，不等于内容已得到证实。', 'Retaining means choosing to maintain this content, not verifying its truth.')}</Typography.Paragraph>
            <Select aria-label={t('历史修订', 'Revision history')} value={detail.revision.revisionId} disabled={busy} style={{ width: '100%' }} options={detail.history.revisions.map((revision, i) => ({ value: revision.revisionId, label: `${i + 1} · ${revision.title}` }))} onChange={(revision) => void work(() => open(detail.revision.knowledgeId, revision))}/>
            <h3>{organization?.knowledgeKind === 'case' ? t('案例', 'Case') : organization?.knowledgeKind === 'method' ? t('方法', 'Method') : t('事实', 'Fact')}</h3>
            {organization?.knowledgeKind === 'case' && <><p>{organization.situation}</p><p>{t('案例缺口', 'Case gaps')}：{organization.gaps.join('；') || t('未列出', 'None listed')}</p></>}
            {organization?.knowledgeKind === 'method' && <p>{t('目的', 'Purpose')}：{organization.purpose}</p>}
            {detail.revision.content.statements.map((statement) => <section key={statement.statementId} className="candidate-statement">
              <h3>{detail.revision.entities.find((entity) => entity.entityId === statement.subject.entityId)?.label} {statement.relation} {statement.object ? detail.revision.entities.find((entity) => entity.entityId === statement.object!.entityId)?.label : ''}</h3>
              <Space wrap><Tag>{statement.polarity === 'negative' ? t('否定陈述', 'Negative claim') : t('肯定陈述', 'Positive claim')}</Tag>
                <Tag>{({ descriptive: t('描述', 'Description'), normative: t('规范要求', 'Normative requirement'), capability: t('能力', 'Capability'), permission: t('许可', 'Permission') })[statement.modality]}</Tag>
                {organization?.knowledgeKind === 'case' && organization.actionStatementIds.includes(statement.statementId) && <Tag>{t('行动', 'Action')}</Tag>}
                {organization?.knowledgeKind === 'case' && organization.outcomeStatementIds.includes(statement.statementId) && <Tag>{t('结果', 'Outcome')}</Tag>}
                {organization?.knowledgeKind === 'method' && organization.instructionStatementIds.includes(statement.statementId) && <Tag>{t('方法步骤', 'Instruction')}</Tag>}
              </Space><p>{statement.context.scenario}</p>
              <dl><dt>{t('条件', 'Conditions')}</dt><dd>{statement.context.conditions.join('；') || t('未记录附加条件，不代表普遍适用', 'No additional conditions recorded; not universally applicable')}</dd>
                <dt>{t('例外', 'Exceptions')}</dt><dd>{statement.context.exceptions.join('；') || '—'}</dd>
                <dt>{t('未知信息', 'Unknowns')}</dt><dd>{statement.context.unknowns.join('；') || '—'}</dd>
                <dt>{t('发生／适用时间', 'Occurrence / validity')}</dt><dd>{formatTime(statement.context.occurredDuring)} / {formatTime(statement.context.validDuring)}</dd></dl>
              <Space wrap>{detail.revision.evidence.filter((link) => link.statementIds.includes(statement.statementId)).map((link) => <div key={link.evidenceLinkId}><Button size="small" onClick={() => setCitation(Math.max(0, detail.grounding.citations.findIndex((item) => item.evidenceLinkId === link.evidenceLinkId)))}>{t('查看依据', 'Inspect evidence')} · {({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[link.basis]}</Button><p>{({ supports: t('支持', 'Supports'), opposes: t('反对', 'Opposes'), background: t('背景', 'Background') })[link.relation]}：{link.interpretation}</p></div>)}</Space>
            </section>)}
            <h3>{t('未来如何复用', 'Potential future use')}</h3><p>{detail.grounding.reuseRationale}</p>
            {detail.grounding.identityUncertainties.map((item, index) => <Alert key={index} type="warning" title={item}/>)}
            <details><summary>{t('实体提及与指代依据', 'Entity mentions and identity rationale')}</summary>{detail.grounding.mentions.map((mention, index) => <div key={mention.mentionId}><p><strong>{detail.revision.entities.find((entity) => entity.entityId === mention.entityId)?.label}</strong> ← {mention.selection.quote}：{mention.rationale} ({mention.basis === 'explicit' ? t('明确提及', 'Explicit mention') : t('推断', 'Inference')})</p><Button size="small" onClick={() => setCitation(detail.grounding.citations.length + index)}>{t('核对原文提及', 'Inspect original mention')}</Button></div>)}</details>
          </div>
          <footer className="candidate-actions"><Input aria-label={t('处理理由', 'Decision reason')} placeholder={t('记录保留、舍弃或修订的理由', 'Reason for retaining, discarding, or editing')} value={reason} onChange={(event) => setReason(event.target.value)}/><Space wrap>
            <Button disabled={busy} onClick={() => { setDraft(JSON.stringify({ title: detail.revision.title, content: detail.revision.content, entities: detail.revision.entities, evidence: detail.revision.evidence }, null, 2)); setEditing(true); }}>{t('修订', 'Edit')}</Button>
            {(['retain', 'discard'] as const).map((choice) => <Button key={choice} type={choice === 'retain' ? 'primary' : 'default'} disabled={busy || !reason.trim()} onClick={() => void work(async () => { await api('maintain', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId, generation: detail.history.generation, choice, reason }); await refresh(); await open(detail.revision.knowledgeId, detail.revision.revisionId); })}>{choice === 'retain' ? t('保留', 'Retain') : t('舍弃', 'Discard')}</Button>)}</Space></footer>
        </>}
      </article>
      <aside className="candidate-evidence"><h2>{t('原始依据', 'Source evidence')}</h2>
        {detail && <Select style={{ width: '100%' }} aria-label={t('证据片段', 'Evidence excerpt')} value={citation} options={selections.map((item, index) => ({ value: index, label: `${item.label} · ${item.selection.quote.slice(0, 90)}` }))} onChange={setCitation}/>}
        <div className="candidate-scroll">{excerpt && selectedCitation ? <><p>{t('记录', 'Record')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind} · {excerpt.timestamp ?? t('时间未知', 'Time unknown')}</p>
          <pre>{excerpt.text.slice(0, selectedCitation.selection.start)}<mark>{excerpt.text.slice(selectedCitation.selection.start, selectedCitation.selection.end)}</mark>{excerpt.text.slice(selectedCitation.selection.end)}</pre>
          {evidenceSource?.status === 'available' && <><p>{evidenceSource.window.limitations.join(' ')}</p><details><summary>{t('原始记录及相邻上下文', 'Original record and adjacent context')}</summary>{evidenceSource.window.records.filter((record) => Math.abs(record.recordIndex - excerpt.recordIndex) <= 1).map((record) => <pre key={record.recordIndex}>{record.recordIndex}: {record.raw}</pre>)}</details></>}
        </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail ? t('此来源不可用，不能核对完整证据。', 'This source is unavailable; full evidence cannot be checked.') : t('选择一条陈述查看依据。', 'Select a statement to inspect evidence.')}/>}
          {detail?.sources.map((entry, index) => entry.status === 'unavailable' ? <Alert key={index} type="warning" title={`${t('来源不可用', 'Source unavailable')}: ${entry.reason}`}/> : <Button key={index} danger size="small" disabled={busy} onClick={() => Modal.confirm({ title: t('删除此来源快照？', 'Delete this source snapshot?'), content: t('共享此来源的候选将无法再查看原文，知识修订仍保留。', 'Candidates sharing this source will lose original text access. Knowledge revisions remain.'), onOk: () => work(async () => { await api('delete-source', { snapshot: entry.window.snapshotId }); await open(detail.revision.knowledgeId, detail.revision.revisionId); }) })}>{t('删除来源快照', 'Delete source snapshot')}</Button>)}
        </div>
      </aside>
    </div>
    <Drawer title={t('选择工作日志', 'Select a work log')} open={showImport} onClose={() => !busy && setShowImport(false)} width={560}>
      <div className="candidate-form"><label>{t('Codex 日志文件', 'Codex log file')}<Input value={source} disabled={busy} onChange={(event) => { setSource(event.target.value); setSnapshot(null); }}/></label>
        <Space><label>{t('起始记录（从零开始）', 'First record (zero-based)')}<InputNumber min={0} value={start} disabled={busy} onChange={(value) => { setStart(value); setSnapshot(null); }}/></label><label>{t('结束记录（包含）', 'Last record (inclusive)')}<InputNumber min={0} value={end} disabled={busy} onChange={(value) => { setEnd(value); setSnapshot(null); }}/></label></Space>
        <Button loading={busy} disabled={!source.trim()} onClick={() => void work(async () => { setSnapshot(await api('capture', { source, ...(start === null ? {} : { startRecord: start }), ...(end === null ? {} : { endRecord: end }) })); })}>{t('归档并预览范围', 'Capture and preview scope')}</Button>
        <label>{t('执行器', 'Executor')}<Select style={{ width: '100%' }} value={executor} disabled={busy} onChange={setExecutor} options={['codex', 'claude', 'claude-sdk', 'openai-api', 'anthropic-api'].map((value) => ({ value, label: value }))}/></label>
        <label>{t('模型（明确配置）', 'Model (explicit configuration)')}<Input value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}/></label>
        {snapshot && <><Alert type="info" title={t(`将发送 ${snapshot.excerpts.length} 个选定片段给 ${executor} / ${model || '—'}。`, `Send ${snapshot.excerpts.length} selected excerpts to ${executor} / ${model || '—'}.`)} description={`${snapshot.sourcePath} · ${snapshot.startRecord}–${snapshot.endRecord}`}/>
          {snapshot.limitations.map((item, index) => <Alert type="warning" key={index} title={item}/>)}
          <p>{t('仅处理选定输入；不会自动修改 AGENTS.md 或 skill。模型费用以执行器实际报告为准。', 'Only selected input is processed. No automatic AGENTS.md or skill edits. Cost depends on executor reporting.')}</p>
          <Button type="primary" loading={busy} disabled={!model.trim()} onClick={() => void work(async () => { const run = await api<KnowledgeCandidateRun>('generate', { snapshot: snapshot.snapshotId, executor, model, runId: crypto.randomUUID() }); setShowImport(false); await handleRun(run); })}>{t('生成候选', 'Generate candidates')}</Button></>}
      </div>
    </Drawer>
    <Drawer title={t('修订知识内容', 'Edit knowledge content')} open={editing} onClose={() => setEditing(false)} width={680} extra={<Button type="primary" disabled={busy || !reason.trim()} onClick={() => void work(async () => { if (!detail) return; await api('revise', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId, generation: detail.history.generation, draft: JSON.parse(draft), reason }); setEditing(false); await refresh(); await open(detail.revision.knowledgeId); })}>{t('保存新修订', 'Save new revision')}</Button>}>
      <p>{t('修改标题、陈述与上下文。来源及实体身份保持绑定；新修订重新等待复核。', 'Edit the title, statements, and context. Sources and entity identities remain bound; the new revision awaits review.')}</p>
      <Input aria-label={t('修订理由', 'Revision reason')} value={reason} placeholder={t('修订理由', 'Revision reason')} onChange={(event) => setReason(event.target.value)}/>
      {editableDraft && <div className="candidate-form">
        <label>{t('标题', 'Title')}<Input value={editableDraft.title} onChange={(event) => updateDraft((value) => { value.title = event.target.value; })}/></label>
        {editableDraft.entities.map((entity, index) => <label key={entity.entityId}>{t('实体名称', 'Entity name')}<Input value={entity.label} onChange={(event) => updateDraft((value) => { value.entities[index].label = event.target.value; })}/></label>)}
        {editableDraft.evidence.map((link, index) => <label key={link.evidenceLinkId}>{t('证据解释', 'Evidence interpretation')}<Input.TextArea value={link.interpretation} rows={2} onChange={(event) => updateDraft((value) => { value.evidence[index].interpretation = event.target.value; })}/></label>)}
        {editableDraft.content.statements.map((statement, index) => <section key={statement.statementId} className="candidate-form candidate-statement">
          <label>{t('陈述', 'Statement')}<Input.TextArea value={statement.relation} rows={3} onChange={(event) => updateDraft((value) => { value.content.statements[index].relation = event.target.value; })}/></label>
          <label>{t('肯定／否定', 'Polarity')}<Select value={statement.polarity} options={[{ value: 'positive', label: t('肯定', 'Positive') }, { value: 'negative', label: t('否定', 'Negative') }]} onChange={(polarity) => updateDraft((value) => { value.content.statements[index].polarity = polarity; })}/></label>
          <label>{t('陈述含义', 'Modality')}<Select value={statement.modality} options={[{ value: 'descriptive', label: t('描述', 'Description') }, { value: 'normative', label: t('规范要求', 'Normative requirement') }, { value: 'capability', label: t('能力', 'Capability') }, { value: 'permission', label: t('许可', 'Permission') }]} onChange={(modality) => updateDraft((value) => { value.content.statements[index].modality = modality; })}/></label>
          <label>{t('适用场景', 'Scenario')}<Input.TextArea value={statement.context.scenario} rows={2} onChange={(event) => updateDraft((value) => { value.content.statements[index].context.scenario = event.target.value; })}/></label>
          {(['conditions', 'exceptions', 'unknowns'] as const).map((field) => <label key={field}>{field === 'conditions' ? t('条件（每行一项）', 'Conditions (one per line)') : field === 'exceptions' ? t('例外（每行一项）', 'Exceptions (one per line)') : t('未知信息（每行一项）', 'Unknowns (one per line)')}<Input.TextArea value={statement.context[field].join('\n')} rows={2} onChange={(event) => updateDraft((value) => { value.content.statements[index].context[field] = event.target.value.split('\n').filter((line) => line.trim()); })}/></label>)}
        </section>)}
      </div>}
    </Drawer>
    <Drawer title={t('生成记录', 'Generation history')} open={showRuns} onClose={() => setShowRuns(false)} width={620}>
      {runs.length ? runs.map((run) => <section className="candidate-statement" key={run.runId}><strong>{run.status}</strong><p>{run.runId}</p><p>{run.startedAt}</p><p>{run.committed.length} {t('条候选', 'candidates')} / {run.rejections.length} {t('条拒绝输出', 'rejected outputs')}</p><Button disabled={busy || !['prepared', 'generating'].includes(run.status)} onClick={() => void work(async () => { await handleRun(await api('resume', { id: run.runId })); setRuns(await api('runs')); })}>{t('恢复已生成候选', 'Resume generated candidates')}</Button></section>) : <Empty/>}
    </Drawer>
  </section>;
}

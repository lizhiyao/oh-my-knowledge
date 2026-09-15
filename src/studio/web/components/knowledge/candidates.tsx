'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { resolveKnowledgeWorkspace } from './workspace';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd';
import { langSuffix, type Language } from '../layout/shell';
import { conversationPath } from '../conversation-link';
import { displayTime } from '../../../application/display/format';
import { candidateDecisionLabel, extractionRunStatusLabel, type CandidateChoice } from '../../../application/knowledge/candidate-status';
import type { KnowledgeCandidateDetail, KnowledgeCandidateRow, KnowledgeCandidateRun, KnowledgeCandidateSource } from '../../../view-models/knowledge/knowledge-candidates';

export function KnowledgeCandidates({ lang, initialWorkspace = '', initialId }: { lang: Language; initialWorkspace?: string; initialId?: string }) {
  const zh = lang === 'zh';
  const t = (cn: string, en: string) => zh ? cn : en;
  const router = useRouter();
  /** 页头按钮与空状态引导去的是同一个地址，跳转动作只写一遍。 */
  const chooseConversation = () => router.push(`/observe${langSuffix(lang)}`);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [defaultWorkspace, setDefaultWorkspace] = useState('');
  const [workspaceDraft, setWorkspaceDraft] = useState(initialWorkspace);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(!!initialWorkspace);
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
    } finally { controller.current = null; setBusy(false); setLoading(false); }
  }
  async function refresh(root = workspace, selectFirst = false) {
    const [nextRows, nextRuns] = await Promise.all([
      api<KnowledgeCandidateRow[]>('list', { workspace: root }),
      api<KnowledgeCandidateRun[]>('runs', { workspace: root }),
    ]);
    const nextDetail = selectFirst && nextRows[0]
      ? await api<KnowledgeCandidateDetail>('show', { workspace: root, id: nextRows[0].knowledgeId }) : undefined;
    setRows(nextRows); setRuns(nextRuns);
    if (selectFirst) { setDetail(nextDetail ?? null); setCitation(0); setReason(''); }
  }
  async function open(id: string, revision?: string) {
    const next = await api<KnowledgeCandidateDetail>('show', { id, ...(revision ? { revision } : {}) });
    setDetail(next); setCitation(0); setReason('');
    const url = new URL(window.location.href); url.searchParams.set('id', id); window.history.replaceState(null, '', url);
  }
  useEffect(() => {
    void work(async () => {
      const { workspace: root, defaultWorkspace: fallback, executor: provider, model: defaultModel } = await resolveKnowledgeWorkspace(initialWorkspace, controller.current?.signal);
      setDefaultWorkspace(fallback); setWorkspace(root); setWorkspaceDraft(root);
      setExecutor(provider); setModel(defaultModel);
      if (root) { await refresh(root, true); if (initialId) { const next = await api<KnowledgeCandidateDetail>('show', { workspace: root, id: initialId }); setDetail(next); } }
    });
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
    <header className="candidate-heading"><div><Link href={`/knowledge${langSuffix(lang)}`}>{t('知识载体', 'Knowledge artifacts')}</Link><h1>{t('候选知识', 'Candidate knowledge')}</h1></div>
      <Space wrap><Button disabled={busy} onClick={() => { setWorkspaceDraft(workspace); setShowSettings(true); }}>{t('本次保存位置', 'Save location for this operation')}</Button>
        {workspace && <Button disabled={busy} onClick={() => void work(async () => { setRuns(await api('runs')); setShowRuns(true); })}>{t('提炼记录', 'Extraction history')}</Button>}
        {rows.length > 0 && <Button type="primary" disabled={busy} onClick={chooseConversation}>{t('从会话选择', 'Choose a conversation')}</Button>}
        {busy && <Button onClick={() => controller.current?.abort()}>{t('取消', 'Cancel')}</Button>}
        <Button disabled={busy || !workspace} onClick={() => { setSnapshot(null); setShowImport(true); }}>{t('导入日志文件', 'Import a log file')}</Button>
      </Space></header>
    {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')}/>}
    {detail?.origin && <Link href={`${conversationPath(detail.origin.threadId, detail.origin.turnId)}?${new URLSearchParams({ workspace, lang })}`}>{t('返回原始对话：', 'Back to conversation: ')}{detail.origin.title}</Link>}
    {notice && <Alert type="info" title={notice} closable onClose={() => setNotice('')}/>}
    {rows.length === 0 ? <KnowledgeCandidateStart lang={lang} hasWorkspace={!!workspace} loading={loading} busy={busy} latest={runs[0]} failedToLoad={!!error}
      onChoose={chooseConversation} onHistory={() => setShowRuns(true)}/>
      : <div className="candidate-columns">
      <aside className="candidate-list" aria-label={t('候选知识', 'Candidate knowledge')}>
        {rows.length ? rows.map((row) => <button key={row.knowledgeId} disabled={busy} className={detail?.revision.knowledgeId === row.knowledgeId ? 'selected' : ''} onClick={() => void work(() => open(row.knowledgeId))}>
          <strong title={row.title}>{row.title}</strong><CandidateRowStatus choice={row.choice} lang={lang}/></button>) : <Empty description={t('打开工作区或选择一份日志开始。', 'Open a workspace or select a log to begin.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/>}
      </aside>
      <article className="candidate-content">
        {!detail ? <Empty description={t('选择候选，与原始记录逐条核对。', 'Select a candidate to compare with the original records.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/> : <>
          <div className="candidate-scroll"><CandidateDecisionHeader title={detail.revision.title} maintenance={detail.maintenance} lang={lang}/>
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
            {(['retain', 'discard'] as const).map((choice) => <Button key={choice} type={choice === 'retain' ? 'primary' : 'default'} disabled={busy || !reason.trim()} onClick={() => void work(async () => { await api('maintain', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId, generation: detail.history.generation, choice, reason }); await refresh(); await open(detail.revision.knowledgeId, detail.revision.revisionId);
              setNotice(choice === 'retain'
                ? t('已记录保留决定与理由。', 'Recorded your decision to retain, with the reason.')
                : t('已记录舍弃决定与理由；该修订仍在历史中。', 'Recorded your decision to discard, with the reason; the revision stays in its history.')); })}>{choice === 'retain' ? t('保留', 'Retain') : t('舍弃', 'Discard')}</Button>)}</Space></footer>
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
    </div>}
    <Drawer title={t('本次保存位置', 'Save location for this operation')} open={showSettings} onClose={() => !busy && setShowSettings(false)} size={560}>
      <div className="candidate-form">{error && <Alert type="error" title={error}/>}<p>{t('这里仅调整本次操作的保存位置。长期默认目录请在右上角“设置”中修改；已有数据不会移动。', 'Change the folder for this operation only. Edit global Settings for the long-term default; existing data will not move.')}</p>
        <p className="candidate-help">{t('全局位置：', 'Global location: ')}{defaultWorkspace}</p><Button disabled={busy || !defaultWorkspace} onClick={() => setWorkspaceDraft(defaultWorkspace)}>{t('使用全局位置', 'Use global location')}</Button>
        <label>{t('本地保存目录', 'Local folder')}<Input value={workspaceDraft} disabled={busy} placeholder={t('输入保存目录的完整路径', 'Enter the full folder path')} onChange={(event) => setWorkspaceDraft(event.target.value)}/></label>
        <Button type="primary" loading={busy} disabled={!workspaceDraft.trim()} onClick={() => void work(async () => {
          const root = workspaceDraft.trim();
          await refresh(root, true); setWorkspace(root); setSnapshot(null); setNotice(''); setShowSettings(false);
          const url = new URL(window.location.href); url.searchParams.set('workspace', root); url.searchParams.delete('id'); window.history.replaceState(null, '', url);
        })}>{t('使用此保存位置', 'Use this location')}</Button>
      </div>
    </Drawer>
    <Drawer title={snapshot ? t('确认提炼内容与模型', 'Confirm content and model') : t('导入日志文件', 'Import a log file')} open={showImport} onClose={() => !busy && setShowImport(false)} size={560}>
      <div className="candidate-form">{error && <Alert type="error" title={error}/>}{!snapshot && <p>{t('选择包含项目事实、你的纠正，或问题处理经过的记录。先在本地预览，再决定是否交给模型提炼。', 'Choose a record containing project facts, your corrections, or a problem and its resolution. Preview it locally before sending it to a model.')}</p>}
        {!snapshot?.origin && <><label>{t('工作记录文件（Codex JSONL）', 'Work log file (Codex JSONL)')}<Input placeholder="/.../rollout-….jsonl" value={source} disabled={busy} onChange={(event) => { setSource(event.target.value); setSnapshot(null); }}/></label>
        <p className="candidate-help">{t('粘贴这台电脑上日志文件的完整路径。默认读取整份文件，可在下方缩小范围。', 'Paste the full path to a log file on this computer. Read the entire file or narrow the range below.')}</p>
        <details><summary>{t('只选部分记录（可选）', 'Select a record range (optional)')}</summary><Space wrap><label>{t('起始记录（从零开始）', 'First record (zero-based)')}<InputNumber min={0} value={start} disabled={busy} onChange={(value) => { setStart(value); setSnapshot(null); }}/></label><label>{t('结束记录（包含）', 'Last record (inclusive)')}<InputNumber min={0} value={end} disabled={busy} onChange={(value) => { setEnd(value); setSnapshot(null); }}/></label></Space></details>
        <Button loading={busy} disabled={!source.trim()} onClick={() => void work(async () => { setSnapshot(await api('capture', { source, ...(start === null ? {} : { startRecord: start }), ...(end === null ? {} : { endRecord: end }) })); })}>{t('读取并预览', 'Read and preview')}</Button></>}
        {snapshot && <><section>{snapshot.origin && <p>{t('来源会话：', 'Conversation: ')}{snapshot.origin.title}</p>}<h3 className="candidate-form-heading">{t('核对将要提炼的内容', 'Review the selected content')}</h3>
          <p className="candidate-help">{t('以下内容已在本地读取，尚未发送给模型。', 'This content was read locally and has not been sent to a model.')}</p>
          <pre className="candidate-source-preview">{snapshot.excerpts.map((entry) => `[${entry.role ?? entry.eventKind}] ${entry.text}`).join('\n\n')}</pre>
        </section><h3 className="candidate-form-heading">{t('选择用于提炼的模型', 'Choose a model for extraction')}</h3>
        <label>{t('调用方式', 'Provider')}<Select style={{ width: '100%' }} value={executor} disabled={busy} onChange={value => { setExecutor(value); setModel(''); }} options={['codex', 'openai-api', 'anthropic-api'].map((value) => ({ value, label: value }))}/></label>
        <label>{t('模型（明确配置）', 'Model (explicit configuration)')}<Input value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}/></label>
        <Alert type="info" title={t(`将发送 ${snapshot.excerpts.length} 个选定片段给 ${executor} / ${model || '—'}。`, `Send ${snapshot.excerpts.length} selected excerpts to ${executor} / ${model || '—'}.`)} description={`${snapshot.sourcePath} · ${snapshot.startRecord}–${snapshot.endRecord}`}/>
          {snapshot.limitations.map((item, index) => <Alert type="warning" key={index} title={item}/>)}
          <p>{t('仅处理选定输入；不会自动修改 AGENTS.md 或 skill。模型费用以执行器实际报告为准。', 'Only selected input is processed. No automatic AGENTS.md or skill edits. Cost depends on executor reporting.')}</p>
          <Button type="primary" loading={busy} disabled={!model.trim() || snapshot.excerpts.length === 0} onClick={() => void work(async () => { const run = await api<KnowledgeCandidateRun>('generate', { snapshot: snapshot.snapshotId, executor, model, runId: crypto.randomUUID() }); setShowImport(false); await handleRun(run); })}>{t('开始提炼', 'Start extraction')}</Button></>}
      </div>
    </Drawer>
    <Drawer title={t('修订知识内容', 'Edit knowledge content')} open={editing} onClose={() => setEditing(false)} size={680} extra={<Button type="primary" disabled={busy || !reason.trim()} onClick={() => void work(async () => { if (!detail) return; await api('revise', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId, generation: detail.history.generation, draft: JSON.parse(draft), reason }); setEditing(false); await refresh(); await open(detail.revision.knowledgeId);
      setNotice(t('已保存新修订，需要重新决定保留或舍弃。', 'Saved a new revision. Decide again whether to retain or discard it.')); })}>{t('保存新修订', 'Save new revision')}</Button>}>
      <p>{t('修改标题、陈述与上下文。来源及实体身份保持绑定；保存后是一条新修订，原先的保留或舍弃决定不会带过来。', 'Edit the title, statements, and context. Sources and entity identities remain bound; saving creates a new revision, and the previous retain or discard decision does not carry over.')}</p>
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
    <Drawer title={t('提炼记录', 'Extraction history')} open={showRuns} onClose={() => setShowRuns(false)} size={620}>
      {runs.length ? runs.map((run) => <section className="candidate-statement" key={run.runId}><strong>{extractionRunStatusLabel(run.status, lang)}</strong><p>{run.runId}</p><p>{run.startedAt}</p><p>{run.committed.length} {t('条候选', 'candidates')} / {run.rejections.length} {t('条拒绝输出', 'rejected outputs')}</p><Button disabled={busy || !['prepared', 'generating'].includes(run.status)} onClick={() => void work(async () => { await handleRun(await api('resume', { id: run.runId })); setRuns(await api('runs')); })}>{t('恢复已生成候选', 'Resume generated candidates')}</Button></section>) : <Empty/>}
    </Drawer>
  </section>;
}

/** 列表行只报用户做过的决定；恒定的复核维度在详情头说明一次，不逐行重复。 */
export function CandidateRowStatus({ choice, lang }: { choice: CandidateChoice; lang: Language }) {
  return <span>{candidateDecisionLabel(choice, lang)}</span>;
}

/** 决定必须留下理由，理由就要看得见：标签只报维护决定，已做决定时回显理由、决定人与时间。 */
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

export function KnowledgeCandidateStart({ lang, hasWorkspace, loading, busy, latest, failedToLoad, onChoose, onHistory }: {
  lang: Language; hasWorkspace: boolean; loading: boolean; busy: boolean;
  latest?: KnowledgeCandidateRun; failedToLoad?: boolean; onChoose(): void; onHistory(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const emptyResult = latest?.status === 'completed' && latest.committed.length === 0;
  return <div className="candidate-start">
    <div className="candidate-start-main">
      <h2>{t('选一段工作记录，找出值得复用的经验', 'Find reusable knowledge in a work log')}</h2>
      <p className="candidate-start-intro">{t('OMK 帮你整理其中的项目事实、解决方法和经验。你核对原文，决定哪些值得留下。', 'OMK proposes project facts, methods, and lessons. Compare them with the original text and choose what to keep.')}</p>
      <div className="candidate-start-action"><Button type="primary" size="large" disabled={busy} onClick={onChoose}>{hasWorkspace ? t('从会话选择', 'Choose a conversation') : t('设置保存位置并开始', 'Choose where to save and begin')}</Button>
        <span>{t('先预览内容，再确认发送给模型。', 'Preview the content before confirming a model request.')}</span>
      </div>
      <ol className="candidate-steps">
        <li><strong>{t('选择记录', 'Choose a record')}</strong><span>{t('打开观测会话，直接点击提炼知识。', 'Open an observed conversation and click Extract knowledge.')}</span></li>
        <li><strong>{t('预览并提炼', 'Preview and extract')}</strong><span>{t('确认内容和模型，生成待核对的知识。', 'Confirm the content and model to propose knowledge.')}</span></li>
        <li><strong>{t('核对并保留', 'Review and keep')}</strong><span>{t('对照原文，保留、修改或舍弃。', 'Check the original text, then keep, edit, or discard.')}</span></li>
      </ol>
      <p className="candidate-help">{t('保留后可随时重读；不会自动改写你的 AGENTS.md 或 skill。', 'Reopen saved knowledge any time. Your AGENTS.md and skills are not changed automatically.')}</p>
    </div>
    <aside className="candidate-start-side">
      <h3>{t('什么记录适合提炼？', 'What makes a useful record?')}</h3>
      <ul><li>{t('项目的明确事实与约束', 'Explicit project facts and constraints')}</li><li>{t('你对助手做出的具体纠正', 'A specific correction you gave the assistant')}</li><li>{t('问题处理经过，以及成功或失败的结果', 'How a problem was handled and what happened')}</li></ul>
      <div className="candidate-last-run" role="status">
        {loading ? <p>{t('正在读取提炼记录…', 'Loading extraction history…')}</p> : failedToLoad ? <p>{t('暂时无法读取已有记录。请检查保存位置。', 'Could not load existing records. Check the save location.')}</p> : latest ? <>
          <strong>{emptyResult ? t('上次提炼完成，返回 0 条候选', 'Last extraction completed with 0 candidates') : t(`上次提炼：${extractionRunStatusLabel(latest.status, lang)}`, `Last extraction: ${extractionRunStatusLabel(latest.status, lang)}`)}</strong>
          <p>{emptyResult ? (latest.rejections.length ? t('部分输出未通过引用或格式校验，详情见提炼记录。', 'Some output failed citation or format checks. See the extraction history.') : t('可以换一份包含具体事实、纠正或处理结果的记录再试。', 'Try a record with concrete facts, corrections, or outcomes.')) : t('查看提炼记录，了解结果或继续未完成的保存。', 'Inspect the extraction history for results or unfinished saves.')}</p>
          <Button type="link" disabled={busy} onClick={onHistory}>{t('查看提炼记录', 'View extraction history')}</Button>
        </> : <p>{t('还没有提炼记录，从左侧选择一份工作记录开始。', 'No extractions yet. Choose a work log to begin.')}</p>}
      </div>
    </aside>
  </div>;
}

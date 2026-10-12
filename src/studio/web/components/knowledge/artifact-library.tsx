'use client';
import Link from 'next/link';
import { CarrierMeasurementDialog, CarrierMeasurementHistory } from '../measure/carrier-measurement';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Select, Skeleton, Space, Table, Tabs, Tag } from 'antd';
import type { Language } from '../layout/shell';
import { CarrierKnowledgeReviewPanel, CarrierReviewStatus } from './carrier-knowledge-review';
import type { ReviewedCarrierDetail, ReviewedCarrierRow } from '../../../view-models/knowledge/artifact-authoring';
import { ArtifactAuthoringDialog, requestArtifact } from './artifact-authoring';
import { resolveKnowledgeWorkspace } from './workspace';
import { KNOWLEDGE_CANDIDATES_PATH, KNOWLEDGE_LIBRARY_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';
import { displayTime } from '../../../application/display/format';
import { CarrierDocument } from './carrier-document';

export function ArtifactLibrary({ lang, reports, initialTab = 'library' }: { lang: Language; reports: ReactNode; initialTab?: 'library' | 'reports' }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [workspace, setWorkspace] = useState(''); const [rows, setRows] = useState<ReviewedCarrierRow[]>([]);
  const [detail, setDetail] = useState<ReviewedCarrierDetail | null>(null); const [target, setTarget] = useState<string>();
  const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  const [editing, setEditing] = useState(false); const [measuring, setMeasuring] = useState(false);
  const [detailTab, setDetailTab] = useState('content'); const [directory, setDirectory] = useState(false);
  const [measurementRefresh, setMeasurementRefresh] = useState(0); const [tab, setTab] = useState<string>(initialTab);
  const request = useRef<AbortController | null>(null);
  async function show(id: string, version?: number) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setTarget(id); setDetail(null); setBusy(true); setError(''); setDetailTab('content'); setDirectory(false);
    try { const result = await requestArtifact<ReviewedCarrierDetail>(workspace, 'show', { id, ...(version ? { version } : {}) }, controller.signal); if (!controller.signal.aborted) setDetail(result); }
    catch { if (!controller.signal.aborted) setError(t('未能读取载体，请重新读取。', 'Could not read the artifact. Reload.')); }
    finally { if (!controller.signal.aborted) { setBusy(false); request.current = null; } }
  }
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    void (async () => {
      try {
        const url = new URL(window.location.href);
        const { workspace: root } = await resolveKnowledgeWorkspace(url.searchParams.get('workspace') ?? '', controller.signal);
        if (!root) throw new Error();
        const list = await requestArtifact<ReviewedCarrierRow[]>(root, 'list', {}, controller.signal);
        const id = url.searchParams.get('artifact'); const version = Number(url.searchParams.get('version'));
        const selected = id ? await requestArtifact<ReviewedCarrierDetail>(root, 'show', { id, ...(Number.isSafeInteger(version) && version > 0 ? { version } : {}) }, controller.signal) : null;
        if (controller.signal.aborted) return;
        setWorkspace(root); setRows(list); setTarget(id ?? undefined); setDetail(selected);
      } catch { if (!controller.signal.aborted) setError(t('未能读取载体目录。请核对知识目录后重新读取。', 'Could not load artifacts. Check the knowledge directory, then reload.')); }
      finally { if (!controller.signal.aborted) { setBusy(false); request.current = null; } }
    })();
    return () => { controller.abort(); request.current?.abort(); };
  }, []);
  async function refresh() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try {
      const list = await requestArtifact<ReviewedCarrierRow[]>(workspace, 'list', {}, controller.signal);
      const latest = target ? await requestArtifact<ReviewedCarrierDetail>(workspace, 'show', { id: target, ...(detail ? { version: detail.version } : {}) }, controller.signal) : null;
      if (controller.signal.aborted) return;
      setRows(list); setDetail(latest);
    } catch { if (!controller.signal.aborted) setError(t('未能重新核对知识变化，不能视为没有变化。请重新读取。', 'Could not recheck knowledge changes. This is not evidence of no changes. Reload.')); }
    finally { if (!controller.signal.aborted) { setBusy(false); request.current = null; } }
  }
  const current = detail ? rows.find(row => row.artifactId === detail.artifactId) : undefined;
  const historical = detail && detail.version !== detail.versions[0].version;
  const select = (id: string) => { const url = new URL(window.location.href); url.searchParams.set('artifact', id); url.searchParams.delete('version'); url.searchParams.set('workspace', workspace); window.history.replaceState(null, '', url); void show(id); };
  const list = <div className="carrier-library-panel">
    <Space className="carrier-library-actions" wrap><Button type="primary" disabled={busy || !workspace || !!error} onClick={() => setEditing(true)}>{t('从已保留知识生成', 'Generate from retained knowledge')}</Button>
      <Button disabled={busy || !workspace} onClick={() => void refresh()}>{t('重新核对知识变化', 'Recheck knowledge changes')}</Button>
      <Link href={workspaceHref(KNOWLEDGE_CANDIDATES_PATH, workspace)}>{t('候选核对', 'Candidate review')}</Link></Space>
    <Table<ReviewedCarrierRow> className="studio-table carrier-table" rowKey="artifactId" loading={busy} dataSource={rows} size="small" scroll={{ x: 880 }} tableLayout="fixed" pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('保留知识后，可在这里生成并保存载体。', 'Retain knowledge, then generate and save an artifact here.')}/> }} columns={[
      { title: t('载体名称', 'Artifact name'), dataIndex: 'name', ellipsis: true, render: (name: string, row) => <Button type="link" title={name} onClick={() => select(row.artifactId)}>{name}</Button> },
      { title: t('形式', 'Form'), dataIndex: 'artifactKind', width: 100 },
      { title: t('版本', 'Version'), width: 80, render: (_, row) => `v${row.version}` },
      { title: t('知识复核', 'Knowledge review'), width: 180, render: (_, row) => <CarrierReviewStatus review={row.knowledgeReview} lang={lang}/> },
      { title: t('内容状态', 'Content status'), width: 160, render: (_, row) => row.drifted ? <Tag color="warning">{t('文件已修改', 'Files changed')}</Tag> : <Tag color="success">{t('已保存', 'Saved')}</Tag> },
    ]}/>
  </div>;
  const detailTabs = detail ? [{ key: 'content', label: t('正文', 'Content') }, { key: 'sources', label: t(`知识引用（${detail.knowledgeRefs.length}）`, `Knowledge references (${detail.knowledgeRefs.length})`) },
    { key: 'review', label: t(`变化核对（${detail.knowledgeReview.needsReviewCount}）`, `Review changes (${detail.knowledgeReview.needsReviewCount})`) }, { key: 'original', label: t('原文', 'Original') }, { key: 'measurements', label: t('评测记录', 'Evaluations') }] : [];
  return <div className="carrier-library knowledge-core">
    {error && <Alert type="error" showIcon title={error} action={<Button disabled={busy} onClick={() => workspace ? void refresh() : window.location.reload()}>{t('重新读取', 'Reload')}</Button>}/>}
    {target ? <>
      <div className="knowledge-context"><Button onClick={() => { request.current?.abort(); request.current = null; setBusy(false); setDetail(null); setTarget(undefined); const url = new URL(window.location.href); url.searchParams.delete('artifact'); url.searchParams.delete('version'); window.history.replaceState(null, '', url); }}>{t('返回载体列表', 'Back to artifacts')}</Button>
        {detail && <label>{t('版本', 'Version')} <Select aria-label={t('载体版本', 'Artifact version')} disabled={busy} value={detail.version} options={detail.versions.map(version => ({ value: version.version, label: `v${version.version} · ${displayTime(version.savedAt)}` }))} onChange={version => { const url = new URL(window.location.href); url.searchParams.set('version', String(version)); window.history.replaceState(null, '', url); void show(detail.artifactId, version); }}/></label>}
        <Button disabled={busy || !workspace} onClick={() => void refresh()}>{t('重新核对知识变化', 'Recheck knowledge changes')}</Button>
        <Button className="knowledge-directory-toggle" aria-expanded={directory} onClick={() => setDirectory(value => !value)}>{directory ? t('返回正文', 'Back to content') : t('载体目录', 'Artifact directory')}</Button></div>
      <div className={`knowledge-workbench${directory ? ' knowledge-directory-open' : ''}`}>
        <aside className="knowledge-directory"><div className="knowledge-directory-scroll">{rows.map(row => <button type="button" className={`knowledge-directory-row${target === row.artifactId ? ' selected' : ''}`} key={row.artifactId} disabled={busy} onClick={event => { if (directory) event.currentTarget.closest('.knowledge-core')?.querySelector<HTMLButtonElement>('.knowledge-directory-toggle')?.focus(); select(row.artifactId); }}><strong>{row.name}</strong><span>{row.artifactKind} · v{row.version}</span></button>)}</div>
          <footer className="knowledge-directory-footer">{t('历史内容与精确引用完整保留。', 'Historical content and exact references are preserved.')}<Link href={workspaceHref(KNOWLEDGE_LIBRARY_PATH, workspace)}>{t('返回知识库', 'Knowledge library')}</Link></footer></aside>
        {detail ? <article className="knowledge-reader">
          <header className="knowledge-reader-heading"><h2>{detail.name}</h2><p className="knowledge-reader-meta">v{detail.version} · {historical ? t('历史版本', 'Historical version') : t('当前版本', 'Current version')} · {detail.artifactKind}</p>
            {detail.knowledgeReview.needsReviewCount > 0 && <div className="knowledge-reader-warning"><span>{t(`${detail.knowledgeReview.needsReviewCount} 条引用知识需复核，载体尚未更新。`, `${detail.knowledgeReview.needsReviewCount} references need review; the artifact has not been updated.`)}</span><Button type="link" onClick={() => setDetailTab('review')}>{t('核对变化', 'Review changes')}</Button></div>}
            {detail.drifted && <Alert type="warning" title={t('文件被外部修改，内容哈希不一致；不能基于此版本更新。', 'Files changed outside OMK; the content hash differs. This version cannot be updated.')}/>}
            <nav className="knowledge-reader-tabs" aria-label={t('载体阅读视图', 'Artifact reading view')}>{detailTabs.map(item => <button type="button" key={item.key} aria-pressed={detailTab === item.key} onClick={() => setDetailTab(item.key)}>{item.label}</button>)}</nav></header>
          <div className="knowledge-reader-scroll" key={`${detail.artifactId}/${detail.version}/${detailTab}`}><div className="knowledge-reading">
            {detailTab === 'content' && <CarrierDocument content={detail.content} lang={lang}/>}
            {detailTab === 'original' && <><p className="carrier-path">{t('已保存位置', 'Saved location')}：<code>{detail.artifactPath}</code></p><pre className="knowledge-source">{detail.content}</pre></>}
            {detailTab === 'review' && <CarrierKnowledgeReviewPanel review={detail.knowledgeReview} workspace={workspace} lang={lang}/>}
            {detailTab === 'measurements' && <CarrierMeasurementHistory key={measurementRefresh} workspace={workspace} detail={detail} lang={lang}/>}
            {detailTab === 'sources' && <><p>{t('本版本只引用以下精确知识修订；当前维护状态和内容另见变化核对。', 'This version references these exact knowledge revisions. Review changes for current content and maintenance decisions.')}</p>
              {detail.knowledgeRefs.map(ref => <section className="knowledge-statement" key={`${ref.knowledgeId}/${ref.revisionId}`}><Link href={workspaceHref(`${KNOWLEDGE_CANDIDATES_PATH}?id=${ref.knowledgeId}&revision=${ref.revisionId}`, workspace)}>{detail.knowledgeReview.checks.find(check => check.knowledgeId === ref.knowledgeId && check.incorporatedRevisionId === ref.revisionId)?.title ?? t('回看精确知识修订', 'Inspect exact knowledge revision')}</Link>
                <details><summary>{t('精确知识身份', 'Exact knowledge identity')}</summary><code>{ref.knowledgeId} / {ref.revisionId}</code></details></section>)}</>}
          </div></div>
          <footer className="knowledge-reader-footer"><span>{t('已保存；引用检查不代表效果已验证。', 'Saved; reference checks do not verify effectiveness.')}</span><Space wrap>
            <Button disabled={busy || !!error || detail.drifted} onClick={() => setMeasuring(true)}>{t('验证这个版本', 'Evaluate this version')}</Button>
            <Button type="primary" disabled={busy || !!error || detail.drifted || !!historical} onClick={() => setEditing(true)}>{t('生成新版本', 'Create new version')}</Button></Space></footer>
        </article> : <div className="knowledge-reader knowledge-reader-empty">{busy ? <Skeleton active/> : <Empty description={t('载体不可读，请重新读取。', 'Artifact unavailable. Reload.')}/>}</div>}
      </div>
    </> : <Tabs className="studio-detail-tabs carrier-library-tabs" activeKey={tab} onChange={value => { setTab(value); const url = new URL(window.location.href); if (value === 'reports') url.searchParams.set('view', 'reports'); else url.searchParams.delete('view'); window.history.replaceState(null, '', url); }} items={[{ key: 'library', label: t('已保存载体', 'Saved artifacts'), children: list }, { key: 'reports', label: t('体检与观测', 'Doctor and observe'), children: reports }]}/>}
    {measuring && detail && <CarrierMeasurementDialog workspace={workspace} detail={detail} lang={lang} onClose={() => setMeasuring(false)} onStarted={() => { setMeasurementRefresh(value => value + 1); setDetailTab('measurements'); }}/>}
    {editing && <ArtifactAuthoringDialog workspace={workspace} lang={lang} existing={detail ? current : undefined} onClose={() => setEditing(false)} onSaved={saved => { setTarget(saved.artifactId); setDetail(saved); setDetailTab('content'); setRows(previous => [{ ...saved }, ...previous.filter(row => row.artifactId !== saved.artifactId)]); const url = new URL(window.location.href); url.searchParams.set('artifact', saved.artifactId); url.searchParams.delete('version'); url.searchParams.set('workspace', workspace); window.history.replaceState(null, '', url); }}/ >}
  </div>;
}

'use client';
import Link from 'next/link';
import { CarrierMeasurementDialog, CarrierMeasurementHistory } from '../measure/carrier-measurement';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Select, Space, Table, Tabs, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { CarrierDetail, CarrierRow } from '../../../view-models/knowledge/artifact-authoring';
import { ArtifactAuthoringDialog, requestArtifact } from './artifact-authoring';
import { resolveKnowledgeWorkspace } from './workspace';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';

export function ArtifactLibrary({ lang, reports, initialTab = 'library' }: { lang: Language; reports: ReactNode; initialTab?: 'library' | 'reports' }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [workspace, setWorkspace] = useState('');
  const [rows, setRows] = useState<CarrierRow[]>([]);
  const [detail, setDetail] = useState<CarrierDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [detailTab, setDetailTab] = useState('content');
  const [measurementRefresh, setMeasurementRefresh] = useState(0);
  const [tab, setTab] = useState<string>(initialTab);
  async function show(id: string, version?: number) {
    setBusy(true); setError('');
    try { setDetail(await requestArtifact<CarrierDetail>(workspace, 'show', { id, ...(version ? { version } : {}) })); }
    catch { setError(t('未能读取载体，请重新打开。', 'Could not read the artifact. Reopen it.')); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const url = new URL(window.location.href);
        const { workspace: root } = await resolveKnowledgeWorkspace(url.searchParams.get('workspace') ?? '', controller.signal);
        if (!root) throw new Error();
        setWorkspace(root);
        const list = await requestArtifact<CarrierRow[]>(root, 'list', {}, controller.signal);
        setRows(list);
        const id = url.searchParams.get('artifact');
        const version = Number(url.searchParams.get('version'));
        setDetail(id ? await requestArtifact<CarrierDetail>(root, 'show', { id, ...(Number.isSafeInteger(version) && version > 0 ? { version } : {}) }, controller.signal) : null);
      } catch { if (!controller.signal.aborted) setError(t('未能读取载体目录。请在设置中选择知识目录后重试。', 'Could not load artifacts. Select a knowledge directory in settings and retry.')); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void load();
    return () => controller.abort();
  }, []);
  const current = detail ? rows.find(row => row.artifactId === detail.artifactId) : undefined;
  const select = (id: string) => { setDetailTab('content'); const url = new URL(window.location.href); url.searchParams.set('artifact', id); url.searchParams.delete('version'); url.searchParams.set('workspace', workspace); window.history.replaceState(null, '', url); void show(id); };
  return <div className="carrier-library">
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => window.location.reload()}>{t('重新读取', 'Reload')}</Button>}/>}
    <Tabs className="studio-detail-tabs carrier-library-tabs" activeKey={tab} onChange={value => { setTab(value); const url = new URL(window.location.href); if (value === 'reports') url.searchParams.set('view', 'reports'); else url.searchParams.delete('view'); window.history.replaceState(null, '', url); }} items={[
      { key: 'library', label: t('已保存载体', 'Saved artifacts'), children: <div className="carrier-library-panel">
        <Space className="carrier-library-actions" wrap>{detail && <Button disabled={busy} onClick={() => { setDetail(null); const url = new URL(window.location.href); url.searchParams.delete('artifact'); url.searchParams.delete('version'); window.history.replaceState(null, '', url); }}>{t('返回载体列表', 'Back to artifacts')}</Button>}
          <Button type="primary" disabled={busy || !workspace || !!error || !!detail && (detail.drifted || detail.version !== detail.versions[0].version)} onClick={() => setEditing(true)}>{detail ? t('生成新版本', 'Create new version') : t('从已保留知识生成', 'Generate from retained knowledge')}</Button>
          {detail && <Button disabled={busy || !!error || detail.drifted} onClick={() => setMeasuring(true)}>{t('验证这个版本', 'Evaluate this version')}</Button>}
          <Link href={workspaceHref(KNOWLEDGE_CANDIDATES_PATH, workspace)}>{t('核对提炼的知识', 'Review extracted knowledge')}</Link>
        </Space>
        {detail ? <><Space wrap><h2>{detail.name}</h2><Tag>{detail.artifactKind}</Tag><Select aria-label={t('载体版本', 'Artifact version')} disabled={busy} value={detail.version} options={detail.versions.map(version => ({ value: version.version, label: `v${version.version} · ${version.savedAt}` }))} onChange={version => { const url = new URL(window.location.href); url.searchParams.set('version', String(version)); window.history.replaceState(null, '', url); void show(detail.artifactId, version); }}/></Space>
          {detail.drifted && <Alert type="warning" title={t('该版本文件已被外部修改，内容哈希不一致。请核对文件；不能基于此版本生成更新。', 'Files were modified outside OMK; the content hash differs. Review the files before updating.')}/>}
          <p className="carrier-path">{detail.artifactKind === 'skill' ? t('已保存 skill 目录', 'Saved skill directory') : t('已保存 prompt 文件', 'Saved prompt file')}：<code>{detail.artifactPath}</code></p>
          <p>{t('保存完成；使用前核对适用条件，并通过受控评测检查效果。', 'Saved. Check applicability and run a controlled evaluation before use.')}</p>
          <Tabs className="carrier-detail-tabs" activeKey={detailTab} onChange={setDetailTab} items={[
            { key: 'content', label: t('载体内容', 'Artifact content'), children: <pre className="carrier-original">{detail.content}</pre> },
            { key: 'measurements', label: t('评测记录', 'Evaluations'), children: <CarrierMeasurementHistory key={measurementRefresh} workspace={workspace} detail={detail} lang={lang}/> },
            { key: 'sources', label: t(`知识来源（${detail.knowledgeRefs.length}）`, `Knowledge sources (${detail.knowledgeRefs.length})`), children: <ul className="carrier-sources">{detail.knowledgeRefs.map(ref => <li key={`${ref.knowledgeId}/${ref.revisionId}`}><Link href={workspaceHref(`${KNOWLEDGE_CANDIDATES_PATH}?id=${ref.knowledgeId}&revision=${ref.revisionId}`, workspace)}>{t('回看候选与历史修订', 'Review candidate and revision history')}</Link><p><code>{ref.knowledgeId} / {ref.revisionId}</code></p></li>)}</ul> },
          ]}/>
        </> : <Table<CarrierRow> className="studio-table carrier-table" rowKey="artifactId" loading={busy} dataSource={rows} size="small" scroll={{ x: 700 }} tableLayout="fixed" pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('保留知识后，可在这里生成并保存载体。', 'Retain knowledge, then generate and save an artifact here.')}/> }} columns={[
          { title: t('载体名称', 'Artifact name'), dataIndex: 'name', ellipsis: true, render: (name: string, row) => <Button type="link" title={name} onClick={() => select(row.artifactId)}>{name}</Button> },
          { title: t('形式', 'Form'), dataIndex: 'artifactKind', width: 100 },
          { title: t('版本', 'Version'), width: 80, render: (_, row) => `v${row.version}` },
          { title: t('内容状态', 'Content status'), width: 160, render: (_, row) => row.drifted ? <Tag color="warning">{t('文件已修改', 'Files changed')}</Tag> : <Tag color="success">{t('已保存', 'Saved')}</Tag> },
        ]}/>}
      </div> },
      { key: 'reports', label: t('体检与观测', 'Doctor and observe'), children: reports },
    ]}/>
    {measuring && detail && <CarrierMeasurementDialog workspace={workspace} detail={detail} lang={lang} onClose={() => setMeasuring(false)} onStarted={() => { setMeasurementRefresh(value => value + 1); setDetailTab('measurements'); }}/>}
    {editing && <ArtifactAuthoringDialog workspace={workspace} lang={lang} existing={current} onClose={() => setEditing(false)} onSaved={saved => { setDetail(saved); setRows(previous => [{ ...saved }, ...previous.filter(row => row.artifactId !== saved.artifactId)]); }}/>}
  </div>;
}

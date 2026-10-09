'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeStorageMigrationPreview } from '../../../view-models/knowledge/knowledge-candidates';

export function KnowledgeStorageMigrationDialog({ workspace, lang, onClose, onDone }: {
  workspace: string; lang: Language; onClose(): void; onDone(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [preview, setPreview] = useState<KnowledgeStorageMigrationPreview>();
  const [backup, setBackup] = useState(''); const [stopped, setStopped] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(true);
  const controller = useRef<AbortController | null>(null);
  async function execute(operation: 'migration-preview' | 'migrate') {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError('');
    try {
      const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal: active.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, operation,
        ...(operation === 'migrate' ? { backupDirectory: backup.trim(), ...(preview?.status === 'preview' ? { previewDigest: preview.previewDigest } : {}) } : {}) }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error);
      if (!active.signal.aborted) { setPreview(value); if (operation === 'migrate') onDone(); }
    } catch (cause) {
      if (!active.signal.aborted) setError(cause instanceof Error && cause.message === 'knowledge_conflict'
        ? t('预检后数据有变化。重新预检；中断续迁须使用原备份，并保持原文件未被其它写入修改。', 'Data changed after preview. Preview again. Resume with the original backup and without concurrent source changes.')
        : cause instanceof Error && cause.message === 'knowledge_workspace_busy'
          ? t('存在活跃或无法确认归属的写入锁。停止旧写入后重试；不会自动删除未知锁。', 'An active or unverifiable write lock exists. Stop legacy writers and retry. Unknown locks are not removed automatically.')
          : t('预检或迁移未完成。请检查输入文件是否完整、备份目录是否位于工作区外，以及续迁是否使用原备份。', 'Preview or migration failed. Check input integrity, an external backup directory, and the original backup when resuming.'));
    } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  useEffect(() => { void execute('migration-preview'); return () => { controller.current?.abort(); controller.current = null; }; }, []);
  return <Modal open centered className="entity-apply-modal" title={t('升级知识存储', 'Upgrade knowledge storage')} width={640} onCancel={() => { controller.current?.abort(); onClose(); }}
    footer={<Space><Button disabled={busy} onClick={() => void execute('migration-preview')}>{t('重新预检', 'Preview again')}</Button>
      {preview && !preview.requiresMigration ? <Button type="primary" disabled={busy} onClick={onDone}>{t('读取已升级工作区', 'Read upgraded workspace')}</Button>
        : <Button type="primary" loading={busy} disabled={busy || !preview || !backup.trim() || !stopped} onClick={() => void execute('migrate')}>
          {preview?.status === 'resume_required' ? t('继续原迁移', 'Resume original migration') : t('备份并迁移', 'Back up and migrate')}</Button>}</Space>}>
    <p>{t('知识工作区：', 'Knowledge workspace: ')}{workspace}</p>
    <p>{t('将知识历史和提炼运行升级到 v2，保留原身份、正文、历史和摘要。新增实体分析不会改写旧知识。', 'Upgrade knowledge history and extraction runs to v2, preserving identities, content, history, and digests. New entity analysis does not rewrite historical knowledge.')}</p>
    {error && <Alert type="error" showIcon title={error}/>} {busy && !preview && <Spin/>}
    {preview && <KnowledgeMigrationScope preview={preview} lang={lang}/>}
    {preview?.requiresMigration && <div className="candidate-form">
      <label>{t('工作区外的备份目录（绝对路径）', 'Backup directory outside the workspace (absolute path)')}<Input disabled={busy} value={backup} onChange={event => setBackup(event.target.value)} placeholder="/absolute/path/outside-workspace"/></label>
      <Checkbox disabled={busy} checked={stopped} onChange={event => setStopped(event.target.checked)}>{t('已停止旧版本 CLI／Studio 对此工作区的写入。', 'Legacy CLI/Studio writers for this workspace have been stopped.')}</Checkbox>
      <p className="candidate-help">{t('旧进程是否停止不能仅靠运行状态判断。迁移会检查可见写入锁和文件摘要；中断后沿用同一备份目录。', 'Run status cannot establish that old processes have stopped. Migration checks visible write locks and file digests. Reuse the same backup directory after interruption.')}</p>
    </div>}
  </Modal>;
}

export function KnowledgeMigrationScope({ preview, lang }: { preview: KnowledgeStorageMigrationPreview; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <Alert type={preview.requiresMigration ? 'info' : 'success'} title={preview.status === 'resume_required'
    ? t('上次迁移尚未完成，请提供上次指定的外部备份目录。', 'An earlier migration is unfinished. Provide its original external backup directory.')
    : preview.requiresMigration ? t(`只读预检：${preview.items} 份知识历史、${preview.runs} 份提炼运行待迁移。`, `Read-only preview: ${preview.items} knowledge histories and ${preview.runs} extraction runs need migration.`)
      : t('当前知识历史和提炼运行均为当前版本。', 'Knowledge histories and extraction runs use the current versions.')} description={preview.status === 'resume_required' ? undefined
        : preview.status === 'completed' ? t('原始字节已保存在指定的外部备份目录中。', 'Original bytes are preserved in the specified external backup directory.')
          : t(`另有 ${preview.alreadyCurrent} 份已是当前格式。预检尚未改动文件。`, `${preview.alreadyCurrent} files already use current formats. Preview has not modified files.`)}/>;
}

'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeLibraryOwners } from '../../../view-models/knowledge/knowledge-library';
import { KNOWLEDGE_LIBRARY_PATH } from '../../../http/page-paths';
import { libraryUrl, requestLibrary } from './library-request';

export function LibraryEntityEntry({ workspace, analysisId, entityId, entityRevisionId, current, lang }: {
  workspace: string; analysisId: string; entityId: string; entityRevisionId: string; current: boolean; lang: Language;
}) {
  const [owners, setOwners] = useState<KnowledgeLibraryOwners>(); const [error, setError] = useState(false);
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  useEffect(() => {
    const controller = new AbortController(); setError(false); setOwners(undefined);
    void requestLibrary<KnowledgeLibraryOwners>(workspace, 'owners', { analysisId, entityId }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setOwners(value); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [workspace, analysisId, entityId, entityRevisionId]);
  return <div className="entity-library-detail-actions">{error ? <Alert type="warning" title={t('知识库归属不可读，请打开知识库检查。', 'Library ownership unavailable. Open the library to inspect.')}/>
    : owners?.length ? owners.map(owner => <Link key={owner.objectId} href={libraryUrl(workspace, owner.objectId)}>{t('打开知识库对象：', 'Open library object: ')}{owner.label}</Link>)
      : owners && current ? <Link href={`${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({ workspace, analysis: analysisId, entity: entityId, entityRevision: entityRevisionId })}`}>{t('将此实体加入知识库', 'Add this entity to the knowledge library')}</Link> : null}</div>;
}

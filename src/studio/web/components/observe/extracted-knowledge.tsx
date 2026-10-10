'use client';
import { useState } from 'react';
import { ExtractConversation } from '../knowledge/conversation-extraction';
import { AutoExtractConversation } from '../knowledge/auto-extraction';
import { KnowledgeInbox } from '../knowledge/inbox';
import type { Language } from '../layout/shell';

export function ExtractedKnowledge({ threadId, turnId, lang, disabled = false }: { threadId: string; turnId?: string; lang: Language; disabled?: boolean }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [review, setReview] = useState<{ workspace: string; id: string }>();
  return <div className="conversation-knowledge-actions">
    {!turnId && <AutoExtractConversation threadId={threadId} lang={lang} onChanged={() => setRefreshKey(value => value + 1)}/>}
    {(!turnId || review) && <KnowledgeInbox disabled={disabled} threadId={threadId} lang={lang} refreshKey={refreshKey} review={review} onCloseReview={() => setReview(undefined)}/>}
    <ExtractConversation threadId={threadId} turnId={turnId} lang={lang} small disabled={disabled} onFinished={() => setRefreshKey(value => value + 1)}
      onReview={async (workspace, id) => { setReview({ workspace, id }); }}/>
  </div>;
}

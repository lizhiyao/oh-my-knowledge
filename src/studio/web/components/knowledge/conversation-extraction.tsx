'use client';
import { useState } from 'react';
import { Button } from 'antd';
import type { Language } from '../layout/shell';
import { SourceExtractionDialog } from './source-picker';

type Scope = { threadId: string; turnId?: string };

export function ExtractConversation({ threadId, turnId, lang, onFinished, onReview, disabled = false, small = false }: Scope & {
  lang: Language; onFinished?(workspace: string): void; onReview?(workspace: string, id: string, signal: AbortSignal): Promise<void>; disabled?: boolean; small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <><Button type={small ? 'text' : 'primary'} size={small ? 'small' : 'middle'} disabled={disabled} onClick={() => setOpen(true)}>
    {turnId ? (lang === 'zh' ? '提炼这轮' : 'Extract this turn') : (lang === 'zh' ? '提炼整条对话' : 'Extract conversation')}
  </Button>{open && <ConversationExtractionDialog source={{ threadId, ...(turnId ? { turnId } : {}) }} lang={lang} onClose={() => setOpen(false)} onFinished={onFinished} onReview={onReview ? async (workspace, id, signal) => { await onReview(workspace, id, signal); onFinished?.(workspace); setOpen(false); } : undefined}/>}</>;
}

/** Observe and Knowledge share Source3 local capture and exact stage confirmation. */
export function ConversationExtractionDialog(props: {
  source?: Scope; initialWorkspace?: string; lang: Language; onClose(): void; onFinished?(workspace: string): void;
  onReview?(workspace: string, id: string, signal: AbortSignal): Promise<void>;
}) {
  return <SourceExtractionDialog {...props} initialMode="conversation"/>;
}

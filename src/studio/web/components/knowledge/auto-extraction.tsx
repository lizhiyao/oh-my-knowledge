'use client';
import type { Language } from '../layout/shell';

/** The adjacent explicit extraction action owns source selection and per-stage request confirmation. */
export function AutoExtractConversation({ lang }: { threadId: string; lang: Language; onChanged?(): void }) {
  return <span className="auto-extraction-status" role="status">
    {lang === 'zh' ? '需逐阶段确认，不再自动提炼。' : 'Extraction requires confirmation at each stage; automatic extraction is disabled.'}
  </span>;
}

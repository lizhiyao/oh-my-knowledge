'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { requestKnowledge } from './request';
import type { SourceViewSnapshot } from '../../../view-models/knowledge/knowledge-candidates';
import Link from 'next/link';
import type { SourceExcerpt, SourceExcerptCoordinate, SourceMaterialAttribution, SourceRef, SourceResolution, SourceUnitCoordinate } from '../../../../knowledge/sources';
import type { SourceSummary } from '../../../../knowledge/application/source-summary';
import type { Language } from '../layout/shell';
import { displayTime } from '../../../application/display/format';
import { conversationPath } from '../conversation-link';
import { workspaceHref } from '../layout/workspace-link';
import { locateQuoteOccurrence } from '../../../../knowledge/extraction/quote-occurrence';

type Source = SourceSummary | SourceViewSnapshot;
/** Textareas normalize CRLF to LF; persisted quotation offsets continue to address the untouched source. */
export function sourceTextAreaText(text: string) { return text.replace(/\r\n?/gu, '\n'); }
export function sourceTextAreaOffset(text: string, sourceOffset: number) { return sourceTextAreaText(text.slice(0, sourceOffset)).length; }
export function sourceOriginalOffset(text: string, textAreaOffset: number) {
  let sourceOffset = 0, normalized = 0;
  while (sourceOffset < text.length && normalized < textAreaOffset) {
    sourceOffset += text[sourceOffset] === '\r' && text[sourceOffset + 1] === '\n' ? 2 : 1; normalized++;
  }
  return sourceOffset;
}
/** Locate what the user sees, then restore the exact original quote and UTF-16 range for host validation. */
export function locateSourceQuoteOccurrence(locator: Parameters<typeof locateQuoteOccurrence>[0], excerpts: readonly Pick<SourceExcerpt, 'evidenceRef' | 'text'>[]) {
  const located = locateQuoteOccurrence({ ...locator, quote: sourceTextAreaText(locator.quote) },
    excerpts.map(excerpt => ({ ...excerpt, text: sourceTextAreaText(excerpt.text) })));
  if (typeof located === 'string') return located;
  const text = excerpts.find(excerpt => excerpt.evidenceRef === located.evidenceRef)!.text;
  const start = sourceOriginalOffset(text, located.start), end = sourceOriginalOffset(text, located.end);
  return { ...located, start, end, quote: text.slice(start, end) };
}
export function sourceTitle(source: Source | undefined, lang: Language) {
  if (!source) return lang === 'zh' ? '来源不可读' : 'Source unavailable';
  if ('relativePath' in source.identity) return source.identity.relativePath;
  return ('origin' in source ? source.origin?.title : undefined) || (lang === 'zh' ? 'Agent 记录' : 'Agent trace');
}
export function sourceMaterialLabel(material: SourceMaterialAttribution['materialType'], lang: Language) {
  return ({ design: ['设计材料', 'Design material'], implementation: ['实现材料', 'Implementation material'], configuration: ['配置材料', 'Configuration material'],
    test_expectation: ['测试预期', 'Test expectation'], execution_record: ['来源执行记录', 'Source execution record'], discussion: ['讨论材料', 'Discussion material'], unknown: ['材料类型未知', 'Unknown material type'] })[material][lang === 'zh' ? 0 : 1];
}
export function sourceCoordinateLabel(coordinate: SourceExcerptCoordinate | SourceUnitCoordinate, lang: Language) {
  if (coordinate.coordinateKind === 'trace_record' || coordinate.coordinateKind === 'trace_event') {
    const record = lang === 'zh' ? `来源记录 ${coordinate.recordIndex}` : `Source record ${coordinate.recordIndex}`;
    return coordinate.coordinateKind === 'trace_record' ? record : [record, coordinate.role ?? coordinate.eventKind,
      ...(coordinate.timestamp ? [displayTime(coordinate.timestamp)] : [])].join(' · ');
  }
  const range = lang === 'zh' ? `第 ${coordinate.startLine}–${coordinate.endLine} 行` : `Lines ${coordinate.startLine}–${coordinate.endLine}`;
  return `${coordinate.relativePath} · ${range} · UTF-8 ${lang === 'zh' ? '字节' : 'bytes'} [${coordinate.startByte}, ${coordinate.endByte})`;
}

/** Display source-declared material and exact coordinates without inferring execution or current implementation. */
export function SourceLocator({ source, sourceRef, excerpt, lang, workspace = '', identity = true }: {
  source: Source; sourceRef?: SourceRef; excerpt?: SourceExcerpt; lang: Language; workspace?: string; identity?: boolean;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const origin = source.sourceKind === 'agent_trace' && 'origin' in source ? source.origin : undefined;
  const ref = sourceRef ?? ('snapshotId' in source ? { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion } : undefined);
  return <div className="candidate-help knowledge-source-locator">
    <p>{origin && workspace ? <Link href={workspaceHref(conversationPath(origin.threadId, origin.turnId), workspace)}>{sourceTitle(source, lang)}</Link> : sourceTitle(source, lang)} · {sourceMaterialLabel(excerpt?.material.materialType ?? source.material.materialType, lang)}</p>
    {source.sourceKind !== 'agent_trace' && <p>{'projectId' in source.identity ? source.identity.projectId : ''} · {source.sourceKind === 'git_blob'
      ? `${t('固定 Git 快照', 'Fixed Git snapshot')} · ${'commitOid' in source.identity ? source.identity.commitOid.slice(0, 12) : ''}` : t('项目文件快照', 'Project file snapshot')}
      {' · '}{t('不证明当前实现或真实执行。', 'Does not establish current implementation or actual execution.')}</p>}
    {excerpt && <p>{sourceCoordinateLabel(excerpt.coordinate, lang)}</p>}
    {identity && <details><summary>{t('精确来源身份与材料归因', 'Exact source identity and material attribution')}</summary>
      {ref && <p><code>{ref.snapshotId} / {ref.sourceVersion}</code></p>}
      <pre>{JSON.stringify({ sourceKind: source.sourceKind, identity: source.identity, selection: source.selection }, null, 2)}</pre>
      <p>{t('材料归因：', 'Material attribution: ')}{source.material.attributionBasis} · {source.material.reason}</p>
      {excerpt && <p>{t('片段材料归因：', 'Excerpt material attribution: ')}{excerpt.material.attributionBasis} · {excerpt.material.reason}</p>}
      {'capturedAt' in source && <p>{t('快照保存时间：', 'Snapshot capture time: ')}{displayTime(source.capturedAt)}</p>}
      {'provenance' in source && <pre>{JSON.stringify(source.provenance, null, 2)}</pre>}
    </details>}
  </div>;
}

export function SourceOriginalContext({ snapshot, excerpt, lang, workspace }: { snapshot: SourceViewSnapshot; excerpt: SourceExcerpt; lang: Language; workspace?: string }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [source, setSource] = useState<SourceResolution>(), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => { active.current?.abort(); active.current = null; setSource(undefined); setFailed(false); setBusy(false); return () => { active.current?.abort(); active.current = null; }; }, [workspace, snapshot.snapshotId, snapshot.sourceVersion]);
  const units = source?.status === 'available' ? source.snapshot.rawUnits.filter(unit => snapshot.sourceKind === 'agent_trace'
    ? Math.abs(unit.unitId - excerpt.unitId) <= 1 : unit.unitId === excerpt.unitId) : [];
  return <details><summary>{snapshot.sourceKind === 'agent_trace' ? t('原始记录及相邻已选上下文', 'Original records and adjacent selected context') : t('原始文件片段', 'Original file excerpt')}</summary>
    <p>{t('完整原件按需从当前工作区单独读取，不改变已显示的正文、引文或定位。', 'Read complete originals separately from this workspace on demand. Displayed content, quotes and locators stay unchanged.')}</p>
    <Button disabled={busy || !workspace?.trim()} loading={busy} onClick={() => {
      if (!workspace?.trim() || active.current) return;
      const controller = new AbortController(); active.current = controller; setBusy(true); setFailed(false); setSource(undefined);
      void requestKnowledge<SourceResolution>('candidates', { operation: 'source', workspace,
        source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion } }, controller.signal)
        .then(value => { if (!controller.signal.aborted) {
          if (value.status === 'available' && (value.snapshot.snapshotId !== snapshot.snapshotId || value.snapshot.sourceVersion !== snapshot.sourceVersion)) throw new Error('Source pair changed.');
          setSource(value);
        } }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
        .finally(() => { if (active.current === controller) { active.current = null; setBusy(false); } });
    }}>{t('读取完整原件', 'Read complete originals')}</Button>
    {!workspace?.trim() && <p>{t('未选择工作区，尚未读取原件。', 'No workspace selected; originals have not been read.')}</p>}
    {(failed || source?.status === 'unavailable') && <p role="status">{t('完整原件暂不可读；上方已保存正文与引文仍可核对。', 'Complete originals are unavailable; the saved content and quotes above remain available for review.')}{source?.status === 'unavailable' ? ` (${source.reason})` : ''}</p>}
    {units.map(unit => <section key={unit.unitId}><p className="candidate-help">{sourceCoordinateLabel(unit.coordinate, lang)}</p><pre className="knowledge-source">{unit.text}</pre></section>)}
  </details>;
}

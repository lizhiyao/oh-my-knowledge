/** Agent workspace Markdown 对话日志 -> source-neutral Trace IR。 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { TraceEvent, TraceSession } from '../../trace-ir.js';
import {
  createTraceId,
  normalizeTraceTimestamp,
} from '../../trace-ir.js';
import type { TraceIngestionSummary } from '../../../contracts/trace.js';
import { extractMarkdownLogSkill } from '../../attribution.js';
import { emptyTraceIngestionSummary } from '../../ingestion.js';

const MAX_MARKDOWN_LOG_BYTES = 64 * 1024 * 1024;
const MARKDOWN_LOG_BLOCK_RE = /(?:^|\n)---\s*\n## \[([^\]]+)\] 对话记录[^\n]*\n([\s\S]*?)(?=\n---\s*\n## \[|$)/g;

export interface ParsedMarkdownLogFile {
  sessions: TraceSession[];
  ingestion: TraceIngestionSummary;
}

export function parseMarkdownLogFile(filePath: string): ParsedMarkdownLogFile {
  const fileSize = statSync(filePath).size;
  if (fileSize > MAX_MARKDOWN_LOG_BYTES) {
    throw new Error(
      `trace Markdown 日志超过 ${MAX_MARKDOWN_LOG_BYTES} 字节上限：${filePath}`,
    );
  }
  const content = readFileSync(filePath, 'utf-8');
  const sourceRecordCount = (content.match(/^## \[[^\]]+\] 对话记录.*$/gm) ?? []).length;
  if (!content.includes('### 用户输入') || !content.includes('### AI 回复')) {
    return {
      sessions: [],
      ingestion: {
        ...emptyTraceIngestionSummary(1),
        sourceRecordCount,
        malformedRecordCount: sourceRecordCount,
      },
    };
  }

  const sessions: TraceSession[] = [];
  const streamOccurrences = new Map<string, number>();
  let index = 0;

  for (const match of content.matchAll(MARKDOWN_LOG_BLOCK_RE)) {
    const timestamp = markdownLogTimestampToIso(match[1]);
    const body = match[2] ?? '';
    const blockCwd = body.match(/^\*\*工作目录\*\*:\s*(.+)$/m)?.[1]?.trim();
    const blockSessionId = body.match(/^\*\*会话 ID\*\*:\s*(.+)$/m)?.[1]?.trim();
    const explicitRequestId = body.match(/^\*\*请求 ID\*\*:\s*(.+)$/m)?.[1]?.trim();
    const userText = extractMarkdownLogSection(body, '### 用户输入', '### AI 回复');
    const assistantText = extractMarkdownLogSection(body, '### AI 回复');
    if (!userText && !assistantText) continue;

    const contentFingerprint = createHash('sha256')
      .update(`${userText}\u0000${assistantText}`)
      .digest('hex')
      .slice(0, 24);
    const requestId = explicitRequestId ?? contentFingerprint;
    const sessionId = blockSessionId || `${basename(filePath, '.log')}:${requestId}`;
    const streamKey = [
      blockSessionId ? `session:${blockSessionId}` : '',
      explicitRequestId ? `request:${explicitRequestId}` : `content:${contentFingerprint}`,
    ].join('\u0000');
    const streamOccurrence = streamOccurrences.get(streamKey) ?? 0;
    streamOccurrences.set(streamKey, streamOccurrence + 1);
    const cwd = blockCwd;
    const skill = extractMarkdownLogSkill(`${userText}\n${assistantText}`);
    const userContent = skill ? `<command-name>/${skill}</command-name>\n${userText}` : userText;
    const events: TraceEvent[] = [];
    if (userContent) {
      events.push({
        eventKind: 'message',
        eventId: `markdown-log-${requestId}-user-${index}`,
        sourceIndex: 0,
        sourceType: 'markdown:user',
        timestamp,
        role: 'user',
        origin: 'human',
        text: userContent,
      });
    }
    if (assistantText) {
      events.push({
        eventKind: 'message',
        eventId: `markdown-log-${requestId}-assistant-${index}`,
        sourceIndex: 1,
        sourceType: 'markdown:assistant',
        timestamp,
        role: 'assistant',
        origin: 'synthetic',
        text: assistantText,
        attributionSkill: skill ?? undefined,
      });
    }
    sessions.push({
      runId: sessionId,
      rootRunId: sessionId,
      traceId: createTraceId({
        sourceKind: 'markdown_log',
        runId: sessionId,
        sourcePath: filePath,
        streamId: `${streamKey}\u0000occurrence:${streamOccurrence}`,
      }),
      groupPath: dirname(filePath),
      role: 'standalone',
      label: `${basename(filePath)}#${requestId}`,
      sourcePath: filePath,
      sourceKind: 'markdown_log',
      events,
      cwd,
      entrypoint: 'markdown_log',
      startTimestamp: timestamp,
      endTimestamp: timestamp,
    });
    index += 1;
  }

  return {
    sessions,
    ingestion: {
      ...emptyTraceIngestionSummary(1),
      sourceRecordCount,
      parsedRecordCount: sessions.length,
      malformedRecordCount: Math.max(0, sourceRecordCount - sessions.length),
    },
  };
}

function markdownLogTimestampToIso(value: string): string | undefined {
  const m = value.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(Z|[+-]\d{2}:?\d{2})$/,
  );
  if (!m) return undefined;
  const rawOffset = m[7];
  if (!rawOffset) return undefined;
  const offset = rawOffset === 'Z' || rawOffset.includes(':')
    ? rawOffset
    : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`;
  return normalizeTraceTimestamp(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`,
  );
}

function extractMarkdownLogSection(body: string, startMarker: string, endMarker?: string): string {
  const start = body.indexOf(startMarker);
  if (start < 0) return '';
  const from = start + startMarker.length;
  const end = endMarker ? body.indexOf(endMarker, from) : -1;
  return body.slice(from, end >= 0 ? end : undefined).trim();
}

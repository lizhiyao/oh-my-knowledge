import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GapSignalRef, ToolCallInfo } from '../types/index.js';
import { extractGapSignalsFromSample } from '../analysis/gap-analyzer.js';
import { ccTracesToResultEntries, type SkillSegment } from './trace-adapter.js';

export const DEFAULT_PROJECT_OBSERVATIONS_DIR = join(process.cwd(), '.omk', 'observations');
export const DEFAULT_GLOBAL_OBSERVATIONS_DIR = join(homedir(), '.oh-my-knowledge', 'observations');
export const DEFAULT_OBSERVATIONS_DIR = DEFAULT_PROJECT_OBSERVATIONS_DIR;

export type ObservationSignalType = 'failed_search' | 'repeated_failure' | 'hedging' | 'explicit_marker';
export type ObservationSourceKind = 'claude' | 'markdown_log' | 'unknown';
export type ObservationSignalSubtype =
  | 'hard_miss'
  | 'repeated_failure'
  | 'exploratory_miss'
  | 'tool_error'
  | 'permission_error'
  | 'bash_probe'
  | 'not_found'
  | 'permission_denied'
  | 'tool_limit'
  | 'tool_failure'
  | 'regex_only'
  | 'llm_classified'
  | 'marker';

export interface ObservationEvidence {
  tool?: string;
  query?: string;
  path?: string;
  outputSnippet?: string;
  assistantSnippet?: string;
  markerToken?: string;
}

export interface ObservationInboxItem {
  id: string;
  skillName: string;
  artifactVersion: string | 'unknown';
  artifactHash?: string;
  cwd?: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  signalType: ObservationSignalType;
  signalSubtype: ObservationSignalSubtype;
  confidence: number;
  attributionConfidence: number;
  severity: 'high' | 'medium' | 'low' | 'noise';
  severityReason?: string;
  evidence: ObservationEvidence;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  recentSessionIds: string[];
  representativeEvidence: ObservationEvidence[];
}

export interface ObservationInboxReport {
  kind: 'observe-inbox';
  meta: {
    tracePath: string;
    generatedAt: string;
    segmentCount: number;
    itemCount: number;
    skillInvocationCounts?: Record<string, number>;
    skillSessionCounts?: Record<string, number>;
    skillInvocationLastSeen?: Record<string, string>;
    skillToolCallCounts?: Record<string, Record<string, number>>;
  };
  items: ObservationInboxItem[];
}

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function normalizeObservationKeyInput(value: string): string {
  const trimmed = value.trim();
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  const prefix = protocolMatch?.[1] ?? '';
  const body = protocolMatch?.[2] ?? trimmed;
  return (prefix + body
    .toLowerCase()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/:\d+(:\d+)?\b/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, ''));
}

export function inferObservationSourceKind(sourceTrace: string): ObservationSourceKind {
  if (sourceTrace.endsWith('.jsonl')) return 'claude';
  if (sourceTrace.endsWith('.log')) return 'markdown_log';
  return 'unknown';
}

function keyFor(item: Pick<ObservationInboxItem, 'skillName' | 'cwd' | 'sourceKind' | 'signalType' | 'signalSubtype' | 'evidence'>): string {
  const raw = item.signalSubtype === 'bash_probe'
    ? 'bash_probe'
    : item.signalType === 'explicit_marker'
    ? item.evidence.markerToken || item.signalSubtype
    : item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || '';
  return [
    item.sourceKind,
    item.skillName,
    item.cwd ?? '',
    item.signalType,
    item.signalSubtype,
    normalizeObservationKeyInput(raw),
  ].join('\u0000');
}

function markerTokenFromSignal(signal: GapSignalRef): string {
  const evidence = signal.evidence as { marker?: unknown } | undefined;
  const marker = typeof evidence?.marker === 'string' ? evidence.marker : '';
  const context = signal.context ?? '';
  return marker || (context.match(/【推断】|【知识缺口】|【未知】|\[inferred\]|\[unknown\]|\[knowledge\s*gap\]/i)?.[0] ?? 'explicit_marker');
}

function snippet(value: unknown, max = 240): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function queryFromToolCall(tc: ToolCallInfo): { query?: string; path?: string } {
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  if (tc.tool === 'Grep') return { query: String(input.pattern ?? ''), path: String(input.path ?? '') };
  if (tc.tool === 'Read') return { path: String(input.file_path ?? '') };
  if (tc.tool === 'Bash') return { query: String(input.command ?? '') };
  return {};
}

function isSearchTool(tc: ToolCallInfo): boolean {
  if (tc.tool === 'Read' || tc.tool === 'Grep') return true;
  if (tc.tool === 'Bash') {
    const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
    return /\b(grep|rg|find)\b/.test(String(input.command ?? ''));
  }
  return false;
}

function isSuccessfulSearch(tc: ToolCallInfo): boolean {
  if (!isSearchTool(tc) || tc.success === false) return false;
  const out = snippet(tc.output, 1000) ?? '';
  return out !== '' && !/No matches found/i.test(out);
}

function bashCommand(tc: ToolCallInfo): string {
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  return String(input.command ?? '');
}

function isBashProbe(tc: ToolCallInfo): boolean {
  if (tc.tool !== 'Bash') return false;
  const command = bashCommand(tc);
  return /2>\s*\/dev\/null|\|\|\s*(true|echo\b)/.test(command);
}

function failedSearchSubtype(tc: ToolCallInfo, allCalls: ToolCallInfo[], index: number): ObservationSignalSubtype {
  const out = snippet(tc.output, 1000) ?? '';
  if (isBashProbe(tc)) return 'bash_probe';
  if (/permission denied|not authorized|eacces/i.test(out)) return 'permission_denied';
  if (/enoent|no such file or directory|path does not exist|file does not exist|not found|did you mean/i.test(out)) return 'not_found';
  if (/exceeds maximum allowed tokens|maximum allowed tokens|token limit|timed out|timeout/i.test(out)) return 'tool_limit';
  if (tc.success === false) return 'tool_failure';
  const laterSuccess = allCalls.slice(index + 1).some(isSuccessfulSearch);
  return laterSuccess ? 'exploratory_miss' : 'hard_miss';
}

function confidenceForSubtype(subtype: ObservationSignalSubtype, signal?: GapSignalRef): number {
  if (signal?.type === 'repeated_failure') return 0.95;
  if (subtype === 'repeated_failure') return 0.95;
  if (subtype === 'hard_miss') return 0.9;
  if (subtype === 'exploratory_miss' || subtype === 'bash_probe') return 0.4;
  if (subtype === 'tool_error' || subtype === 'permission_error' || subtype === 'not_found' || subtype === 'permission_denied' || subtype === 'tool_limit' || subtype === 'tool_failure') return 0.2;
  if (subtype === 'regex_only') return 0.3;
  if (subtype === 'llm_classified') {
    const c = Number(signal?.classifierVerdict?.confidence);
    return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  }
  return 0.5;
}

function severityFor(signalType: ObservationSignalType, subtype: ObservationSignalSubtype, confidence: number): ObservationInboxItem['severity'] {
  if (signalType === 'repeated_failure' || signalType === 'explicit_marker') return 'high';
  if (subtype === 'hard_miss') return 'high';
  if (signalType === 'hedging' && confidence >= 0.7) return 'high';
  if (subtype === 'exploratory_miss' || subtype === 'bash_probe') return 'medium';
  if (subtype === 'tool_error' || subtype === 'permission_error' || subtype === 'not_found' || subtype === 'permission_denied' || subtype === 'tool_limit' || subtype === 'tool_failure' || subtype === 'regex_only') return 'noise';
  return 'low';
}

export function severityReasonFor(item: Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence' | 'evidence'>): string {
  const tool = item.evidence.tool ? `${item.evidence.tool} ` : '';
  if (item.signalType === 'repeated_failure') return '同类搜索连续失败 3 次以上，是强缺口信号，高于单次 hard_miss。';
  if (item.signalType === 'explicit_marker') return 'agent 主动输出了知识缺口/未知标记，需要优先人工确认。';
  if (item.signalSubtype === 'hard_miss') return `${tool}失败后，session 内未找到同主题成功证据，疑似知识缺口。`;
  if (item.signalSubtype === 'bash_probe') return 'skill 运行过程中，agent 调用了一条 Bash 命令；命令里用了 2>/dev/null 或 || true/echo 这类“失败也继续”的写法，更像是在试路径，不直接判为要改 skill。';
  if (item.signalSubtype === 'exploratory_miss') return '前序搜索失败，但后续出现成功搜索证据，更像探索性试错。';
  if (item.signalSubtype === 'tool_limit') return `${tool}触发 token/超时等工具限制，与知识库覆盖无直接关系。`;
  if (item.signalSubtype === 'not_found') return `${tool}访问的文件或路径不存在，先按路径/环境噪声处理。`;
  if (item.signalSubtype === 'permission_denied') return `${tool}访问被权限拒绝，先按权限/环境噪声处理。`;
  if (item.signalSubtype === 'tool_failure') return `${tool}调用失败，先按运行时工具问题处理。`;
  if (item.signalSubtype === 'regex_only') return '仅命中 hedging 正则，假阳风险较高，默认作为低优先级噪声。';
  if (item.signalSubtype === 'llm_classified') return 'hedging 经过分类器确认，confidence 来自分类器输出。';
  return '低置信信号，需要结合 evidence 和上下文人工判断。';
}

function itemsFromSegment(segment: SkillSegment): ObservationInboxItem[] {
  // inbox 只观察真实 skill 调用场景。'general' 是 trace-adapter 对裸对话的
  // 兜底归因（无 Skill tool / 无 <command-name> / 无 Read SKILL.md），
  // attributionConfidence 仅 0.3，没有 skill 改进价值，直接过滤。
  if (segment.skillName === 'general') return [];

  const variant = segment.skillName;
  const entry = {
    sample_id: `${segment.sessionId}:${segment.segmentIndex}`,
    variants: {
      [variant]: {
        ok: true,
        durationMs: segment.metrics.durationMs,
        durationApiMs: segment.metrics.durationMs,
        inputTokens: segment.metrics.inputTokens,
        outputTokens: segment.metrics.outputTokens,
        totalTokens: segment.metrics.inputTokens + segment.metrics.outputTokens,
        cacheReadTokens: segment.metrics.cacheReadTokens,
        cacheCreationTokens: segment.metrics.cacheCreationTokens,
        execCostUSD: 0,
        judgeCostUSD: 0,
        costUSD: 0,
        numTurns: segment.metrics.numTurns,
        outputPreview: null,
        turns: segment.turns,
        toolCalls: segment.toolCalls,
      },
    },
  };
  const signals = extractGapSignalsFromSample(entry.variants[variant], entry.sample_id);
  const items: ObservationInboxItem[] = [];
  const toolCalls = segment.toolCalls;
  const failedSignalsSeen = new Set<number>();

  for (const signal of signals) {
    let subtype: ObservationSignalSubtype;
    let evidence: ObservationEvidence = {};

    if (signal.type === 'failed_search') {
      const matchIndex = toolCalls.findIndex((tc, i) => {
        if (failedSignalsSeen.has(i)) return false;
        const q = queryFromToolCall(tc);
        const signalPattern = String(signal.evidence?.pattern ?? '');
        const sameQuery = !signalPattern
          || q.query === signalPattern
          || (tc.tool === 'Bash' && Boolean(q.query && (q.query.startsWith(signalPattern) || signalPattern.startsWith(q.query.slice(0, signalPattern.length)))));
        return tc.tool === signal.evidence?.tool
          && sameQuery
          && (!signal.evidence?.path || q.path === signal.evidence.path);
      });
      const tc = matchIndex >= 0 ? toolCalls[matchIndex] : undefined;
      if (matchIndex >= 0) failedSignalsSeen.add(matchIndex);
      subtype = tc ? failedSearchSubtype(tc, toolCalls, matchIndex) : 'hard_miss';
      const q = tc ? queryFromToolCall(tc) : { query: String(signal.evidence?.pattern ?? ''), path: String(signal.evidence?.path ?? '') };
      evidence = {
        tool: snippet(signal.evidence?.tool ?? tc?.tool, 80),
        query: snippet(q.query),
        path: snippet(q.path),
        outputSnippet: snippet(tc?.output),
      };
    } else if (signal.type === 'repeated_failure') {
      subtype = 'repeated_failure';
      evidence = { tool: snippet(signal.evidence?.tool, 80), outputSnippet: snippet(signal.context) };
    } else if (signal.type === 'hedging') {
      subtype = signal.classifierVerdict ? 'llm_classified' : 'regex_only';
      evidence = { assistantSnippet: snippet(signal.context) };
    } else {
      subtype = 'marker';
      evidence = { markerToken: snippet(markerTokenFromSignal(signal), 80), assistantSnippet: snippet(signal.context) };
    }

    const signalType = signal.type as ObservationSignalType;
    const confidence = confidenceForSubtype(subtype, signal);
    const severity = severityFor(signalType, subtype, confidence);
    const item: ObservationInboxItem = {
      id: hashString([segment.sessionId, segment.segmentIndex, signal.type, subtype, JSON.stringify(evidence)].join('\u0000')),
      skillName: segment.skillName,
      artifactVersion: 'unknown',
      cwd: segment.cwd,
      sessionId: segment.sessionId,
      sourceTrace: '',
      sourceKind: 'unknown',
      signalType,
      signalSubtype: subtype,
      confidence,
      attributionConfidence: segment.attribution?.confidence ?? 0.3,
      severity,
      severityReason: severityReasonFor({ signalType, signalSubtype: subtype, severity, confidence, evidence }),
      evidence,
      firstSeen: segment.startTimestamp,
      lastSeen: segment.endTimestamp,
      occurrences: 1,
      recentSessionIds: [segment.sessionId],
      representativeEvidence: [evidence],
    };
    items.push(item);
  }

  return items;
}

export function buildObservationInboxReport(tracePath: string): ObservationInboxReport {
  const { sessions, segments } = ccTracesToResultEntries(tracePath);
  const sourceBySession = new Map(sessions.map((s) => [s.sessionId, s.sourcePath]));
  const skillInvocationCounts: Record<string, number> = {};
  const skillInvocationLastSeen: Record<string, string> = {};
  const skillToolCallCounts: Record<string, Record<string, number>> = {};
  const sessionsBySkill = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (segment.skillName === 'general') continue;
    skillInvocationCounts[segment.skillName] = (skillInvocationCounts[segment.skillName] ?? 0) + 1;
    if (!skillInvocationLastSeen[segment.skillName] || segment.endTimestamp > skillInvocationLastSeen[segment.skillName]) {
      skillInvocationLastSeen[segment.skillName] = segment.endTimestamp;
    }
    const toolCounts = skillToolCallCounts[segment.skillName] ?? {};
    for (const toolCall of segment.toolCalls) {
      toolCounts[toolCall.tool] = (toolCounts[toolCall.tool] ?? 0) + 1;
    }
    skillToolCallCounts[segment.skillName] = toolCounts;
    const set = sessionsBySkill.get(segment.skillName) ?? new Set<string>();
    set.add(segment.sessionId);
    sessionsBySkill.set(segment.skillName, set);
  }
  const skillSessionCounts = Object.fromEntries(
    Array.from(sessionsBySkill.entries()).map(([skill, sessionIds]) => [skill, sessionIds.size]),
  );
  const allItems = segments.flatMap((segment) => itemsFromSegment(segment).map((item) => ({
    ...item,
    sourceTrace: sourceBySession.get(segment.sessionId) ?? tracePath,
    sourceKind: inferObservationSourceKind(sourceBySession.get(segment.sessionId) ?? tracePath),
  })));
  const items = aggregateInboxItems(allItems);
  return {
    kind: 'observe-inbox',
    meta: {
      tracePath,
      generatedAt: new Date().toISOString(),
      segmentCount: segments.length,
      itemCount: items.length,
      skillInvocationCounts,
      skillSessionCounts,
      skillInvocationLastSeen,
      skillToolCallCounts,
    },
    items,
  };
}

export function aggregateInboxItems(items: ObservationInboxItem[]): ObservationInboxItem[] {
  const byKey = new Map<string, ObservationInboxItem>();
  const sessionLastSeenByKey = new Map<string, Map<string, string>>();
  for (const item of items) {
    const key = keyFor(item);
    const sessionLastSeen = sessionLastSeenByKey.get(key) ?? new Map<string, string>();
    const previousSessionLastSeen = sessionLastSeen.get(item.sessionId);
    if (!previousSessionLastSeen || item.lastSeen > previousSessionLastSeen) {
      sessionLastSeen.set(item.sessionId, item.lastSeen);
    }
    sessionLastSeenByKey.set(key, sessionLastSeen);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, representativeEvidence: [item.evidence], recentSessionIds: [item.sessionId] });
      continue;
    }
    existing.occurrences += item.occurrences;
    if (item.firstSeen < existing.firstSeen) existing.firstSeen = item.firstSeen;
    if (item.lastSeen > existing.lastSeen) existing.lastSeen = item.lastSeen;
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.attributionConfidence = Math.max(existing.attributionConfidence, item.attributionConfidence);
    if (
      severityRank(item.severity) > severityRank(existing.severity)
      || (item.severity === existing.severity && item.confidence > existing.confidence)
    ) {
      existing.severity = item.severity;
      existing.severityReason = item.severityReason;
    }
    existing.recentSessionIds = Array.from(sessionLastSeen.entries())
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([sessionId]) => sessionId)
      .slice(0, 3);
    existing.representativeEvidence.push(item.evidence);
    existing.representativeEvidence = existing.representativeEvidence.slice(0, 50);
  }
  return Array.from(byKey.values()).sort(compareInboxItems);
}

function severityRank(severity: ObservationInboxItem['severity']): number {
  if (severity === 'high') return 4;
  if (severity === 'medium') return 3;
  if (severity === 'low') return 2;
  return 1;
}

function compareInboxItems(a: ObservationInboxItem, b: ObservationInboxItem): number {
  const severity = severityRank(b.severity) - severityRank(a.severity);
  if (severity !== 0) return severity;
  const confidence = b.confidence - a.confidence;
  if (confidence !== 0) return confidence;
  const lastSeen = b.lastSeen.localeCompare(a.lastSeen);
  if (lastSeen !== 0) return lastSeen;
  return b.occurrences - a.occurrences;
}

export function saveObservationInboxReport(report: ObservationInboxReport, outDir: string = DEFAULT_OBSERVATIONS_DIR): string {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const path = join(outDir, `${stamp}-observe-inbox.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

export function loadObservationInboxReports(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport[] {
  if (!existsSync(dir)) {
    if (dir === DEFAULT_PROJECT_OBSERVATIONS_DIR && existsSync(DEFAULT_GLOBAL_OBSERVATIONS_DIR)) {
      return loadObservationInboxReports(DEFAULT_GLOBAL_OBSERVATIONS_DIR);
    }
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('-observe-inbox.json'))
    .map((file) => {
      try {
        const report = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ObservationInboxReport;
        report.items = report.items.map((item) => {
          const sourceKind = (item as { sourceKind?: string }).sourceKind;
          return {
            ...item,
            sourceKind: sourceKind === 'openclaw'
              ? 'markdown_log'
              : (item.sourceKind ?? inferObservationSourceKind(item.sourceTrace)),
          };
        });
        return report;
      } catch {
        return null;
      }
    })
    .filter((r): r is ObservationInboxReport => r?.kind === 'observe-inbox');
}

export function queryObservationInbox(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxItem[] {
  const reports = loadObservationInboxReports(dir);
  return aggregateInboxItems(reports.flatMap((report) => report.items));
}

export function selectExploreInboxItems(
  items: ObservationInboxItem[],
  limit: number,
  includeNoise = false,
  random: () => number = Math.random,
): ObservationInboxItem[] {
  const candidates = items
    .filter((item) => item.severity === 'medium' || item.severity === 'low' || (includeNoise && item.severity === 'noise'))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 50);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
}

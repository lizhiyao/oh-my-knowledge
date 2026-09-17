import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceSessions, type TraceSession } from '../../src/observability/trace/source.js';

/** Exercise the production Claude parser before testing source-neutral projections. */
export function loadClaudeTraceFixture(records: readonly object[], runId: string): TraceSession {
  const root = mkdtempSync(join(tmpdir(), 'omk-claude-trace-'));
  try {
    const path = join(root, 'trace.jsonl');
    writeFileSync(path, records.map((record) => JSON.stringify({ ...record, sessionId: runId })).join('\n'));
    const [session] = loadTraceSessions(path);
    if (!session) throw new Error('Claude fixture did not produce a trace session');
    return session;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Claude trace 事件 builder：与 loadClaudeTraceFixture 配对——builder 造 records，
 * loader 装成 TraceSession；inbox 侧则把 records 写进 jsonl 交给 buildObservationInboxReport。
 *
 * 字段口径（判据同 #950：有没有用例的论点就是这个字段）：
 * - 必填（被测对象）：skill 名、tool_use 的 id／name、tool_result 的回链 id、消息文本。
 * - 默认（结构样板）：uuid 按事件序号生成、parentUuid 自动挂上一个事件（线性链）、
 *   timestamp 从 startAt 逐秒递增、cwd 固定 '/repo-a'。分叉、孤儿、非均匀时间
 *   都是被测形态，必须经 overrides 显式表达。
 * - event() 是逃生舱：type 与 message.role 不一致等稀有形态原样透传，
 *   只补结构字段（uuid／parentUuid／timestamp／cwd／sessionId）。
 */
export interface ClaudeEventOverrides {
  uuid?: string;
  /** 默认挂到上一个事件；显式 null 造孤儿，显式 uuid 造分叉。 */
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  /** 稀有顶层字段透传（entrypoint、isSidechain、toolUseResult 等）。 */
  extra?: Record<string, unknown>;
}

export interface ClaudeToolResultSpec extends ClaudeEventOverrides {
  isError?: boolean;
}

export class ClaudeTraceBuilder {
  private readonly records: Array<Record<string, unknown>> = [];
  private readonly startAt: string;
  private readonly cwd: string;
  private sequence = 0;
  private readonly uuidCounters: Record<string, number> = { u: 0, a: 0 };
  private lastUuid: string | null = null;

  constructor(
    private readonly sessionId: string,
    options: { startAt?: string; cwd?: string } = {},
  ) {
    this.startAt = options.startAt ?? '2026-05-01T00:00:00.000Z';
    this.cwd = options.cwd ?? '/repo-a';
  }

  /** user 消息：skill 调用（content 为 `<command-name>/skill</command-name>` + 可选文本）。 */
  userCommand(skill: string, text?: string, overrides?: ClaudeEventOverrides): this {
    const content = text === undefined
      ? `<command-name>/${skill}</command-name>`
      : `<command-name>/${skill}</command-name>\n${text}`;
    return this.push('user', { role: 'user', content }, overrides);
  }

  /** user 消息：纯文本。 */
  userText(text: string, overrides?: ClaudeEventOverrides): this {
    return this.push('user', { role: 'user', content: text }, overrides);
  }

  /** user 消息：单个 tool_result。toolUseId 必须回链某个 tool_use 的 id。 */
  userToolResult(toolUseId: string, content: unknown, options: ClaudeToolResultSpec = {}): this {
    return this.userToolResults([{ toolUseId, content, isError: options.isError }], options);
  }

  /** user 消息：多个 tool_result 合并成一条（多 tool_use 的对应形态）。 */
  userToolResults(
    results: Array<{ toolUseId: string; content: unknown; isError?: boolean }>,
    overrides: ClaudeEventOverrides = {},
  ): this {
    return this.push('user', {
      role: 'user',
      content: results.map(({ toolUseId, content, isError }) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError ?? false,
      })),
    }, overrides);
  }

  /** assistant 消息：纯文本。 */
  assistantText(text: string, overrides?: ClaudeEventOverrides): this {
    return this.push('assistant', { role: 'assistant', content: [{ type: 'text', text }] }, overrides);
  }

  /** assistant 消息：单个 tool_use。id 供后续 tool_result 回链。 */
  assistantToolUse(
    id: string,
    name: string,
    input: Record<string, unknown>,
    overrides?: ClaudeEventOverrides,
  ): this {
    return this.assistantToolUses([{ id, name, input }], overrides);
  }

  /** assistant 消息：多个 tool_use 合并成一条。 */
  assistantToolUses(
    uses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    overrides: ClaudeEventOverrides = {},
  ): this {
    return this.push('assistant', {
      role: 'assistant',
      content: uses.map(({ id, name, input }) => ({ type: 'tool_use', id, name, input })),
    }, overrides);
  }

  /**
   * 逃生舱：稀有形态原样透传（如 type=user 配 role=assistant 的畸形记录、
   * system／summary 等非对话事件），只补结构字段。record 里的 uuid／parentUuid／
   * timestamp／cwd 优先于自动值。
   */
  event(record: Record<string, unknown> & { type: string }, overrides: ClaudeEventOverrides = {}): this {
    const skeleton = this.skeleton(String(record.type), overrides);
    const merged = { ...skeleton, ...record, sessionId: this.sessionId };
    this.records.push(merged);
    this.lastUuid = merged.uuid as string;
    return this;
  }

  build(): Array<Record<string, unknown>> {
    return this.records.map((record) => ({ ...record }));
  }

  private push(
    type: 'user' | 'assistant',
    message: Record<string, unknown>,
    overrides: ClaudeEventOverrides = {},
  ): this {
    this.records.push({ ...this.skeleton(type, overrides), message });
    return this;
  }

  private skeleton(type: string, overrides: ClaudeEventOverrides): Record<string, unknown> {
    this.sequence += 1;
    const { uuid, parentUuid, timestamp, cwd, extra } = overrides;
    const prefix = type === 'assistant' ? 'a' : 'u';
    const resolvedUuid = uuid ?? `${prefix}${(this.uuidCounters[prefix] = (this.uuidCounters[prefix] ?? 0) + 1)}`;
    const record: Record<string, unknown> = {
      type,
      uuid: resolvedUuid,
      parentUuid: parentUuid === undefined ? this.lastUuid : parentUuid,
      sessionId: this.sessionId,
      timestamp: timestamp ?? new Date(Date.parse(this.startAt) + (this.sequence - 1) * 1000).toISOString(),
      cwd: cwd ?? this.cwd,
      ...extra,
    };
    this.lastUuid = resolvedUuid;
    return record;
  }
}

/** 建一条 Claude 会话的事件序列；sessionId 必填（会话归属是被测对象）。 */
export function claudeTrace(
  sessionId: string,
  options: { startAt?: string; cwd?: string } = {},
): ClaudeTraceBuilder {
  return new ClaudeTraceBuilder(sessionId, options);
}

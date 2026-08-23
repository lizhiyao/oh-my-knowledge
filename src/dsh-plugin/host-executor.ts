import { randomUUID } from 'node:crypto';
import type { ExecResult, ExecutorFn, ExecutorInput } from '../types/index.js';
import { buildDshHostResult, type DshHostRunResult } from '../executors/dsh-protocol.js';

type UnknownRecord = Record<string, unknown>;

export interface DshSessionLike {
  readonly id: string;
  readonly events: readonly UnknownRecord[];
  readonly header: {
    readonly cwd?: string;
    readonly parentSession?: string;
  };
}

export interface DshAgentLike {
  readonly id: string;
  readonly options: {
    readonly provider?: string;
    readonly model?: string;
  };
  readonly session: DshSessionLike;
  followup(message: UnknownRecord): void;
  whenIdle(): Promise<void>;
  cancel(cause: Readonly<Record<'kind', 'hook'> & { reason: string }>): void;
}

interface DshAgentScopeLike {
  readonly agent?: DshAgentLike;
  readonly systemPrompt: {
    section(section: {
      readonly name: string;
      readonly order: number;
      readonly text: string;
      readonly complete: true;
    }): () => void;
    suppressRuntimeContext(): () => void;
  };
  readonly tools?: {
    get(name: string, agent?: DshAgentLike): unknown;
    restrict(filter: { readonly deny: readonly string[] }): () => void;
  };
}

interface DshAgentHandleLike {
  readonly agent: DshAgentLike;
  dispose(): Promise<void>;
}

/** Minimal same-process DSH surface consumed by the OMK host adapter. */
export interface DshHostContextLike {
  readonly agents: {
    create(options: {
      readonly sessionId: string;
      readonly meta: {
        readonly cwd: string;
        readonly parentSession?: string;
      };
      readonly agentOptions: {
        readonly provider?: string;
        readonly model: string;
      };
      readonly setup: (ctx: DshAgentScopeLike) => void;
    }): Promise<DshAgentHandleLike>;
  };
  on(
    event: 'session/event',
    listener: (session: DshSessionLike, entry: UnknownRecord) => void,
  ): () => void;
  on(
    event: 'session/created',
    listener: (session: DshSessionLike) => void,
  ): () => void;
}

export interface DshHostExecutorOptions {
  /** Interactive DSH session that initiated the measurement. */
  parentAgent?: DshAgentLike;
  /** Provider inherited by fresh measurement sessions. */
  provider?: string;
  /** Cancellation owned by the DSH command or embedding surface. */
  signal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return [];
    const record = block as UnknownRecord;
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

function lastAssistantText(events: readonly UnknownRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    const data = typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
      ? event.data as UnknownRecord
      : undefined;
    const message = typeof data?.message === 'object' && data.message !== null && !Array.isArray(data.message)
      ? data.message as UnknownRecord
      : undefined;
    const text = textFromContent(message?.content);
    if (text.length > 0) return text;
  }
  return '';
}

function failureResult(startedAt: number, error: unknown): ExecResult {
  return {
    ok: false,
    output: null,
    durationMs: Date.now() - startedAt,
    durationApiMs: Date.now() - startedAt,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokenUsageReportedByExecutor: false,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: 'error',
    numTurns: 0,
    error: errorMessage(error),
  };
}

function createPromptMessage(prompt: string): UnknownRecord {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [Object.freeze({ type: 'text', text: prompt })],
    source: Object.freeze({ kind: 'user' }),
  });
}

async function waitForIdle(
  agent: DshAgentLike,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<'idle' | 'timeout' | 'aborted'> {
  if (signal?.aborted) {
    agent.cancel({ kind: 'hook', reason: 'OMK evaluation command was aborted' });
    await agent.whenIdle();
    return 'aborted';
  }
  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const outcome = await Promise.race([
    agent.whenIdle().then(() => 'idle' as const),
    ...(timeoutMs === undefined ? [] : [new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    })]),
    ...(signal === undefined ? [] : [new Promise<'aborted'>((resolve) => {
      const onAbort = (): void => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    })]),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  removeAbortListener?.();
  if (outcome === 'idle') return outcome;
  agent.cancel({
    kind: 'hook',
    reason: outcome === 'timeout'
      ? `OMK sample timed out after ${timeoutMs ?? 0}ms`
      : 'OMK evaluation command was aborted',
  });
  await agent.whenIdle();
  return outcome;
}

function assertSupportedIsolation(input: ExecutorInput): void {
  if (input.allowedSkills && input.allowedSkills.length > 0) {
    throw new Error('dsh-host executor 不支持非空 skill 白名单；请注入待测 artifact，并使用 allowedSkills: [] 隔离环境 skill。');
  }
}

/**
 * Build an OMK executor that creates fresh agents inside an already-running
 * DSH plugin tree. The host keeps ownership of credentials, tools, policies,
 * and persistence; OMK owns sample isolation and result projection.
 */
export function createDshHostExecutor(
  ctx: DshHostContextLike,
  options: DshHostExecutorOptions = {},
): ExecutorFn {
  return async (input): Promise<ExecResult> => {
    const startedAt = Date.now();
    let handle: DshAgentHandleLike | undefined;
    const rootSessionId = `omk-${randomUUID()}`;
    const descendants = new Set<string>();
    const descendantEvents: DshHostRunResult['descendantEvents'] = [];
    const disposeCreated = ctx.on('session/created', (session) => {
      const parent = session.header.parentSession;
      if (parent !== rootSessionId && (parent === undefined || !descendants.has(parent))) return;
      descendants.add(String(session.id));
    });
    const disposeEvents = ctx.on('session/event', (session, event) => {
      const sessionId = String(session.id);
      if (sessionId === rootSessionId) return;
      if (!descendants.has(sessionId)) return;
      descendantEvents.push({ sessionId, event });
    });

    try {
      assertSupportedIsolation(input);
      const cwd = input.cwd ?? process.cwd();
      const provider = options.provider ?? options.parentAgent?.options.provider;
      handle = await ctx.agents.create({
        sessionId: rootSessionId,
        meta: {
          cwd,
          ...(options.parentAgent ? { parentSession: String(options.parentAgent.id) } : {}),
        },
        agentOptions: {
          ...(provider ? { provider } : {}),
          model: input.model,
        },
        setup(agentCtx) {
          agentCtx.systemPrompt.section({
            name: 'omk:evaluation',
            order: 0,
            text: input.system ?? '',
            complete: true,
          });
          agentCtx.systemPrompt.suppressRuntimeContext();
          const scopedAgent = agentCtx.agent;
          if (agentCtx.tools?.get('skill', scopedAgent) !== undefined) {
            agentCtx.tools.restrict({ deny: ['skill'] });
          }
        },
      });

      handle.agent.followup(createPromptMessage(input.prompt));
      const outcome = await waitForIdle(handle.agent, input.timeoutMs, options.signal);
      const wallClockDurationMs = Date.now() - startedAt;
      const events = [...handle.agent.session.events];
      const result = buildDshHostResult({
        rootSessionId,
        finalResponse: lastAssistantText(events),
        rootEvents: events,
        descendantEvents,
        childSessionIds: [...descendants],
      }, wallClockDurationMs);
      if (outcome === 'idle') return result;
      return {
        ...result,
        ok: false,
        stopReason: outcome,
        error: outcome === 'timeout'
          ? `dsh-host execution timed out after ${input.timeoutMs ?? 0}ms`
          : 'dsh-host execution aborted by its DSH command',
      };
    } catch (error) {
      return failureResult(startedAt, error);
    } finally {
      disposeEvents();
      disposeCreated();
      if (handle !== undefined) {
        try {
          await handle.dispose();
        } catch (error) {
          process.stderr.write(`[dsh-host] 评测 session 关闭失败：${errorMessage(error)}\n`);
        }
      }
    }
  };
}

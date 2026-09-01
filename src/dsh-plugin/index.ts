import { dirname, join, resolve } from 'node:path';
import { loadEvalConfig } from '../inputs/eval-config.js';
import {
  type DshAgentLike,
  type DshHostContextLike,
} from './host-executor.js';
import { runDshCoreEvaluation } from './core-command.js';

export {
  DSH_HOST_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  createDshHostCoreExecutorAdapter,
  createDshHostCoreSchemaValidators,
  type CreateDshHostCoreExecutorAdapterInput,
  type DshHostCoreConfiguration,
} from './core-adapter.js';
import {
  createDshConversationCatalog,
  dshTraceIngestionSummary,
  listDshObserveCandidates,
  readDshObservedGroup,
  type DshSessionPersistenceLike,
} from './observe.js';

interface DshCommandInvocationLike {
  readonly agent: DshAgentLike;
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

// These `kind` records mirror the host-owned DSH command protocol.
type DshCommandResultLike =
  | Readonly<Record<'kind', 'success'> & { text?: string }>
  | Readonly<Record<'kind', 'error'> & { text: string }>;

interface DshPluginContextLike extends DshHostContextLike {
  get?(name: 'sessionPersistence'): DshSessionPersistenceLike | undefined;
  readonly commands: {
    register(definition: {
      readonly name: string;
      readonly description: string;
      readonly input: { readonly hint: string };
      readonly handler: (
        invocation: DshCommandInvocationLike,
      ) => DshCommandResultLike | Promise<DshCommandResultLike>;
    }): () => void;
  };
}

export const name = 'omk-dsh-plugin';
export const inject = ['agentPresets', 'agents', 'commands', 'tools'];

const HELP = [
  'OMK 已接入当前 DeepSeek Harness。',
  '',
  '受控评测：/omk eval <eval.yaml>',
  '查看最近任务：/omk observe',
  '打开任务轨迹：/omk observe <session-id>',
  '',
  '文档：https://oh-my-knowledge.pages.dev/zh/reference/executors',
].join('\n');
const USAGE = '用法：/omk eval <eval.yaml> 或 /omk observe [session-id]；运行 /omk 查看帮助。';

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

type DshCommand =
  | { commandKind: 'help' }
  | { commandKind: 'eval'; path: string }
  | { commandKind: 'observe'; sessionId?: string };

function parseCommand(rawInput: string): DshCommand | undefined {
  const normalized = rawInput.trim();
  if (!normalized || normalized === 'help') return { commandKind: 'help' };
  const evalMatch = /^\s*eval\s+(.+?)\s*$/u.exec(rawInput);
  const evalPath = evalMatch?.[1]?.trim();
  if (evalPath) return { commandKind: 'eval', path: unquote(evalPath) };
  const observeMatch = /^\s*observe(?:\s+(.+?))?\s*$/u.exec(rawInput);
  if (!observeMatch) return undefined;
  const sessionId = observeMatch[1]?.trim();
  return {
    commandKind: 'observe',
    ...(sessionId ? { sessionId: unquote(sessionId) } : {}),
  };
}

function projectRoot(configPath: string): string {
  return dirname(configPath);
}

async function executeEvalCommand(
  ctx: DshPluginContextLike,
  invocation: DshCommandInvocationLike,
  requestedPath: string,
): Promise<DshCommandResultLike> {
  const cwd = invocation.agent.session.header.cwd ?? process.cwd();
  const configPath = resolve(cwd, requestedPath);
  const config = loadEvalConfig(configPath);
  if (config.executor) {
    return {
      kind: 'error',
      text: 'DSH 内运行 OMK 时，被测执行器固定为当前 DSH；请删除 eval.yaml 中的顶层 executor。',
    };
  }
  if (config.effort) {
    return {
      kind: 'error',
      text: 'DSH 的 reasoning effort 是 provider-owned 枚举，当前无法与 OMK 五档无损映射；请删除 eval.yaml 中的 effort，并在 DSH profile 中固定模型推理配置。',
    };
  }

  const root = projectRoot(configPath);
  const result = await runDshCoreEvaluation({
    host: ctx,
    parentAgent: invocation.agent,
    signal: invocation.signal,
    config,
    projectRoot: root,
  });
  const decision = result.outcome.decision;
  const verdict = decision?.decisionStatus === 'decided'
    ? decision.verdict
    : result.outcome.gate.gateStatus.toUpperCase();
  const reasonCodes = decision === undefined || decision.decisionStatus === 'failed'
    ? result.outcome.gate.reasonCodes
    : decision.reasonCodes;
  const runId = result.outcomeKind === 'run'
    ? result.outcome.runId
    : result.outcome.seriesId;
  return {
    kind: 'success',
    text: [
      `OMK Core 评测完成：${verdict}`,
      `原因：${reasonCodes.join('、') || '无'}`,
      `Run：${runId}`,
      `产物目录：${result.outputDirectory}`,
    ].join('\n'),
  };
}

interface DshStudioServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
}

interface DshObserveState {
  readonly catalog: ReturnType<typeof createDshConversationCatalog>;
  server?: DshStudioServer;
  serverUrl?: string;
}

function persistenceFor(ctx: DshPluginContextLike): DshSessionPersistenceLike {
  const persistence = ctx.get?.('sessionPersistence');
  if (!persistence) {
    throw new Error('当前 DSH profile 没有启用 sessionPersistence；/omk eval 仍可使用，但任务轨迹需要配置 JSONL 或 SQLite persistence backend。');
  }
  return persistence;
}

async function studioUrl(
  invocation: DshCommandInvocationLike,
  state: DshObserveState,
): Promise<string> {
  if (state.serverUrl) return state.serverUrl;
  const cwd = invocation.agent.session.header.cwd ?? process.cwd();
  const omkDir = join(cwd, '.omk');
  const { createReportServer } = await import('../studio/http/report-server.js');
  const {
    createNodeCoreContentStore,
    createNodeCoreRunArtifactStore,
  } = await import('../eval-workflows/artifact-store/index.js');
  const { createCoreStudioCatalog } = await import('../studio/core-runs/index.js');
  const reportsDir = join(omkDir, 'reports');
  const contentStore = createNodeCoreContentStore(join(reportsDir, 'content'));
  state.server = createReportServer({
    port: 0,
    coreStudioCatalog: createCoreStudioCatalog(createNodeCoreRunArtifactStore(reportsDir, {
      contentResolver: contentStore,
    })),
    analysesDir: join(omkDir, 'observe-health'),
    doctorsDir: join(omkDir, 'doctors'),
    observationsDir: join(omkDir, 'observe-inbox'),
    managedDir: join(omkDir, 'managed'),
    conversationCatalog: state.catalog,
  });
  state.serverUrl = await state.server.start();
  return state.serverUrl;
}

async function executeObserveCommand(
  ctx: DshPluginContextLike,
  invocation: DshCommandInvocationLike,
  sessionId: string | undefined,
  state: DshObserveState,
): Promise<DshCommandResultLike> {
  const persistence = persistenceFor(ctx);
  if (!sessionId) {
    const candidates = await listDshObserveCandidates(persistence, {
      excludeSessionId: String(invocation.agent.session.id),
      signal: invocation.signal,
    });
    if (candidates.length === 0) {
      return {
        kind: 'success',
        text: '没有找到可观测的已结束 DSH session。完成一个任务后再运行 /omk observe。',
      };
    }
    return {
      kind: 'success',
      text: [
        '最近可观测的 DSH session：',
        ...candidates.map((candidate) => (
          `- ${candidate.sessionId}　${candidate.status}　${candidate.createdAt}${candidate.cwd ? `　${candidate.cwd}` : ''}`
        )),
        '',
        '查看轨迹：/omk observe <session-id>',
      ].join('\n'),
    };
  }
  const group = await readDshObservedGroup(persistence, sessionId, invocation.signal);
  const selected = group.traces.find((trace) => trace.session.runId === sessionId);
  if (!selected) throw new Error(`DSH session 一致快照缺少目标 session：${sessionId}。`);
  const incomplete = group.traces.filter((trace) => !trace.integrity.complete);
  if (incomplete.length > 0) {
    const details = incomplete.map((trace) => {
      const integrity = trace.integrity;
      const reasons = [
        integrity.openTurnCount > 0 ? `未闭合 turn=${integrity.openTurnCount}` : '',
        integrity.openStepCount > 0 ? `未闭合 step=${integrity.openStepCount}` : '',
        integrity.unmatchedToolCallCount > 0 ? `缺失 tool result=${integrity.unmatchedToolCallCount}` : '',
        integrity.unmatchedToolResultCount > 0 ? `孤立 tool result=${integrity.unmatchedToolResultCount}` : '',
        integrity.status === 'unknown' ? '终态未知' : '',
      ].filter(Boolean).join('；');
      return `${trace.session.runId}（${reasons || '完整性检查未通过'}）`;
    }).join('；');
    throw new Error(`DSH session group 无法形成完整任务轨迹：${details}。`);
  }
  const cwd = invocation.agent.session.header.cwd ?? process.cwd();
  const observationsDir = join(cwd, '.omk', 'observe-inbox');
  const {
    buildObservationInboxReportFromTraceSessions,
    saveObservationInboxReport,
  } = await import('../observability/inbox/index.js');
  const { loadObservationReviewState } = await import('../observability/inbox/review-state.js');
  const { buildObserveDiagnosticsFromReport } = await import('../diagnosis/observe-producer.js');
  const report = buildObservationInboxReportFromTraceSessions(
    `dsh:${group.rootSessionId}`,
    group.traces.map((trace) => trace.session),
    dshTraceIngestionSummary(group),
    { reviewState: loadObservationReviewState(observationsDir) },
  );
  report.diagnostics = buildObserveDiagnosticsFromReport(report);
  const inboxPath = saveObservationInboxReport(report, observationsDir);
  const target = state.catalog.upsert(group);
  const baseUrl = await studioUrl(invocation, state);
  const trajectoryUrl = `${baseUrl}/conversations/${encodeURIComponent(target.threadId)}/tasks/${encodeURIComponent(target.turnId)}`;
  return {
    kind: 'success',
    text: [
      `已只读摄取 DSH session：${sessionId}`,
      `任务状态：${selected.integrity.status}`,
      `任务轨迹：${trajectoryUrl}`,
      `观测收件箱：${inboxPath}`,
    ].join('\n'),
  };
}

/** Register `/omk eval` and `/omk observe` in every DSH command-capable surface. */
export function apply(ctx: DshPluginContextLike): () => void {
  const observeState: DshObserveState = { catalog: createDshConversationCatalog() };
  const disposeCommand = ctx.commands.register({
    name: 'omk',
    description: '在当前 DeepSeek Harness 中运行 OMK 对照评测或查看任务轨迹',
    input: { hint: 'eval <eval.yaml> | observe [session-id]' },
    async handler(invocation) {
      const command = parseCommand(invocation.rawInput);
      if (!command) return { kind: 'error', text: USAGE };
      if (command.commandKind === 'help') return { kind: 'success', text: HELP };
      try {
        return command.commandKind === 'eval'
          ? await executeEvalCommand(ctx, invocation, command.path)
          : await executeObserveCommand(ctx, invocation, command.sessionId, observeState);
      } catch (error) {
        return {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
  return () => {
    disposeCommand();
    void observeState.server?.stop().catch(() => undefined);
  };
}

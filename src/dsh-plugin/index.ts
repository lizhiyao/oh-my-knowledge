import { dirname, join, resolve } from 'node:path';
import { computeVerdict } from '../eval-core/verdict.js';
import { configVariantsToSpecs, loadEvalConfig } from '../inputs/eval-config.js';
import { runEvaluation, runMultiple } from '../eval-workflows/run-evaluation.js';
import type { Report } from '../types/index.js';
import {
  createDshHostExecutor,
  type DshAgentLike,
  type DshHostContextLike,
} from './host-executor.js';
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

const USAGE = '用法：/omk eval <eval.yaml> 或 /omk observe [session-id]';

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

type DshCommand =
  | { commandKind: 'eval'; path: string }
  | { commandKind: 'observe'; sessionId?: string };

function parseCommand(rawInput: string): DshCommand | undefined {
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

function modelFor(agent: DshAgentLike, configured: string | undefined): string {
  const model = configured?.trim() || agent.options.model?.trim();
  if (!model) {
    throw new Error('当前 DSH session 没有可继承的模型，且 eval.yaml 未配置 model。');
  }
  return model;
}

function normalizeJudgeModels(
  configured: import('../types/index.js').JudgeConfig[] | undefined,
  model: string,
): import('../types/index.js').JudgeConfig[] {
  if (!configured || configured.length === 0) return [{ executor: 'dsh-host', model }];
  return configured.map((judge) => {
    if (judge.executor === 'dsh-host') {
      throw new Error('dsh-host 是 OMK 内部执行器标识；评委要复用当前 DSH 时，请使用 executor: dsh 或省略 judgeModels。');
    }
    return {
      ...judge,
      executor: judge.executor === 'dsh' ? 'dsh-host' : judge.executor,
    };
  });
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

  const model = modelFor(invocation.agent, config.model);
  const executor = createDshHostExecutor(ctx, {
    parentAgent: invocation.agent,
    signal: invocation.signal,
  });
  const judgeModels = normalizeJudgeModels(config.judgeModels, model);
  const currentSessionProvesConnectivity = config.model === undefined
    && ((config.noJudge ?? false) || judgeModels.every((judge) => (
      judge.executor === 'dsh-host' && judge.model === model
    )));
  const root = projectRoot(configPath);
  const outputDir = join(root, '.omk', 'reports');
  const options = {
    samplesPath: config.samples,
    skillDir: join(root, 'skills'),
    variantSpecs: configVariantsToSpecs(config.variants),
    model,
    outputDir,
    noJudge: config.noJudge ?? false,
    concurrency: config.concurrency ?? 1,
    timeoutMs: config.timeoutMs,
    noCache: config.noCache ?? false,
    executorName: 'dsh-host',
    executorOverrides: { 'dsh-host': executor },
    judgeModels,
    skipConnectivity: currentSessionProvesConnectivity,
    skipDoctor: config.skipDoctor ?? false,
    lang: 'zh' as const,
    mcpConfig: config.mcpConfig,
    bootstrap: config.bootstrap ?? true,
    bootstrapSamples: config.bootstrapSamples,
    holdoutRatio: config.holdoutRatio,
    judgeRepeat: config.judgeRepeat,
    lengthDebias: config.lengthDebias,
    budget: config.budget,
    strictBaseline: config.strictBaseline,
    noDiagnostic: config.noDiagnostic,
  };
  const result = config.repeat && config.repeat > 1
    ? await runMultiple({ ...options, repeat: config.repeat })
    : await runEvaluation(options);
  const report = result.report as Report;
  const goldMessages: string[] = [];
  if (config.goldDir) {
    const { attachGoldAgreementToReport } = await import('../grading/gold-cli.js');
    const gold = attachGoldAgreementToReport({
      report,
      goldDir: config.goldDir,
      outputDir,
      samples: config.bootstrapSamples,
    });
    if (gold.result && gold.gold) {
      const alpha = Number.isFinite(gold.result.agreement.alpha)
        ? gold.result.agreement.alpha.toFixed(3)
        : '不可计算';
      goldMessages.push(`Gold 一致性：Krippendorff α=${alpha}，N=${gold.result.agreement.sampleCount}，标注者=${gold.gold.metadata.annotator}`);
      if (gold.result.contaminationWarning) {
        goldMessages.push(`⚠ Gold 污染提示：${gold.result.contaminationWarning}`);
      }
    } else {
      goldMessages.push(`⚠ Gold 数据未加载：${gold.loadIssues.join('；') || config.goldDir}`);
    }
  }
  const verdict = computeVerdict(report);
  return {
    kind: 'success',
    text: [
      `OMK 评测完成：${verdict.level}`,
      verdict.headline,
      `报告：${report.id}`,
      ...(result.filePath ? [`文件：${result.filePath}`] : []),
      ...goldMessages,
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
  const { createReportServer } = await import('../server/report-server.js');
  state.server = createReportServer({
    port: 0,
    reportsDir: join(omkDir, 'reports'),
    analysesDir: join(omkDir, 'observe-health'),
    doctorsDir: join(omkDir, 'doctors'),
    observationsDir: join(omkDir, 'observe-inbox'),
    jobsDir: join(omkDir, 'jobs'),
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
  } = await import('../observability/inbox.js');
  const { loadObservationReviewState } = await import('../observability/review-state.js');
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

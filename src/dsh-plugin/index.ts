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

interface DshCommandInvocationLike {
  readonly agent: DshAgentLike;
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

type DshCommandResultLike =
  | Readonly<Record<'kind', 'success'> & { text?: string }>
  | Readonly<Record<'kind', 'error'> & { text: string }>;

interface DshPluginContextLike extends DshHostContextLike {
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
export const inject = ['agentPresets', 'agents', 'commands', 'systemPrompt', 'tools'];

const USAGE = '用法：/omk eval <eval.yaml>';

function commandPath(rawInput: string): string | undefined {
  const match = /^\s*eval\s+(.+?)\s*$/u.exec(rawInput);
  if (!match) return undefined;
  const value = match[1]?.trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
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

/** Register `/omk eval <eval.yaml>` in every DSH command-capable surface. */
export function apply(ctx: DshPluginContextLike): void {
  ctx.commands.register({
    name: 'omk',
    description: '在当前 DeepSeek Harness 中运行 OMK 对照评测',
    input: { hint: 'eval <eval.yaml>' },
    async handler(invocation) {
      const path = commandPath(invocation.rawInput);
      if (!path) return { kind: 'error', text: USAGE };
      try {
        return await executeEvalCommand(ctx, invocation, path);
      } catch (error) {
        return {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

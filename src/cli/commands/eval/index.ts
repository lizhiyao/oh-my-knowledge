import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { enumStringParser, integerStringParser, numberStringParser } from '../../oclif/parsers.js';
import { CliExit } from '../../lib/cli-exit.js';
import { tCli, type CliLang } from '../../lib/i18n.js';
import { parseRunConfig, type RunConfig } from '../../lib/parse-run-config.js';
import { codexModelFlagValue, codexModelHint } from '../../lib/codex-model-hint.js';
import { looksLikeModelUnavailableFailure } from '../../lib/llm-failure-classifier.js';
import type { EvalArgs, EvalFlags } from '../../lib/cmd-flags.js';
import { DEFAULT_EVALUATION_GATE_THRESHOLD as DEFAULT_GATE_THRESHOLD } from '../../../eval-workflows/evaluation-defaults.js';
import {
  hasUsableSamplesPath,
} from '../../../eval-workflows/inputs/sample-locator.js';
import { shellQuoteArg } from '../../../shared/shell-quote.js';
import { executorNamesForFamily } from '../../../executors/core/registry.js';
import { DEFAULT_EVALUATION_TIMEOUT_MS } from '../../../eval-workflows/evaluation-defaults.js';

// oclif 版 eval(默认 = run 模式) — 单次 typed parse 之后业务 inline。flag schema
// 镜像 RUN_OPTIONS + eval-runner extra = 41 flag。具体语义跟约束在 parseRunConfig 里。
//
// `omk eval gold ...` 由 src/cli/commands/eval/gold/{init,validate,compare}.ts
// 处理,oclif 文件目录路由自动接管,不进 eval.ts。

const CLAUDE_EXECUTORS = executorNamesForFamily('claude');
const CODEX_EXECUTORS = executorNamesForFamily('codex');
const OPENAI_API_EXECUTORS = executorNamesForFamily('openai-api');
const ANTHROPIC_API_EXECUTORS = executorNamesForFamily('anthropic-api');

type PreflightRuntimeMatch = {
  executor: string;
  role: 'task' | 'judge';
};

function userFacingPath(path: string): string {
  const rel = relative(process.cwd(), path);
  if (rel && rel !== '..' && !rel.startsWith(`..${sep}`)) return rel;
  return path;
}

function sampleCommandForSingleTreatment(treatment: string, skillDir: string): string | null {
  if (existsSync(treatment)) return `omk sample ${shellQuoteArg(treatment)}`;

  const dirSkillPath = join(skillDir, treatment);
  if (existsSync(join(dirSkillPath, 'SKILL.md'))) {
    return `omk sample ${shellQuoteArg(userFacingPath(dirSkillPath))}`;
  }

  const flatSkillPath = join(skillDir, `${treatment}.md`);
  if (existsSync(flatSkillPath)) {
    return `omk sample ${shellQuoteArg(userFacingPath(flatSkillPath))}`;
  }

  return null;
}

function preflightFailedTarget(message: string): string | null {
  return message.match(/(^|\n)preflight failed \[([^\]]+)\]:/)?.[2] ?? null;
}

function runtimeKey(executor: string, model: string): string {
  return `${executor}:${model}`;
}

function matchesPreflightTarget(target: string, executor: string, model: string): boolean {
  return target.includes(':') ? target === runtimeKey(executor, model) : target === model;
}

function matchingPreflightRuntimes(
  config: Pick<RunConfig, 'executorName' | 'model' | 'judgeModels' | 'noJudge'>,
  failedTarget: string,
): PreflightRuntimeMatch[] {
  const matches: PreflightRuntimeMatch[] = [];
  if (config.executorName && matchesPreflightTarget(failedTarget, config.executorName, config.model ?? '')) {
    matches.push({ executor: config.executorName, role: 'task' });
  }
  if (!config.noJudge) {
    for (const judge of config.judgeModels) {
      if (matchesPreflightTarget(failedTarget, judge.executor, judge.model)) matches.push({ executor: judge.executor, role: 'judge' });
    }
  }
  return matches;
}

function hasExecutor(matches: PreflightRuntimeMatch[], executors: ReadonlySet<string>): boolean {
  return matches.some((match) => executors.has(match.executor));
}

function configHasExecutor(
  config: Pick<RunConfig, 'executorName' | 'judgeModels' | 'noJudge'>,
  executors: ReadonlySet<string>,
): boolean {
  if (config.executorName && executors.has(config.executorName)) return true;
  return !config.noJudge && config.judgeModels.some((judge) => executors.has(judge.executor));
}

function shouldSwitchJudgeWithTask(
  config: Pick<RunConfig, 'judgeModels' | 'noJudge'>,
  executors: ReadonlySet<string>,
): boolean {
  return !config.noJudge && config.judgeModels.length === 1 && executors.has(config.judgeModels[0].executor);
}

function fallbackFlags(
  matches: PreflightRuntimeMatch[],
  executor: string,
  taskModel: string,
  judgeModel: string,
  includeJudgeWithTask: boolean,
): string {
  const hasTask = matches.some((match) => match.role === 'task');
  const hasJudge = matches.some((match) => match.role === 'judge') || (hasTask && includeJudgeWithTask);
  return [
    hasTask ? `--executor ${executor} --model ${taskModel}` : '',
    hasJudge ? `--judge-models ${executor}:${judgeModel}` : '',
  ].filter(Boolean).join(' ');
}

export function formatConnectivityFailureHint(
  message: string,
  config: Pick<RunConfig, 'executorName' | 'model' | 'judgeModels' | 'noJudge'>,
  lang: CliLang,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const failedTarget = preflightFailedTarget(message);
  if (failedTarget) {
    const matches = matchingPreflightRuntimes(config, failedTarget);
    if (matches.length === 0) return '';

    if (hasExecutor(matches, CLAUDE_EXECUTORS)) {
      const codexModel = codexModelFlagValue(env);
      return tCli('cli.run.codex_fallback_hint', lang, {
        flags: fallbackFlags(matches, 'codex', codexModel, codexModel, shouldSwitchJudgeWithTask(config, CLAUDE_EXECUTORS)),
        codexModelHint: codexModelHint(lang, env),
      });
    }
    if (hasExecutor(matches, CODEX_EXECUTORS)) {
      if (looksLikeModelUnavailableFailure(message)) {
        const codexModel = codexModelFlagValue(env);
        return tCli('cli.run.codex_model_hint', lang, {
          codexFlags: fallbackFlags(matches, 'codex', codexModel, codexModel, shouldSwitchJudgeWithTask(config, CODEX_EXECUTORS)),
          codexExec: `codex exec -m ${codexModel} "hi"`,
          claudeFlags: fallbackFlags(matches, 'claude', 'sonnet', 'haiku', shouldSwitchJudgeWithTask(config, CODEX_EXECUTORS)),
          openaiFlags: fallbackFlags(matches, 'openai-api', '<openai-model>', '<openai-model>', shouldSwitchJudgeWithTask(config, CODEX_EXECUTORS)),
          codexModelHint: codexModelHint(lang, env),
        });
      }
      return tCli('cli.run.codex_auth_hint', lang, {
        claudeFlags: fallbackFlags(matches, 'claude', 'sonnet', 'haiku', shouldSwitchJudgeWithTask(config, CODEX_EXECUTORS)),
        openaiFlags: fallbackFlags(matches, 'openai-api', '<openai-model>', '<openai-model>', shouldSwitchJudgeWithTask(config, CODEX_EXECUTORS)),
      });
    }
    if (hasExecutor(matches, OPENAI_API_EXECUTORS)) {
      return tCli(looksLikeModelUnavailableFailure(message) ? 'cli.run.openai_api_model_hint' : 'cli.run.openai_api_auth_hint', lang);
    }
    if (hasExecutor(matches, ANTHROPIC_API_EXECUTORS)) {
      return tCli(looksLikeModelUnavailableFailure(message) ? 'cli.run.anthropic_api_model_hint' : 'cli.run.anthropic_api_auth_hint', lang);
    }
    return '';
  }

  if (message.includes('OPENAI_API_KEY') && configHasExecutor(config, OPENAI_API_EXECUTORS)) return tCli('cli.run.openai_api_auth_hint', lang);
  if (message.includes('ANTHROPIC_API_KEY') && configHasExecutor(config, ANTHROPIC_API_EXECUTORS)) return tCli('cli.run.anthropic_api_auth_hint', lang);
  return '';
}

async function runEval(
  _args: EvalArgs,
  flags: EvalFlags,
  lang: CliLang,
): Promise<void> {
  const { values, config, evalConfig } = parseRunConfig(
    { ...flags } as Record<string, unknown>,
    { lang },
  );

  if (!values.batch && !hasUsableSamplesPath(config.samplesPath)) {
    const treatmentRaw = typeof values.treatment === 'string' ? values.treatment : '';
    const treatments = treatmentRaw.split(',').map((v) => v.trim()).filter(Boolean);
    const sampleCommand = !values.samples && !evalConfig?.samples && treatments.length === 1
      ? sampleCommandForSingleTreatment(treatments[0], config.skillDir)
      : null;
    const missingSamplesMessage = [
      tCli('cli.common.samples_not_found', lang, { path: config.samplesPath }),
      sampleCommand ? tCli('cli.common.samples_not_found_hint', lang, { command: sampleCommand }) : '',
    ].filter(Boolean).join('\n');
    console.error(tCli('cli.common.error_prefix', lang, {
      message: missingSamplesMessage,
    }));
    throw new CliExit(1);
  }

  try {
    const { runCoreEvaluationCommand } = await import('../../lib/run-core-evaluation.js');
    const result = await runCoreEvaluationCommand({
      flags: { ...flags },
      config,
      evalConfig,
      lang,
    });
    if (!process.stdout.isTTY || result.output && typeof result.output === 'object'
        && (result.output as { projectionKind?: string }).projectionKind === 'core-cli-dry-run') {
      console.log(JSON.stringify(result.output, null, 2));
    } else {
      const outcome = result.output as {
        status?: { runStatus?: string; evidenceStatus?: string; conclusionStatus?: string };
        gate?: { gateStatus?: string; reasonCodes?: readonly string[] };
      };
      process.stdout.write(
        `Core: ${outcome.status?.runStatus ?? 'prepared'}／${outcome.status?.evidenceStatus ?? 'n/a'}／${outcome.status?.conclusionStatus ?? 'n/a'}\n`
        + `Gate: ${outcome.gate?.gateStatus ?? 'not-applicable'}${outcome.gate?.reasonCodes?.length ? `（${outcome.gate.reasonCodes.join(', ')}）` : ''}\n`,
      );
    }
    throw new CliExit(result.exitCode);
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(tCli('cli.common.error_prefix', lang, {
      message: `${message}${formatConnectivityFailureHint(message, config, lang)}`,
    }));
    throw new CliExit(1);
  }
}

export default class Eval extends BaseCommand {
  static description = bilingual({
    zh: '跑评测：对一个 control vs 多个 treatment skill 做对照试验，产 verdict 报告。',
    en: 'Run evaluation: control vs treatment(s) comparison, produce verdict report.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '最简对照:baseline vs my-skill',
        en: 'Minimal A/B: baseline vs my-skill',
      }),
      command: '<%= config.bin %> eval --control baseline --treatment my-skill',
    },
    {
      description: bilingual({
        zh: 'eval.yaml 驱动 + bootstrap CI',
        en: 'eval.yaml driven + bootstrap CI',
      }),
      command: '<%= config.bin %> eval --config eval.yaml --bootstrap',
    },
  ];

  static flags = {
    lang: LANG_FLAG,
    // ── 实验角色 ──
    control: Flags.string({
      description: bilingual({ zh: 'control variant 表达式（仅 artifact 身份）', en: 'Control variant expr (artifact identity only)' }),
    }),
    treatment: Flags.string({
      description: bilingual({
        zh: 'treatment variant 列表，逗号分隔（仅 artifact 身份）',
        en: 'Treatment variants, comma-separated (artifact identity only)',
      }),
    }),
    'control-cwd': Flags.string({
      description: bilingual({
        zh: 'control 的 runtime context 目录',
        en: 'Runtime context dir for control',
      }),
    }),
    'treatment-cwd': Flags.string({
      description: bilingual({
        zh: 'treatment 的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）',
        en: 'Runtime context dirs for treatments, comma-separated, index-aligned with --treatment (blank = none)',
      }),
    }),
    config: Flags.string({
      description: bilingual({ zh: 'eval.yaml 路径', en: 'eval.yaml path' }),
    }),
    samples: Flags.string({
      description: bilingual({
        zh: '用例路径。自动发现项目级或单 treatment 目录 skill 下的 eval-samples.json / eval-samples.yaml；显式路径可为 JSON / YAML 文件或分片目录。',
        en: 'Samples path. Auto-discovers eval-samples.json / eval-samples.yaml at project scope or for a single directory-skill treatment; an explicit path may be a JSON / YAML file or split directory.',
      }),
    }),
    'skill-dir': Flags.string({
      description: bilingual({ zh: 'skill 目录，默认 skills', en: 'Skill dir, default skills' }),
    }),
    // ── 模型 / 执行器 ──
    model: Flags.string({
      description: bilingual({ zh: '被测模型', en: 'Evaluated model' }),
    }),
    executor: Flags.string({
      description: bilingual({
        zh: '执行器：claude / claude-sdk / codex / codex-sdk / anthropic-api / openai-api / 自定义命令。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。',
        en: 'Executor: claude / claude-sdk / codex / codex-sdk / anthropic-api / openai-api / custom. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.',
      }),
    }),
    'judge-models': Flags.string({
      description: bilingual({
        zh: '评委配置，格式 executor:model[,...]，例 claude:haiku 或 codex:<model>（≥ 2 个 = ensemble）。默认跟随所选执行器；Codex 沿用被测模型。',
        en: 'Judge config: executor:model[,...], e.g. claude:haiku or codex:<model> (≥ 2 = ensemble). Defaults to the selected executor; Codex reuses the evaluated model.',
      }),
    }),
    'output-dir': Flags.string({
      description: bilingual({ zh: '报告输出目录（默认项目级 .omk/eval）', en: 'Report output dir (default project .omk/eval)' }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '报告写全局 ~/.oh-my-knowledge/eval，而非项目 .omk/eval',
        en: 'Write report to global ~/.oh-my-knowledge/eval instead of project .omk/eval',
      }),
    }),
    // ── 评测 toggle ──
    'no-judge': Flags.boolean({
      description: bilingual({ zh: '跳过 LLM judge', en: 'Skip LLM judge' }),
    }),
    'no-cache': Flags.boolean({
      description: bilingual({ zh: '跳过 executor cache', en: 'Skip executor cache' }),
    }),
    'dry-run': Flags.boolean({
      description: bilingual({ zh: '只 plan 不实跑', en: 'Plan only, no real exec' }),
    }),
    concurrency: Flags.string({
      description: bilingual({ zh: '并发数，默认 1', en: 'Concurrency, default 1' }),
      parse: integerStringParser('--concurrency', { min: 1 }),
    }),
    timeout: Flags.string({
      description: bilingual({
        zh: `单用例超时秒，默认 ${DEFAULT_EVALUATION_TIMEOUT_MS / 1000}`,
        en: `Per-sample timeout sec, default ${DEFAULT_EVALUATION_TIMEOUT_MS / 1000}`,
      }),
      parse: numberStringParser('--timeout', { min: 1 }),
    }),
    batch: Flags.boolean({
      description: bilingual({
        zh: 'batch 模式:baseline vs 每个 skill',
        en: 'Batch mode: baseline vs each skill',
      }),
    }),
    'skip-connectivity': Flags.boolean({
      description: bilingual({ zh: '跳 LLM 连通性预检', en: 'Skip LLM connectivity preflight' }),
    }),
    'skip-doctor': Flags.boolean({
      description: bilingual({
        zh: 'escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。',
        en: 'Escape hatch: skip the doctor health-check gate (on by default). Use when sandbox mocks supply deps; caller owns garbage-in risk.',
      }),
    }),
    'mcp-config': Flags.string({
      description: bilingual({ zh: 'MCP 配置文件路径', en: 'MCP config path' }),
    }),
    'no-serve': Flags.boolean({
      description: bilingual({ zh: '不启 report server', en: 'Do not start report server' }),
    }),
    verbose: Flags.boolean({
      description: bilingual({ zh: '详细日志', en: 'Verbose logging' }),
    }),
    retry: Flags.string({
      description: bilingual({ zh: '失败 sample 重试次数', en: 'Per-sample retry count' }),
      parse: integerStringParser('--retry', { min: 0 }),
    }),
    resume: Flags.string({
      description: bilingual({
        zh: '复用经过完整契约校验的 Core runId；拒绝时失败关闭',
        en: 'Reuse a fully verified Core runId; fail closed when rejected',
      }),
    }),
    'layered-stats': Flags.boolean({
      description: bilingual({ zh: '输出分层统计', en: 'Emit layered stats' }),
    }),
    'strict-baseline': Flags.boolean({
      description: bilingual({ zh: '强制 baseline 隔离（default true）', en: 'Force baseline isolation (default true)' }),
    }),
    'no-strict-baseline': Flags.boolean({
      description: bilingual({ zh: '关闭 baseline 隔离', en: 'Disable baseline isolation' }),
    }),
    effort: Flags.string({
      description: bilingual({
        zh: '被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。',
        en: 'Executor LLM reasoning effort low/medium/high/xhigh/max (default low; reports across efforts not strictly comparable).',
      }),
      parse: enumStringParser('--effort', ['low', 'medium', 'high', 'xhigh', 'max']),
    }),
    'no-diagnostic': Flags.boolean({
      description: bilingual({
        zh: '关闭基于 Core 失败、缺失、排除与稳定 reason code 的诊断投影。',
        en: 'Disable the diagnostic projection over Core failures, missing evidence, exclusions, and stable reason codes.',
      }),
    }),
    // ── eval-runner extra ──
    repeat: Flags.string({
      description: bilingual({ zh: '每个 sample 重复跑 N 次', en: 'Repeat each sample N times' }),
      parse: integerStringParser('--repeat', { min: 1 }),
    }),
    'holdout-ratio': Flags.string({
      description: bilingual({
        zh: '留出比例 0-1（如 0.3）；切出 holdout 子集，对比 train/holdout 综合分检测过拟合',
        en: 'Holdout fraction 0-1 (e.g. 0.3); splits a holdout subset, compares train/holdout composite to flag overfitting',
      }),
      parse: numberStringParser('--holdout-ratio', { min: 0, max: 1 }),
    }),
    'judge-repeat': Flags.string({
      description: bilingual({ zh: '每个 dim 评 N 次', en: 'Judge each dim N times' }),
      parse: integerStringParser('--judge-repeat', { min: 1 }),
    }),
    bootstrap: Flags.boolean({
      description: bilingual({ zh: '加 bootstrap CI', en: 'Add bootstrap CI' }),
    }),
    'bootstrap-samples': Flags.string({
      description: bilingual({ zh: 'bootstrap 重采样次数，默认 1000', en: 'Bootstrap resamples, default 1000' }),
      parse: integerStringParser('--bootstrap-samples', { min: 100 }),
    }),
    'gold-dir': Flags.string({
      description: bilingual({ zh: 'gold dataset 目录', en: 'Gold dataset dir' }),
    }),
    'no-debias-length': Flags.boolean({
      description: bilingual({ zh: '关 length-debias（默认开）', en: 'Disable length-debias (default on)' }),
    }),
    'budget-usd': Flags.string({
      description: bilingual({ zh: '总预算上限 USD（必须 > 0，不传则无上限）', en: 'Total budget cap USD (must be > 0; omit for no cap)' }),
      parse: numberStringParser('--budget-usd', { minExclusive: 0 }),
    }),
    'budget-per-sample-usd': Flags.string({
      description: bilingual({ zh: '单 sample 预算上限 USD（必须 > 0，不传则无上限）', en: 'Per-sample budget cap USD (must be > 0; omit for no cap)' }),
      parse: numberStringParser('--budget-per-sample-usd', { minExclusive: 0 }),
    }),
    'budget-per-sample-ms': Flags.string({
      description: bilingual({ zh: '单 sample 时长上限 ms（必须 > 0，不传则无上限）', en: 'Per-sample time cap ms (must be > 0; omit for no cap)' }),
      parse: integerStringParser('--budget-per-sample-ms', { min: 1 }),
    }),
    threshold: Flags.string({
      description: bilingual({
        zh: `verdict 阈值，默认 ${DEFAULT_GATE_THRESHOLD}`,
        en: `Verdict threshold, default ${DEFAULT_GATE_THRESHOLD}`,
      }),
      parse: numberStringParser('--threshold'),
    }),
    'trivial-diff': Flags.string({
      description: bilingual({ zh: '可忽略 diff 容差，0 表示不启用容差', en: 'Trivial diff tolerance; 0 disables tolerance' }),
      parse: numberStringParser('--trivial-diff', { min: 0 }),
    }),
    'report-only': Flags.boolean({
      description: bilingual({
        zh: '生成报告并打印 verdict，但始终 exit 0(不参与 CI gate）。',
        en: 'Produce the report and print verdict, but always exit 0 (no CI gate).',
      }),
    }),
    'no-gate': Flags.boolean({
      description: bilingual({ zh: '关 verdict gate', en: 'Disable verdict gate' }),
    }),
    'no-evidence': Flags.boolean({
      description: bilingual({
        zh: '不把本次评测写成证据追加进受管记录(默认会为已 install 的 skill 自动写)。',
        en: 'Do not append this run as evidence to managed records (auto-written for installed skills by default).',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Eval);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      await runEval(args as Record<string, never>, { ...flags, lang }, lang);
    });
  }
}

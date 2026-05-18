import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../i18n.js';
import { CliExit } from '../../cli-exit.js';
import { tCli, type CliLang } from '../../i18n.js';
import { makeOnProgress } from '../../progress.js';
import type { EvolveArgs, EvolveFlags } from '../../types/cmd-flags.js';
import type { ProgressCallback } from '../../../types/index.js';

interface RoundProgressInfo {
  round: number;
  totalRounds: number;
  phase: string;
  score?: number;
  delta?: number;
  accepted?: boolean;
  costUSD?: number;
  costReported?: boolean;
  error?: string;
}

interface TrajectoryEntry {
  round: number;
  score: number;
  delta: number;
  accepted: boolean;
  costUSD: number;
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function validateEvolveEffort(raw: string, lang: 'zh' | 'en'): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (!VALID_EFFORTS.has(raw)) {
    const msg = lang === 'zh'
      ? `--effort 必须是 low / medium / high / xhigh / max 之一(实际:"${raw}")`
      : `--effort must be one of low/medium/high/xhigh/max (got "${raw}")`;
    console.error(msg);
    throw new CliExit(2);
  }
  return raw as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

interface EvolveResult {
  startScore: number;
  finalScore: number;
  bestRound: number;
  totalRounds: number;
  totalCostUSD: number;
  costReported?: boolean;
  trajectory: TrajectoryEntry[];
  bestSkillPath: string;
  allVersions: string[];
  reportId?: string;
}

// runEvolve module-level helper:cli-exit.test 测「skillPath 空 throw CliExit(1)」走
// in-process import 验证业务,Command.run() body 直接调它。业务住 oclif Command file 内,
// 不再有独立 src/cli/commands/。
export async function runEvolve(
  args: EvolveArgs,
  flags: EvolveFlags,
  lang: CliLang,
): Promise<void> {
  const skillPath: string = args.skillPath;
  if (!skillPath) {
    console.error(tCli('cli.evolve.specify_skill_path', lang));
    throw new CliExit(1);
  }

  let samplesFile: string = flags.samples ?? 'eval-samples.json';
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const { evolveSkill } = await import('../../../authoring/evolver.js');
  const { parseJudgeModelsArgOrExit } = await import('../../parse-run-config.js');

  const evolveJudges = parseJudgeModelsArgOrExit(flags['judge-models']);
  if (evolveJudges.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'omk evolve' }));
    throw new CliExit(2);
  }

  process.stderr.write(tCli('cli.evolve.section_header', lang, { path: skillPath }));

  try {
    const result: EvolveResult = await evolveSkill({
      skillPath: resolve(skillPath),
      samplesPath: resolve(samplesFile),
      rounds: Math.max(1, Number(flags.rounds) || 5),
      target: flags.target ? Number(flags.target) : null,
      model: flags.model,
      judgeModels: evolveJudges,
      improveModel: flags['improve-model'],
      executorName: flags.executor,
      concurrency: Math.max(1, Number(flags.concurrency) || 1),
      timeoutMs: Math.max(1, Number(flags.timeout) || 120) * 1000,
      skipConnectivity: flags['skip-connectivity'],
      effort: flags.effort ? validateEvolveEffort(flags.effort, lang) : undefined,
      noDiagnostic: flags['no-diagnostic'],
      skipDoctor: flags['skip-doctor'],
      onProgress: makeOnProgress(lang) as unknown as ProgressCallback,
      onRoundProgress({ round, totalRounds: _totalRounds, phase, score, delta, accepted, costUSD, costReported, error }: RoundProgressInfo): void {
        // costReported=false 时显示「—」而不是 $0.0000(executor 不报 cost,如 codex)。
        const fmtRoundCost = (c: number, r: boolean): string => r ? `$${c.toFixed(4)}` : '—';
        if (phase === 'baseline') {
          process.stderr.write(tCli('cli.evolve.round_baseline', lang, {
            score: score!.toFixed(2), cost: fmtRoundCost(costUSD!, costReported !== false),
          }));
        } else if (phase === 'error') {
          process.stderr.write(tCli('cli.evolve.round_error', lang, {
            round, error: String(error ?? ''),
          }));
        } else if (phase === 'done') {
          const delta_: string = delta! >= 0 ? `+${delta!.toFixed(2)}` : delta!.toFixed(2);
          const status: string = accepted ? '✓ ACCEPT' : '✗ REJECT';
          process.stderr.write(tCli('cli.evolve.round_done', lang, {
            round, score: score!.toFixed(2), delta: delta_, status, cost: fmtRoundCost(costUSD!, costReported !== false),
          }));
        }
      },
    });

    const improvement: string = result.startScore > 0
      ? ((result.finalScore - result.startScore) / result.startScore * 100).toFixed(1)
      : '0';
    const totalCostStr = result.costReported === false
      ? '—'
      : `$${result.totalCostUSD.toFixed(4)}`;
    process.stderr.write(tCli('cli.evolve.summary', lang, {
      start: result.startScore.toFixed(2), final: result.finalScore.toFixed(2),
      percent: improvement, rounds: result.totalRounds, cost: totalCostStr,
    }));
    process.stderr.write(tCli('cli.evolve.best_path', lang, {
      best: result.bestSkillPath, target: resolve(skillPath),
    }));
    process.stderr.write(tCli('cli.evolve.versions_saved', lang, {
      dir: join(resolve(skillPath, '..'), 'evolve'),
    }));
    if (result.reportId) {
      process.stderr.write(tCli('cli.evolve.report_link', lang, { id: result.reportId }));
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
    console.error(tCli('cli.common.error_prefix', lang, { message: (err as Error).message }));
    throw new CliExit(1);
  }
}

export default class Evolve extends Command {
  static description = bilingual({
    zh: '自动迭代改进 skill:多轮 eval + skill 重写，直到达到 --target 或耗尽 --rounds。',
    en: 'Auto-iterate skill improvement: multi-round eval + rewrite until --target or --rounds exhausted.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '默认 5 轮迭代',
        en: 'Default 5 rounds',
      }),
      command: '<%= config.bin %> evolve skills/my-skill/SKILL.md',
    },
    {
      description: bilingual({
        zh: '指定目标分 + 自定义模型',
        en: 'Target score + custom model',
      }),
      command: '<%= config.bin %> evolve skills/my-skill/SKILL.md --target 4.5 --model opus --improve-model opus',
    },
  ];

  static args = {
    skillPath: Args.string({
      description: bilingual({
        zh: 'skill 文件或 SKILL.md 路径。',
        en: 'Skill file or SKILL.md path.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    rounds: Flags.string({
      description: bilingual({ zh: '最大迭代轮数，默认 5', en: 'Max iteration rounds, default 5' }),
      default: '5',
    }),
    target: Flags.string({
      description: bilingual({
        zh: '目标 composite 分数，达到即停。不传则跑满 rounds',
        en: 'Target composite score; stop when reached. If omitted, runs all rounds.',
      }),
    }),
    samples: Flags.string({
      description: bilingual({
        zh: '样本文件路径，默认 eval-samples.json',
        en: 'Samples file, default eval-samples.json',
      }),
      default: 'eval-samples.json',
    }),
    model: Flags.string({
      description: bilingual({
        zh: '被评测的 LLM，默认 sonnet',
        en: 'Evaluated LLM, default sonnet',
      }),
      default: 'sonnet',
    }),
    'judge-models': Flags.string({
      description: bilingual({
        zh: '评委 model（单评委约束），格式 executor:model。默认 claude:haiku',
        en: 'Judge model (single judge required), executor:model format. Default claude:haiku',
      }),
      default: 'claude:haiku',
    }),
    'improve-model': Flags.string({
      description: bilingual({
        zh: '负责重写 skill 的 LLM，默认 sonnet',
        en: 'LLM that rewrites the skill, default sonnet',
      }),
      default: 'sonnet',
    }),
    concurrency: Flags.string({
      description: bilingual({ zh: '评测并发数，默认 1', en: 'Eval concurrency, default 1' }),
      default: '1',
    }),
    timeout: Flags.string({
      description: bilingual({ zh: '单样本超时秒，默认 120', en: 'Per-sample timeout sec, default 120' }),
      default: '120',
    }),
    executor: Flags.string({
      description: bilingual({ zh: '执行器名，默认 claude', en: 'Executor name, default claude' }),
      default: 'claude',
    }),
    'skip-connectivity': Flags.boolean({
      description: bilingual({
        zh: '跳过 LLM 连通性预检',
        en: 'Skip LLM connectivity preflight',
      }),
      default: false,
    }),
    effort: Flags.string({
      description: bilingual({
        zh: 'reasoning effort: low/medium/high/xhigh/max',
        en: 'Reasoning effort: low/medium/high/xhigh/max',
      }),
    }),
    'no-diagnostic': Flags.boolean({
      description: bilingual({
        zh: '关 LLM diagnostic 调用',
        en: 'Disable diagnostic LLM call',
      }),
      default: false,
    }),
    'skip-doctor': Flags.boolean({
      description: bilingual({
        zh: '跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）',
        en: 'Skip doctor gate (escape hatch; user takes garbage-in risk)',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Evolve);
    const lang = resolveLang(process.argv);
    try {
      await runEvolve(args, { ...flags, lang }, lang);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
        return;
      }
      throw err;
    }
  }
}

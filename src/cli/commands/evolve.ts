import { resolve, join, dirname } from 'node:path';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { enumStringParser, integerStringParser, nonEmptyStringParser, numberStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { formatSampleGenerationFailureHint } from '../lib/generation-failure-hint.js';
import { ensureSkillSamples, SamplePreparationError } from '../../knowledge-artifacts/authoring/sample-generation.js';
import type { CommandFlags } from '../lib/cmd-flags.js';
import type {
  CoreEvolveOutcomeInput,
  EvolveOutcomeResult,
} from '../../knowledge-artifacts/governance/evolve-outcome.js';
import { sanitizeCell } from '../lib/cell-format.js';
import { envJudgeModels, resolveRuntimeSelection } from '../lib/runtime-defaults.js';

/** Feedback failures remain non-fatal, but are distinct from an unmanaged/no-change result. */
type EvolveFeedback =
  | { status: 'recorded'; value: EvolveOutcomeResult }
  | { status: 'not-applicable' }
  | { status: 'failed'; error: unknown };

async function recordEvolveOutcomeSafely(input: CoreEvolveOutcomeInput): Promise<EvolveFeedback> {
  try {
    const { recordCoreEvolveOutcome } = await import('../../knowledge-artifacts/governance/evolve-outcome.js');
    const value = recordCoreEvolveOutcome(input);
    return value ? { status: 'recorded', value } : { status: 'not-applicable' };
  } catch (error) {
    return { status: 'failed', error };
  }
}

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
  decisionAccepted?: boolean;
}

interface TrajectoryEntry {
  round: number;
  score: number;
  delta: number;
  accepted: boolean;
  costUSD: number;
  editRatio?: number;
  rejectedPreEval?: boolean;
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
  runId?: string;
  evidence?: import('../../eval-workflows/artifact-store/index.js').StoredCoreRunArtifacts;
}

export async function runEvolve(
  args: EvolveArgs,
  flags: EvolveFlags,
  lang: CliLang,
  signal?: AbortSignal,
): Promise<void> {
  const skillPathArg: string = args.skillPath;
  if (!skillPathArg.trim()) {
    console.error(tCli('cli.evolve.specify_skill_path', lang));
    throw new CliExit(2);
  }

  const { resolveSkillInput } = await import('../lib/resolve-skill-input.js');
  let resolvedInput;
  try { resolvedInput = resolveSkillInput(skillPathArg, lang, { samples: flags.samples, projectFallback: true }); } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    throw new CliExit(1);
  }
  const skillPath = resolvedInput.skillPath;
  // evolve 目标的形态(目录-skill / 文件-skill),供受管联动按形态精确匹配记录。**取解析后形态**而非「入参是不是
  // 目录」:帮助文档鼓励传 `skills/foo/SKILL.md`,若按入参判会得 false、匹配不到 install 落的目录记录(漂移永不消)。
  const skillIsDir = resolvedInput.isDirectorySkill;

  const samplesFile = resolvedInput.samplesPath;

  // 参数校验必须早于任何昂贵副作用(自动生成用例 / LLM 调用)。
  const { parseJudgeModelsArgOrExit } = await import('../lib/parse-run-config/judge-models.js');
  const evolveJudges = parseJudgeModelsArgOrExit(flags['judge-models']);
  if (evolveJudges.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'omk evolve' }));
    throw new CliExit(2);
  }

  const samplesAbs = resolve(samplesFile);
  process.stderr.write(lang === 'zh' ? `样本源：${samplesAbs}\n` : `Sample source: ${samplesAbs}\n`);
  try {
    const result = await ensureSkillSamples({
      skillPath: resolve(skillPath), samplesPath: samplesAbs, explicit: flags.samples !== undefined,
      options: { signal, model: flags.model, executorName: flags.executor },
      onGenerating: (outFile) => process.stderr.write(lang === 'zh'
        ? `未发现评测用例，正在自动生成到 ${outFile} …\n`
        : `No samples found; auto-generating to ${outFile} …\n`),
    });
    if (result.status === 'generated') {
      const cost = result.costUSD > 0 ? ` $${result.costUSD.toFixed(4)}` : '';
      process.stderr.write(lang === 'zh'
        ? `已生成 ${result.added} 条用例${cost}，开始自迭代。\n`
        : `Generated ${result.added} samples${cost}; starting evolution.\n`);
    }
  } catch (err) {
    if (err instanceof SamplePreparationError) {
      const reason = err.cause instanceof Error ? err.cause.message : String(err.cause ?? '');
      const messages = {
        missing: lang === 'zh'
          ? `指定的样本源不存在：${samplesAbs}。请先准备样本；省略 --samples 才会自动发现或生成。`
          : `Explicit sample source does not exist: ${samplesAbs}. Prepare it first; omit --samples for discovery or generation.`,
        invalid: lang === 'zh'
          ? `评测用例文件解析失败，evolve 不会覆盖它，请先修复：${samplesAbs}\n  原因：${reason}`
          : `Failed to parse the samples source; evolve will not overwrite it. Fix it first: ${samplesAbs}\n  reason: ${reason}`,
        empty: lang === 'zh'
          ? `指定的样本源为空：${samplesAbs}。请先准备样本；evolve 不会替换显式指定的样本。`
          : `Explicit sample source is empty: ${samplesAbs}. Prepare samples first; evolve will not replace an explicit source.`,
        'generated-empty': lang === 'zh'
          ? '自动生成返回 0 条用例，已中止。请用 `omk sample <skill> --focus "…"` 引导生成，或手写后重试。'
          : 'Auto-generation produced 0 samples; aborting. Use `omk sample <skill> --focus "…"` to guide generation, or write samples manually.',
        exists: err.message,
      };
      console.error(messages[err.reason]);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(tCli('cli.common.error_prefix', lang, {
        message: `${message}${formatSampleGenerationFailureHint(message, flags.executor, lang)}`,
      }));
    }
    throw new CliExit(1);
  }

  const { evolveSkillCore } = await import('../../knowledge-artifacts/authoring/core-evolver.js');
  const { runCoreEvaluationCommand } = await import('../lib/run-core-evaluation.js');
  const { prepareCliEvaluation } = await import('../lib/prepare-evaluation.js');
  const evolveEffort = flags.effort ? validateEvolveEffort(flags.effort, lang) : undefined;
  const { createEvolutionEvaluator } = await import('../../eval-workflows/hosts/composition/evolution-evaluation.js');
  const prepared = prepareCliEvaluation({
    control: 'baseline',
    treatment: skillPath,
    samples: resolve(samplesFile),
    'skill-dir': dirname(resolve(skillPath)),
    executor: flags.executor,
    model: flags.model,
    'judge-models': evolveJudges.map((judge) => `${judge.executor}:${judge.model}`).join(','),
    concurrency: Math.max(1, Number(flags.concurrency) || 1),
    timeout: Math.max(1, Math.ceil(Number(flags.timeout) || 600)),
    effort: evolveEffort,
    'skip-doctor': flags['skip-doctor'],
    'no-evidence': true,
    'no-serve': true,
    'report-only': true,
  }, { lang });
  const evaluatePair = createEvolutionEvaluator(prepared.parseInput, async (request) => {
    const evaluation = await runCoreEvaluationCommand({ signal, prepared: { ...prepared, request } });
    return evaluation.stored;
  });

  process.stderr.write(tCli('cli.evolve.section_header', lang, { path: skillPath }));

  try {
    const result: EvolveResult = await evolveSkillCore({
      signal,
      skillPath: resolve(skillPath),
      isDirectorySkill: skillIsDir,
      rounds: Math.max(1, Number(flags.rounds) || 5),
      target: flags.target ? Number(flags.target) : null,
      model: flags.model,
      improveModel: flags['improve-model'],
      executorName: flags.executor,
      timeoutMs: Math.max(1, Number(flags.timeout) || 600) * 1000,
      effort: evolveEffort,
      evaluatePair,
      editBudget: flags['no-edit-budget'] ? 0 : Number(flags['edit-budget']),
      rejectMemory: !flags['no-reject-memory'],
      // --snapshot-only:不写回 source,候选只留在 evolve/<skillName>.r{N}.md(供人工挑选 / promote)。
      writeBackToSource: !flags['snapshot-only'],
      improveMode: flags['improve-mode'] === 'rewrite' ? 'rewrite' : 'agent',
      onRoundProgress({ round, totalRounds: _totalRounds, phase, score, delta, accepted, costUSD, costReported, error, decisionAccepted }: RoundProgressInfo): void {
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
          const rejectNote = !accepted && decisionAccepted === false ? tCli('cli.evolve.reject_core_decision', lang) : '';
          const status: string = accepted ? '✓ ACCEPT' : `✗ REJECT${rejectNote}`;
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
    if (result.runId) {
      process.stderr.write(tCli('cli.evolve.report_link', lang, { id: result.runId }));
    }

    if (flags['snapshot-only']) {
      // 不写回 source —— 候选留在 evolve/ 供人工挑选;受管记录不动。
      process.stderr.write(tCli('cli.evolve.snapshot_only_hint', lang, {
        dir: join(resolve(skillPath, '..'), 'evolve'),
      }));
    } else {
      // 受管 skill:把胜出版本记成带 verdict 的证据 + re-baseline → omk list 显 measurable。
      // 升 promoted 仍由人 omk promote 决定(统计门 ≠ 人的接受)。未纳管 / 无改进 → 静默 no-op。
      const recorded = await recordEvolveOutcomeSafely({
        source: result.evidence!,
        bestRound: result.bestRound,
        skillPath: resolvedInput.skillPath,
        skillDir: resolvedInput.skillDir,
        isDirectorySkill: skillIsDir,
      });
      if (recorded.status === 'failed') {
        const message = sanitizeCell(recorded.error instanceof Error ? recorded.error.message : String(recorded.error));
        process.stderr.write(lang === 'zh'
          ? `治理证据写入失败：${message}。评测产物已保留，请检查受管目录后补记证据。\n`
          : `Managed evidence write failed: ${message}. Evaluation artifacts are preserved; check the managed directory and record the evidence again.\n`);
      }
      if (recorded.status === 'recorded') {
        process.stderr.write(tCli('cli.evolve.evidence_recorded_managed', lang, {
          name: recorded.value.name, verdict: recorded.value.verdict,
        }));
      }
    }

    const publicResult: Omit<EvolveResult, 'evidence'> = { ...result };
    delete (publicResult as Partial<EvolveResult>).evidence;
    console.log(JSON.stringify(publicResult, null, 2));
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
    console.error(tCli('cli.common.error_prefix', lang, {
      message: err instanceof Error ? err.message : String(err),
    }));
    throw new CliExit(1);
  }
}

export default class Evolve extends BaseCommand {
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
      parse: nonEmptyStringParser('skillPath'),
      description: bilingual({
        zh: 'skill 文件或 SKILL.md 路径。',
        en: 'Skill file or SKILL.md path.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    rounds: Flags.string({
      description: bilingual({ zh: '最大迭代轮数，默认 5', en: 'Max iteration rounds, default 5' }),
      default: '5',
      parse: integerStringParser('--rounds', { min: 1 }),
    }),
    target: Flags.string({
      description: bilingual({
        zh: '目标 composite 分数，达到即停。不传则跑满 rounds',
        en: 'Target composite score; stop when reached. If omitted, runs all rounds.',
      }),
      parse: numberStringParser('--target', { min: 0, max: 5 }),
    }),
    samples: Flags.string({
      parse: nonEmptyStringParser('--samples'),
      description: bilingual({
        zh: '指定已有样本源；省略时先找 skill 私有样本，再找项目样本，都不存在时自动生成',
        en: 'Existing sample source; otherwise discover skill-local then project samples, generating only when neither exists',
      }),
    }),
    model: Flags.string({
      parse: nonEmptyStringParser('--model'),
      description: bilingual({
        zh: '被评测的 LLM。Codex 自动读取本机配置；无用例时也用作自动生成用例的出题模型。',
        en: 'Evaluated LLM. Codex reads the local configured model. Also used to generate samples when none exist.',
      }),
    }),
    'judge-models': Flags.string({
      description: bilingual({
        zh: '评委 model（单评委约束），格式 executor:model。默认跟随所选执行器；Codex 沿用被测模型。',
        en: 'Judge model (single judge required), executor:model format. Defaults to the selected executor; Codex reuses the evaluated model.',
      }),
    }),
    'improve-model': Flags.string({
      parse: nonEmptyStringParser('--improve-model'),
      description: bilingual({
        zh: '负责重写 skill 的 LLM，默认沿用被测模型',
        en: 'LLM that rewrites the skill; defaults to the evaluated model',
      }),
    }),
    concurrency: Flags.string({
      description: bilingual({ zh: '评测并发数，默认 1', en: 'Eval concurrency, default 1' }),
      default: '1',
      parse: integerStringParser('--concurrency', { min: 1 }),
    }),
    timeout: Flags.string({
      description: bilingual({ zh: '单用例超时秒，默认 600', en: 'Per-sample timeout sec, default 600' }),
      default: '600',
      parse: numberStringParser('--timeout', { min: 1 }),
    }),
    executor: Flags.string({
      parse: nonEmptyStringParser('--executor'),
      description: bilingual({
        zh: '执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。',
        en: 'Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.',
      }),
    }),
    effort: Flags.string({
      description: bilingual({
        zh: 'reasoning effort: low/medium/high/xhigh/max',
        en: 'Reasoning effort: low/medium/high/xhigh/max',
      }),
      parse: enumStringParser('--effort', ['low', 'medium', 'high', 'xhigh', 'max']),
    }),
    'skip-doctor': Flags.boolean({
      description: bilingual({
        zh: '跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）',
        en: 'Skip doctor gate (escape hatch; user takes garbage-in risk)',
      }),
      default: false,
    }),
    'snapshot-only': Flags.boolean({
      description: bilingual({
        zh: '只产候选、不写回 source：胜出版本留在 evolve/，再由你人工选择。受管 skill 默认会写回 source 并记 Core 证据。',
        en: 'Produce candidates under evolve/ without writing the source. Managed skills normally write back only after a final Core gate and record Core evidence.',
      }),
      default: false,
    }),
    'improve-mode': Flags.string({
      description: bilingual({
        zh: '改写策略（默认：agent）',
        en: 'Improvement strategy (default: agent)',
      }),
      default: 'agent',
      options: ['agent', 'rewrite'],
    }),
    'edit-budget': Flags.string({
      description: bilingual({
        zh: '单轮最多改动的 skill 行占比（默认 0.2）。超预算的候选评测前直接判拒，省 eval 成本',
        en: 'Max fraction of skill lines a round may change (default 0.2). Over-budget candidates are rejected before evaluation, saving eval cost',
      }),
      default: '0.2',
      parse: numberStringParser('--edit-budget', { min: 0, max: 1 }),
    }),
    'no-edit-budget': Flags.boolean({
      description: bilingual({
        zh: '关掉 edit budget 约束（允许任意大小的单轮改动）',
        en: 'Disable the edit budget (allow arbitrarily large single-round edits)',
      }),
      default: false,
    }),
    'no-reject-memory': Flags.boolean({
      description: bilingual({
        zh: '关掉 rejected-edit 记忆（不把被拒改法回灌下一轮 prompt）',
        en: 'Disable rejected-edit memory (do not feed rejected edits back into the next prompt)',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Evolve);
    const lang = this.lang;
    await this.runWithCancellation(async (signal) => {
      const runtime = resolveRuntimeSelection(
        { executor: flags.executor, model: flags.model },
        { lang },
      );
      await runEvolve(args, {
        ...flags,
        executor: runtime.executor,
        model: runtime.model,
        'judge-models': flags['judge-models']
          ?? envJudgeModels()
          ?? `${runtime.executor}:${runtime.judgeModel}`,
        'improve-model': flags['improve-model'] ?? runtime.model,
        lang,
      }, lang, signal);
    });
  }
}

export type EvolveArgs = Interfaces.InferredArgs<typeof Evolve.args>;
export type EvolveFlags = CommandFlags<typeof Evolve.flags> & { model: string; executor: string; 'judge-models': string; 'improve-model': string };

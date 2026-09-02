import { resolve, join, dirname, extname } from 'node:path';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { enumStringParser, integerStringParser, numberStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { formatSampleGenerationFailureHint } from '../lib/generation-failure-hint.js';
import { createEvalSampleSetDocument } from '../../inputs/schemas/sample-set.js';
import { stringifySampleDocument } from '../../inputs/sample-document.js';
import type { EvolveArgs, EvolveFlags } from '../lib/cmd-flags.js';
import type {
  CoreEvolveOutcomeInput,
  EvolveOutcomeResult,
} from '../lib/record-evolve-outcome.js';
import { envJudgeModels, resolveRuntimeSelection } from '../lib/runtime-defaults.js';

/** 受管联动旁路:evolve 写回 source 后记证据 + re-baseline。任何异常都不该让 evolve 失败,
 *  故 try/catch 吞掉、返回 null(同 eval 的 recordEvidenceSafely 口径)。 */
async function recordEvolveOutcomeSafely(input: CoreEvolveOutcomeInput): Promise<EvolveOutcomeResult | null> {
  try {
    const { recordCoreEvolveOutcome } = await import('../lib/record-evolve-outcome.js');
    return recordCoreEvolveOutcome(input);
  } catch {
    return null;
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

/** 路径处是否已存在「用例源」:按 statSync 判型 —— 文件(含无扩展名)直接算存在;
 *  目录看是否含候选用例文件(排除 report/health/_ 前缀,对齐 sample.ts 的发现约定)。
 *  用于区分「损坏文件(存在但解析失败 → 报错不覆盖)」与「确实没有用例(可生成)」。
 *  不能用 extname 猜文件/目录:无扩展名的损坏样本文件会绕过守卫被覆盖,
 *  带点的目录名(如 samples.v2/)会被误当文件。 */
export function sampleSourceExists(p: string): boolean {
  let st;
  try { st = statSync(p); } catch { return false; }
  if (!st.isDirectory()) return true;
  try {
    return readdirSync(p).some((f) => /\.(json|ya?ml)$/i.test(f) && !/^(report|health|_)/i.test(f));
  } catch { return false; }
}

/** 自动生成时的落盘目标:已存在的目录(含带点目录名,如 samples.v2/)→ 写进目录内的
 *  eval-samples.json;已存在的文件 → 覆盖该文件;不存在 → 按扩展名(有扩展名当文件,无扩展名
 *  当目录,落 eval-samples.json)。与 sampleSourceExists 同用 statSync 判型,不被带点目录名
 *  误当成文件(否则 writeFileSync 撞 EISDIR)。 */
export function resolveSampleOutFile(samplesAbs: string): string {
  try {
    return statSync(samplesAbs).isDirectory() ? join(samplesAbs, 'eval-samples.json') : samplesAbs;
  } catch {
    return extname(samplesAbs) ? samplesAbs : join(samplesAbs, 'eval-samples.json');
  }
}

// runEvolve module-level helper:cli-exit.test 测「skillPath 空 throw CliExit(1)」走
// in-process import 验证业务,Command.run() body 直接调它。
export async function runEvolve(
  args: EvolveArgs,
  flags: EvolveFlags,
  lang: CliLang,
): Promise<void> {
  const skillPathArg: string = args.skillPath;
  if (!skillPathArg) {
    console.error(tCli('cli.evolve.specify_skill_path', lang));
    throw new CliExit(1);
  }

  const { resolveSkillInput } = await import('../lib/resolve-skill-input.js');
  let resolvedInput;
  try { resolvedInput = resolveSkillInput(skillPathArg, lang); } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    throw new CliExit(1);
  }
  const skillPath = resolvedInput.skillPath;
  // evolve 目标的形态(目录-skill / 文件-skill),供受管联动按形态精确匹配记录。**取解析后形态**而非「入参是不是
  // 目录」:帮助文档鼓励传 `skills/foo/SKILL.md`,若按入参判会得 false、匹配不到 install 落的目录记录(漂移永不消)。
  const skillIsDir = resolvedInput.isDirectorySkill;

  let samplesFile: string = flags.samples;
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    samplesFile = resolvedInput.samplesPath;
  }

  // 参数校验必须早于任何昂贵副作用(自动生成用例 / LLM 调用)。
  const { parseJudgeModelsArgOrExit } = await import('../lib/parse-run-config.js');
  const evolveJudges = parseJudgeModelsArgOrExit(flags['judge-models']);
  if (evolveJudges.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'omk evolve' }));
    throw new CliExit(2);
  }

  // 无用例时自动生成 —— 让 omk evolve 成为「检测(doctor) → 生成用例 → 自迭代」一键命令。
  // 已有用例(且非空)则原样使用;生成失败按普通错误退出。
  const samplesAbs = resolve(samplesFile);
  let hasSamples = false;
  let loadErr: Error | null = null;
  try {
    const { loadSamples } = await import('../../inputs/load-samples.js');
    hasSamples = loadSamples(samplesAbs).samples.length > 0;
  } catch (err) { loadErr = err as Error; }

  const sourceExists = sampleSourceExists(samplesAbs);

  // 用例源已存在却解析失败(JSON/YAML 语法错、duplicate id 等)= 损坏文件,
  // 绝不用 LLM 生成内容覆盖它 —— 报错退出,让用户先修。只有真的没有用例源(文件
  // 不存在 / 目录无候选用例文件)才进入自动生成。
  if (loadErr && sourceExists) {
    console.error(lang === 'zh'
      ? `评测用例文件解析失败，evolve 不会覆盖它，请先修复：${samplesAbs}\n  原因：${loadErr.message}`
      : `Failed to parse the samples source; evolve will not overwrite it. Fix it first: ${samplesAbs}\n  reason: ${loadErr.message}`);
    throw new CliExit(1);
  }

  if (!hasSamples) {
    try {
      const { generateSamples } = await import('../../knowledge-artifacts/authoring/generator.js');
      const skillContent = readFileSync(resolve(skillPath), 'utf-8');
      // outFile:已存在目录写进内部 eval-samples.json,已存在文件覆盖,不存在按扩展名 —— statSync
      // 判型,不被带点目录名(samples.v2/)骗。loadSamples 目录模式会自动发现生成的文件。
      const outFile = resolveSampleOutFile(samplesAbs);
      // sourceExists 为真 = 用例源存在但解析出 0 条(合法空 [])→ 明示"重新生成覆盖空文件",
      // 不静默盖用户文件;为假 = 真没有用例源 → "未发现，生成"。
      process.stderr.write(lang === 'zh'
        ? (sourceExists
            ? `评测用例为空，正在重新生成并覆盖 ${outFile} …\n`
            : `未发现评测用例，正在自动生成到 ${outFile} …\n`)
        : (sourceExists
            ? `Samples are empty; regenerating (overwriting) ${outFile} …\n`
            : `No samples found; auto-generating to ${outFile} …\n`));
      const { samples, costUSD } = await generateSamples({
        skillContent,
        model: flags.model,
        executorName: flags.executor,
      });
      // 模型可能保守返回 0 条 —— 不写空文件再空跑迭代,直接报错让用户改用
      // `omk sample --focus` 引导生成或手写用例。
      if (samples.length === 0) {
        console.error(lang === 'zh'
          ? '自动生成返回 0 条用例，已中止。请用 `omk sample <skill> --focus "…"` 引导生成，或手写后重试。'
          : 'Auto-generation produced 0 samples; aborting. Use `omk sample <skill> --focus "…"` to guide generation, or write samples manually.');
        throw new CliExit(1);
      }
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(
        outFile,
        stringifySampleDocument(outFile, createEvalSampleSetDocument(samples)),
      );
      const cost = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      process.stderr.write(lang === 'zh'
        ? `已生成 ${samples.length} 条用例${cost}，开始自迭代。\n`
        : `Generated ${samples.length} samples${cost}; starting evolution.\n`);
    } catch (err: unknown) {
      if (err instanceof CliExit) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(tCli('cli.common.error_prefix', lang, {
        message: `${message}${formatSampleGenerationFailureHint(message, flags.executor, lang)}`,
      }));
      throw new CliExit(1);
    }
  }

  const { evolveSkillCore } = await import('../../knowledge-artifacts/authoring/core-evolver.js');
  const { runCoreEvaluationCommand } = await import('../lib/run-core-evaluation.js');
  const evolveEffort = flags.effort ? validateEvolveEffort(flags.effort, lang) : undefined;
  const evaluatePair = async (control: string, treatment: string) => {
    const evaluation = await runCoreEvaluationCommand({
      flags: {
        control,
        treatment,
        samples: resolve(samplesFile),
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
      },
      config: {
        samplesPath: resolve(samplesFile),
        skillDir: dirname(resolve(skillPath)),
        executorName: flags.executor,
        model: flags.model,
        effort: evolveEffort,
        judgeModels: evolveJudges,
      },
      evalConfig: null,
      lang: 'zh',
    });
    if (evaluation.stored === undefined) {
      throw new Error('Core evolve evaluation 未持久化 artifact chain。');
    }
    return evaluation.stored;
  };

  process.stderr.write(tCli('cli.evolve.section_header', lang, { path: skillPath }));

  try {
    const result: EvolveResult = await evolveSkillCore({
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
      if (recorded) {
        process.stderr.write(tCli('cli.evolve.evidence_recorded_managed', lang, {
          name: recorded.name, verdict: recorded.verdict,
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
      description: bilingual({
        zh: '用例文件路径，默认 eval-samples.json',
        en: 'Samples file, default eval-samples.json',
      }),
      default: 'eval-samples.json',
    }),
    model: Flags.string({
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
    await this.runWithCliExit(async () => {
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
      }, lang);
    });
  }
}

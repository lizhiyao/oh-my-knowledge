import { CliExit } from '../cli-exit.js';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import { makeOnProgress } from '../progress.js';
import type { ProgressCallback } from '../../types/index.js';

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

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values, positionals } = parseArgsStrictOrExit({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      rounds: { type: 'string', default: '5' },
      target: { type: 'string' },
      samples: { type: 'string', default: 'eval-samples.json' },
      model: { type: 'string', default: 'sonnet' },
      'judge-models': { type: 'string', default: 'claude:haiku' },
      'improve-model': { type: 'string', default: 'sonnet' },
      concurrency: { type: 'string', default: '1' },
      timeout: { type: 'string', default: '120' },
      executor: { type: 'string', default: 'claude' },
      'skip-connectivity': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  // skill path 走 parseArgs 的 positionals，避免 raw argv.find 把 flag value
  // 当成 path 误识别，例如 `improve skill --judge-models openai-api:gpt-4o foo.md`。
  const skillPath: string | undefined = positionals[0];
  if (!skillPath) {
    console.error(tCli('cli.evolve.specify_skill_path', lang));
    throw new CliExit(1);
  }

  let samplesFile: string = (values.samples as string) ?? 'eval-samples.json';
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const { evolveSkill } = await import('../../authoring/evolver.js');
  const { parseJudgeModelsArgOrExit } = await import('../parse-run-config.js');

  const evolveJudges = parseJudgeModelsArgOrExit(values['judge-models'] as string);
  if (evolveJudges.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'omk evolve' }));
    throw new CliExit(2);
  }

  process.stderr.write(tCli('cli.evolve.section_header', lang, { path: skillPath }));

  try {
    const result: EvolveResult = await evolveSkill({
      skillPath: resolve(skillPath),
      samplesPath: resolve(samplesFile),
      rounds: Math.max(1, Number(values.rounds) || 5),
      target: values.target ? Number(values.target) : null,
      model: values.model as string,
      judgeModels: evolveJudges,
      improveModel: values['improve-model'] as string,
      executorName: values.executor as string,
      concurrency: Math.max(1, Number(values.concurrency) || 1),
      timeoutMs: Math.max(1, Number(values.timeout) || 120) * 1000,
      skipConnectivity: values['skip-connectivity'] as boolean,
      onProgress: makeOnProgress(lang) as unknown as ProgressCallback,
      onRoundProgress({ round, totalRounds: _totalRounds, phase, score, delta, accepted, costUSD, costReported, error }: RoundProgressInfo): void {
        // costReported=false 时显示「—」而不是 $0.0000(executor 不报 cost,如 codex)。
        // 缺位 / true 当 reported 走旧格式。
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
      ? '—'  // 任一轮的 executor 不报 cost → totalCostUSD 是 lower-bound
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
    // CliExit 是显式 exit 信号,保持原 code 透传(同 gate / run)。
    if (err instanceof CliExit) throw err;
    console.error(tCli('cli.common.error_prefix', lang, { message: (err as Error).message }));
    throw new CliExit(1);
  }
}

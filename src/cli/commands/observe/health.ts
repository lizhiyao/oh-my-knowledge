import { resolve, join } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { CliExit } from '../../lib/cli-exit.js';
import { tCli } from '../../lib/i18n.js';
import { parseLastWindow } from '../../lib/shared.js';
import { DEFAULT_OBSERVE_HEALTH_DIR } from '../../../eval-core/default-dirs.js';

// `omk observe health <sessions-dir>` — 分析 sessions 目录的 skill 调用健康度，产出 observe-health 报告(JSON)，
// 由 Studio /observe-health 按需渲染。同级子命令 ingest / inbox / show 走观测收件箱(observe-inbox)那条线。

export default class ObserveHealth extends BaseCommand {
  static description = bilingual({
    zh: '分析 sessions 目录的 skill 调用健康度，产出观测健康报告。',
    en: 'Analyze skill invocation health from a sessions dir; produce an observe-health report.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '分析最近 7 天',
        en: 'Analyze last 7 days',
      }),
      command: '<%= config.bin %> observe health ~/.claude/sessions --last 7d',
    },
  ];

  static args = {
    sessionsDir: Args.string({
      description: bilingual({
        zh: 'sessions 目录路径（如 ~/.claude/sessions）',
        en: 'Sessions dir path (e.g. ~/.claude/sessions)',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    kb: Flags.string({
      description: bilingual({ zh: '知识库 root，启用 KB-aware 分析', en: 'KB root, enables KB-aware analysis' }),
    }),
    last: Flags.string({
      description: bilingual({ zh: '时间窗(7d / 24h / 30m）', en: 'Time window (7d / 24h / 30m)' }),
    }),
    from: Flags.string({
      description: bilingual({ zh: '起始时间 ISO，优先级高于 --last', en: 'Start time ISO, overrides --last' }),
    }),
    to: Flags.string({
      description: bilingual({ zh: '结束时间 ISO', en: 'End time ISO' }),
    }),
    skills: Flags.string({
      description: bilingual({
        zh: '只看指定 skill，逗号分隔',
        en: 'Filter to specific skills, comma-separated',
      }),
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '健康报告输出目录，默认 ~/.oh-my-knowledge/observe-health',
        en: 'Health report output dir, default ~/.oh-my-knowledge/observe-health',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveHealth);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const dir = args.sessionsDir;
      if (!dir) {
        console.error(tCli('cli.help.observe_health', lang).trim());
        throw new CliExit(1);
      }
      const tracePath = resolve(dir);

      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      if (!existsSync(tracePath)) {
        console.error(`Trace path does not exist: ${tracePath}`);
        throw new CliExit(1);
      }

      // 时间窗: --from/--to 优先, --last fallback
      let from: string | undefined = flags.from;
      if (!from && flags.last) {
        const inferred = parseLastWindow(flags.last);
        if (!inferred) {
          console.error(`Invalid --last format: "${flags.last}". Expected e.g. "7d" / "24h" / "30m".`);
          throw new CliExit(1);
        }
        from = inferred;
      }
      const to: string | undefined = flags.to;
      const skills = flags.skills ? flags.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      console.log(`[omk] analyzing ${tracePath}...`);
      const { computeSkillHealthReport } = await import('../../../observability/skill-health-analyzer.js');
      const report = computeSkillHealthReport(tracePath, {
        kbRoot: flags.kb ? resolve(flags.kb) : undefined,
        from,
        to,
        skills,
      });

      // JSON 是主产物；HTML 由 report server 的 /observe-health/:id 按需渲染。
      const outDir = resolve(flags['output-dir'] || DEFAULT_OBSERVE_HEALTH_DIR);
      mkdirSync(outDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const jsonPath = join(outDir, `${timestamp}-observe-health.json`);
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));

      const { sessionCount, segmentCount, toolCallCount, toolFailureRate } = report.meta;
      console.log('');
      console.log(`sessions: ${sessionCount} · segments: ${segmentCount} · tool calls: ${toolCallCount} · fail rate: ${(toolFailureRate * 100).toFixed(1)}%`);
      const overallConf = report.overall.confidence;
      const confSuffix = overallConf === 'high'
        ? ''
        : ` · ⚠ confidence: ${overallConf} (N=${segmentCount} too small; band is indicative)`;
      console.log(`overall: gapRate ${(report.overall.gapRate * 100).toFixed(1)}% · weightedGapRate ${(report.overall.weightedGapRate * 100).toFixed(1)}% · health: ${report.overall.healthBand}${confSuffix}`);
      console.log('');
      const skillRows = Object.values(report.bySkill)
        .sort((a, b) => b.segmentCount - a.segmentCount)
        .slice(0, 10)
        .map((s) => `  ${s.skillName.padEnd(24)} segs=${String(s.segmentCount).padStart(4)}  gapRate=${String(Math.round(s.gap.gapRate * 100) + '%').padStart(4)}  weighted=${String(Math.round(s.gap.weightedGapRate * 100) + '%').padStart(4)}${s.coverage ? `  cov=${Math.round(s.coverage.fileCoverageRate * 100)}%` : ''}${s.confidence !== 'high' ? `  ⚠${s.confidence}` : ''}`);
      console.log('top skills:');
      console.log(skillRows.join('\n'));
      console.log('');
      console.log(`report written to: ${jsonPath}`);
      console.log(tCli('cli.observe.view_hint', lang));
    });
  }
}

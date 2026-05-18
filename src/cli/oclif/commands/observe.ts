import { resolve, join } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../i18n.js';
import { CliExit } from '../../cli-exit.js';
import { tCli } from '../../i18n.js';
import { parseLastWindow } from '../../_shared.js';

// oclif 版 observe 默认命令 — `omk observe <sessions-dir>` 走 health 分析。
// 三个子命令(ingest / inbox / show)由 src/cli/oclif/commands/observe/ 文件目录托管。

export default class Observe extends Command {
  static description = bilingual({
    zh: '分析 sessions 目录的 skill 调用健康度（默认行为）。子命令:ingest / inbox / show。',
    en: 'Analyze skill invocation health from sessions dir (default). Subcommands: ingest / inbox / show.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '分析最近 7 天',
        en: 'Analyze last 7 days',
      }),
      command: '<%= config.bin %> observe ~/.claude/sessions --last 7d',
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
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
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
        zh: '分析结果输出目录',
        en: 'Analysis output directory',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Observe);
    const lang = resolveLang(process.argv);
    try {
      const dir = args.sessionsDir;
      if (!dir) {
        console.error(tCli('cli.help.observe', lang).trim());
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

      // JSON 是主产物；HTML 由 report server 的 /analyses/:id 按需渲染。
      const outDir = resolve(flags['output-dir'] || join(process.env.HOME || '.', '.oh-my-knowledge', 'analyses'));
      mkdirSync(outDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const jsonPath = join(outDir, `${timestamp}-skill-health.json`);
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));

      const { sessionCount, segmentCount, toolCallCount, toolFailureRate } = report.meta;
      console.log('');
      console.log(`sessions: ${sessionCount} · segments: ${segmentCount} · tool calls: ${toolCallCount} · fail rate: ${(toolFailureRate * 100).toFixed(1)}%`);
      console.log(`overall: gapRate ${(report.overall.gapRate * 100).toFixed(1)}% · weightedGapRate ${(report.overall.weightedGapRate * 100).toFixed(1)}% · health: ${report.overall.healthBand}`);
      console.log('');
      const skillRows = Object.values(report.bySkill)
        .sort((a, b) => b.segmentCount - a.segmentCount)
        .slice(0, 10)
        .map((s) => `  ${s.skillName.padEnd(24)} segs=${String(s.segmentCount).padStart(4)}  gapRate=${String(Math.round(s.gap.gapRate * 100) + '%').padStart(4)}  weighted=${String(Math.round(s.gap.weightedGapRate * 100) + '%').padStart(4)}${s.coverage ? `  cov=${Math.round(s.coverage.fileCoverageRate * 100)}%` : ''}`);
      console.log('top skills:');
      console.log(skillRows.join('\n'));
      console.log('');
      console.log(`report written to: ${jsonPath}`);
      console.log(tCli('cli.observe.view_hint', lang));
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

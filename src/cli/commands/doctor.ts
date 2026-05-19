import { homedir } from 'node:os';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { numberStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli } from '../lib/i18n.js';
import type { Sample } from '../../types/index.js';
import type { DependencyRequirements } from '../../eval-core/dependency-checker.js';

const DEFAULT_SAMPLE_FILENAMES = ['eval-samples.json', 'eval-samples.yaml', 'eval-samples.yml'] as const;

function findSamplesInDir(dir: string): string | null {
  for (const name of DEFAULT_SAMPLE_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sampleSearchDirs(target: string | null, cwd: string): string[] {
  const dirs: string[] = [];
  const add = (dir: string): void => {
    const abs = resolve(dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  };
  if (target) {
    const absTarget = resolve(target);
    if (existsSync(absTarget)) {
      const stat = statSync(absTarget);
      if (stat.isDirectory()) {
        add(absTarget);
        add(dirname(absTarget));
        add(dirname(dirname(absTarget)));
      } else {
        const parent = dirname(absTarget);
        add(parent);
        add(dirname(parent));
      }
    }
  }
  add(cwd);
  return dirs;
}

function findDefaultSamplesPath(target: string | null, cwd: string): string | null {
  for (const dir of sampleSearchDirs(target, cwd)) {
    const samplesPath = findSamplesInDir(dir);
    if (samplesPath) return samplesPath;
  }
  return null;
}

export default class Doctor extends BaseCommand {
  static description = bilingual({
    zh: '体检 omk 工作目录，检查 skill 配置 / 依赖 / executor 连通性。',
    en: 'Preflight health checks for omk workdir: skill config / deps / executor connectivity.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '默认模式跑 LLM 健康度审计(7 内置维度）。',
        en: 'Default mode runs LLM-driven health audit (7 built-in dimensions).',
      }),
      command: '<%= config.bin %> doctor',
    },
    {
      description: bilingual({
        zh: '离线静态模式，只跑 4 条静态 rule，不调 LLM,CI 无 LLM 凭证时用。',
        en: 'Offline static mode, only 4 static rules, no LLM call. Use when CI lacks LLM credentials.',
      }),
      command: '<%= config.bin %> doctor --static-only',
    },
    {
      description: bilingual({
        zh: 'JSON 输出 + 写 HTML 报告，给 CI 抓 exit code 同时人看。',
        en: 'JSON output + HTML report, for CI exit code + human review.',
      }),
      command: '<%= config.bin %> doctor --json --html doctor.html',
    },
  ];

  static args = {
    target: Args.string({
      description: bilingual({
        zh: '要体检的 skill 路径或目录。可选，默认扫当前 cwd 下的 skills/。',
        en: 'Skill path or directory to inspect. Optional, defaults to scanning ./skills/.',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    json: Flags.boolean({
      description: bilingual({
        zh: 'JSON 输出到 stdout，适合 CI / 外部脚本消费。',
        en: 'JSON output to stdout, for CI / external script consumption.',
      }),
      default: false,
    }),
    gate: Flags.boolean({
      description: bilingual({
        zh: '静默模式，只在 fail 时输出 stderr 摘要，exit code 标识结果。',
        en: 'Silent mode: only emit stderr summary on fail. Exit code carries the signal.',
      }),
      default: false,
    }),
    executor: Flags.string({
      description: bilingual({
        zh: '执行器名，默认 claude。指定为测试 fixture 路径可在测试里跑（同 omk doctor）。',
        en: 'Executor name, default claude. Pass a test fixture path to use in tests.',
      }),
    }),
    model: Flags.string({
      description: bilingual({
        zh: 'LLM model 名，默认 sonnet。',
        en: 'LLM model name, default sonnet.',
      }),
    }),
    samples: Flags.string({
      description: bilingual({
        zh: '样本文件路径（.json/.yaml）。不传则按 target / cwd 顺序自动发现。',
        en: 'Samples file path (.json/.yaml). Auto-detects from target / cwd if omitted.',
      }),
    }),
    timeout: Flags.string({
      description: bilingual({
        zh: '单次 LLM 会话超时秒数，默认 600(10 分钟）。',
        en: 'Single-session LLM timeout sec, default 600 (10 min).',
      }),
      parse: numberStringParser('--timeout', { min: 1 }),
    }),
    html: Flags.string({
      description: bilingual({
        zh: 'HTML 报告输出路径。可跟 --json / --gate 共存。',
        en: 'HTML report output path. Coexists with --json / --gate.',
      }),
    }),
    'static-only': Flags.boolean({
      description: bilingual({
        zh: '离线静态模式，只跑 4 条静态 rule(skill_readable / skill_metadata / dependencies_present / samples_contract_aligned），不调 LLM。',
        en: 'Offline static mode: only 4 static rules, no LLM call.',
      }),
      default: false,
    }),
    fix: Flags.boolean({
      description: bilingual({
        zh: '交互式修复：根据 doctor 报告问题，用 LLM agent 修复 skill。',
        en: 'Interactive fix: use LLM agent to fix skill issues reported by doctor.',
      }),
      default: false,
    }),
    effort: Flags.string({
      description: bilingual({
        zh: 'LLM 推理 effort：low / medium / high / xhigh / max。',
        en: 'LLM reasoning effort: low / medium / high / xhigh / max.',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Doctor);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const target: string | null = args.target ?? null;
      const executorName = flags.executor ?? 'claude';
      const model = flags.model ?? 'sonnet';
      // 默认 LLM 健康度审计(7 内置维度 + 用户注册的自定义维度);--static-only 切到
      // 离线静态模式:只跑 4 条静态 rule,不调 LLM。CI 节点没装 claude/codex、本地断网
      // 调试等场景。
      const staticOnly = flags['static-only'];
      const runHealthCheck = !staticOnly;
      const defaultTimeoutSec = 600;
      const timeoutSec = flags.timeout != null ? Number(flags.timeout) : defaultTimeoutSec;
      const timeoutMs = Math.max(
        1000,
        Math.floor((Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000),
      );

      const cwd = process.cwd();
      const samplesPath = flags.samples ? resolve(flags.samples) : findDefaultSamplesPath(target, cwd);
      let samples: Sample[] | undefined;
      let requires: DependencyRequirements | undefined;
      if (samplesPath) {
        try {
          const { loadSamples } = await import('../../inputs/load-samples.js');
          const loaded = loadSamples(samplesPath);
          samples = loaded.samples;
          requires = loaded.requires;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(tCli('cli.common.warn_load_samples_failed', lang, { path: samplesPath, message: msg }));
        }
      }

      // 副作用 import: 注册 7 内置维度 spec + skill_health composer rule。
      await import('../../doctor/health/register.js');

      const { runDoctor } = await import('../../doctor/index.js');
      const { renderDoctorReportText, renderDoctorReportJson } = await import('../../doctor/renderer.js');
      const { getRegisteredRules } = await import('../../doctor/rules.js');
      const { isComposerRule } = await import('../../types/doctor.js');
      const rulesOverride = staticOnly
        ? getRegisteredRules().filter((r) => !isComposerRule(r))
        : getRegisteredRules().filter(isComposerRule);

      let report;
      try {
        report = await runDoctor({
          target,
          cwd,
          executorName,
          model,
          timeoutMs,
          lang,
          runHealthCheck,
          rules: rulesOverride,
          samples,
          requires,
        });
      } catch (err) {
        if (err instanceof CliExit) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(tCli('cli.doctor.no_skill_found', lang, { path: target ?? cwd }));
        console.error(`(${msg})`);
        throw new CliExit(1);
      }

      if (report.skills.length === 0) {
        console.error(tCli('cli.doctor.no_skill_found', lang, { path: target ?? cwd }));
        throw new CliExit(1);
      }

      if (flags.html) {
        const { renderDoctorReportHtml } = await import('../../doctor/html-renderer.js');
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const abs = resolve(flags.html);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, renderDoctorReportHtml(report, lang), 'utf8');
        console.error(lang === 'zh' ? `HTML 报告已写入: ${abs}` : `HTML report written to: ${abs}`);
      }

      if (flags.json) {
        console.log(renderDoctorReportJson(report));
      } else if (flags.gate) {
        if (report.outcome === 'failed') {
          const summary = lang === 'zh'
            ? `doctor failed: ${report.totals.fail} 个 skill 未通过 (${report.totals.warn} warn / ${report.totals.pass} pass)`
            : `doctor failed: ${report.totals.fail} skills did not pass (${report.totals.warn} warn / ${report.totals.pass} pass)`;
          console.error(summary);
        }
      } else {
        if (samplesPath && samples) {
          process.stderr.write(tCli('cli.doctor.samples_detected', lang, { path: samplesPath }) + '\n');
        }
        renderDoctorReportText(report, lang);
      }

      persistDoctorReport(report);

      if (flags.fix) {
        const existing = report;
        if (existing.outcome !== 'failed') {
          process.stderr.write(lang === 'zh' ? '✅ 没有需要修复的问题\n' : '✅ Nothing to fix\n');
          throw new CliExit(0);
        }
        const { runDoctorFix } = await import('../../doctor/fixer.js');
        const changed = await runDoctorFix({ report: existing, executorName, model, timeoutMs });
        throw new CliExit(changed ? 0 : (existing.outcome === 'failed' ? 1 : 0));
      }

      throw new CliExit(report.outcome === 'failed' ? 1 : 0);
    });
  }
}

function persistDoctorReport(report: import('../../types/doctor.js').DoctorReport): void {
  const dir = join(homedir(), '.oh-my-knowledge', 'doctors');
  mkdirSync(dir, { recursive: true });
  for (const skill of report.skills) {
    const perSkill = {
      ...report,
      skills: [skill],
      totals: {
        pass: skill.status === 'pass' ? 1 : 0,
        warn: skill.status === 'warn' ? 1 : 0,
        fail: skill.status === 'fail' ? 1 : 0,
      },
      outcome: skill.status === 'fail' ? 'failed' : skill.status === 'warn' ? 'warnings_only' : 'passed',
    };
    const safeName = skill.skillName.replace(/[/\\:*?"<>|]/g, '_');
    writeFileSync(join(dir, `${safeName}.json`), JSON.stringify(perSkill, null, 2), 'utf8');
  }
}

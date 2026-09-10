import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { enumStringParser, integerStringParser, numberStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli } from '../lib/i18n.js';
import { makeDoctorProgress } from '../lib/progress.js';
import { resolveCliExecutor, resolveRuntimeSelection } from '../lib/runtime-defaults.js';
import { projectDoctorsDir, globalDoctorsDir } from '../../evidence/storage/directories.js';
import type { DoctorRule, DoctorRuleLike } from '../../knowledge-artifacts/doctor/contracts.js';
import { persistDoctorReport } from '../../knowledge-artifacts/doctor/persistence.js';

export default class Doctor extends BaseCommand {
  static description = bilingual({
    zh: '体检 omk 工作目录：先跑静态规则，再对 skill 做多维度 LLM 健康度审计（默认 --repeat 2 采样 + 共识归并）。',
    en: 'Preflight health checks for omk workdir: static rules plus multi-dimension LLM health audit of your skills (default --repeat 2 sampling + consensus merge).',
  });

  static examples = [
    {
      description: bilingual({
        zh: '默认模式跑静态规则 + LLM 健康度审计（7 内置维度）。',
        en: 'Default mode runs static rules plus LLM-driven health audit (7 built-in dimensions).',
      }),
      command: '<%= config.bin %> doctor',
    },
    {
      description: bilingual({
        zh: '单次快速体检（不采样、不归并，最省）。',
        en: 'Single quick pass (no sampling/merge, cheapest).',
      }),
      command: '<%= config.bin %> doctor --repeat 1',
    },
    {
      description: bilingual({
        zh: '只跑静态检测（不调 LLM、不读 samples）：结构 + 正文依赖检查。',
        en: 'Static checks only (no LLM, no samples): structural + body-dependency checks.',
      }),
      command: '<%= config.bin %> doctor --static-only',
    },
    {
      description: bilingual({
        zh: 'JSON 输出 + 静默 gate，给 CI 抓 exit code 同时人看。',
        en: 'JSON output + silent gate, for CI exit code + human review.',
      }),
      command: '<%= config.bin %> doctor --json --gate',
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
        zh: '执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。指定为测试 fixture 路径可在测试里跑。',
        en: 'Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference. A test fixture path is also accepted in tests.',
      }),
    }),
    model: Flags.string({
      description: bilingual({
        zh: 'LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。',
        en: 'LLM model name. Codex reads the local configured model; OMK_MODEL sets an environment preference.',
      }),
    }),
    timeout: Flags.string({
      description: bilingual({
        zh: '单次 LLM 会话超时秒数，默认 600(10 分钟）。',
        en: 'Single-session LLM timeout sec, default 600 (10 min).',
      }),
      parse: numberStringParser('--timeout', { min: 1 }),
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '报告输出目录，默认项目级 .omk/doctor（--global 写全局）。',
        en: 'Report output dir, default project-level .omk/doctor (--global for global).',
      }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '写全局 ~/.oh-my-knowledge/doctor，而非项目 .omk/doctor',
        en: 'Write to global ~/.oh-my-knowledge/doctor instead of project .omk/doctor',
      }),
    }),
    dimensions: Flags.string({
      description: bilingual({
        zh: '自定义维度配置文件（YAML），追加到内置 7 维度之后。每条维度二选一：promptSection（走 LLM 体检）或 endpoint（POST skill 快照给接口判定）。注意：endpoint 会把 SKILL.md 全文 + 子文件发到该地址，仅对可信配置/可信地址启用。',
        en: 'Custom dimensions config file (YAML), appended after builtin 7. Each is either promptSection (LLM audit) or endpoint (POST skill snapshot to your service). Note: endpoint sends the full SKILL.md + sub-files to that URL — only enable for trusted configs/URLs.',
      }),
    }),
    fix: Flags.boolean({
      exclusive: ['static-only'],
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
      parse: enumStringParser('--effort', ['low', 'medium', 'high', 'xhigh', 'max']),
    }),
    repeat: Flags.string({
      description: bilingual({
        zh: '健康度体检重复采样次数（self-consistency）。默认 2：并行跑 2 遍、finding 取并集并用 LLM 聚类归并同根因、标注支持度 k/N，压低单次采样方差。设 1 = 单次快速体检（不采样、不归并，最省）。',
        en: 'Health-check repeat count (self-consistency). Default 2: runs 2 passes in parallel, unions findings, merges same root cause via an LLM pass, tags k/N support. Set 1 for a single quick pass (no sampling/merge, cheapest).',
      }),
      parse: integerStringParser('--repeat', { min: 1, max: 10 }),
    }),
    concurrency: Flags.string({
      description: bilingual({
        zh: '多次采样的并发数。默认 = --repeat（全并行，各遍相互独立，压墙钟时间）。设 1 = 串行。成本不变，只抬高瞬时并发（rate-limit 敏感时调小）。',
        en: 'Concurrency across the repeated passes. Default = --repeat (full parallel; passes are independent, cuts wall-clock). Set 1 for serial. Cost unchanged; only raises peak concurrency (lower it if rate-limited).',
      }),
      parse: integerStringParser('--concurrency', { min: 1, max: 10 }),
    }),
    'static-only': Flags.boolean({
      description: bilingual({
        zh: '只跑静态检测（不调 LLM、不读 samples.json）：skill 可读性 / frontmatter 合法性 / 正文引用的脚本·CLI·文件·env 是否存在。CI 无 LLM 凭证或断网时用。',
        en: 'Static checks only (no LLM, no samples.json): readability / frontmatter / existence of scripts·CLI·files·env referenced in the skill body. For CI without LLM creds / offline.',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Doctor);
    const lang = this.lang;
    await this.runWithCancellation(async (signal) => {
      const target: string | null = args.target ?? null;
      const staticOnly = flags['static-only'];
      const runtime = staticOnly
        ? {
            executor: resolveCliExecutor(flags.executor),
            model: flags.model ?? 'static-only',
          }
        : resolveRuntimeSelection(
            { executor: flags.executor, model: flags.model },
            { lang },
          );
      const executorName = runtime.executor;
      const model = runtime.model;
      // omk doctor 默认 = 静态规则 + LLM 健康度审计(7 内置维度 + 用户注册的自定义维度);
      // --static-only = 只跑静态检测(readable / metadata / 正文依赖,不调 LLM、不读 samples)。
      // samples_contract_aligned 仍只归 eval preflight(它要 samples.json,与离线解耦)。
      // 健康度体检重复采样次数(CLI flag --repeat → 内部 healthSamples 字段):默认 2,
      // 设 1 = 单次快检。合法范围由 oclif parser 拦截。
      const healthSamples = flags.repeat != null ? Number(flags.repeat) : 2;
      // 归并策略:CLI 恒用 llm(硬逻辑,不暴露开关);samples=1 时 composer 自动跳过归并。
      // 失败回退 string 仍在 composer 内兜底。programmatic runDoctor 默认仍是 string。
      const healthMerge: 'string' | 'llm' = 'llm';
      // 并发数(--concurrency → healthConcurrency):默认不传(composer 取 = healthSamples 全并行);显式 ≥1 才覆盖。
      const healthConcurrency = flags.concurrency != null ? Number(flags.concurrency) : undefined;
      const defaultTimeoutSec = 600;
      const timeoutSec = flags.timeout != null ? Number(flags.timeout) : defaultTimeoutSec;
      const timeoutMs = Math.max(
        1000,
        Math.floor((Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000),
      );

      const cwd = process.cwd();

      // 副作用 import: 注册 7 内置维度 spec + skill_health composer rule。
      await import('../../knowledge-artifacts/doctor/health/register.js');

      if (flags.dimensions) {
        const { loadAndRegisterCustomDimensions } = await import('../../knowledge-artifacts/doctor/health/load-custom-dimensions.js');
        const count = loadAndRegisterCustomDimensions(resolve(flags.dimensions));
        if (count > 0) {
          process.stderr.write(lang === 'zh' ? `已加载 ${count} 个自定义维度\n` : `Loaded ${count} custom dimension(s)\n`);
        }
      }

      const { runDoctor } = await import('../../knowledge-artifacts/doctor/index.js');
      const { renderDoctorReportText, renderDoctorReportJson, renderDoctorActionPlanText } = await import('../../knowledge-artifacts/doctor/renderer.js');
      const { getRegisteredRules } = await import('../../knowledge-artifacts/doctor/rules.js');
      const { isComposerRule } = await import('../../knowledge-artifacts/doctor/rule-kind.js');
      // 默认:静态规则 + 在线检查(LLM health composer + endpoint 自定义维度 external=true)。
      // --static-only:只跑静态检测(纯静态内置 rule),但排除 samples_contract_aligned
      // (那条要 samples.json,与离线解耦) → 且不加载 samples,依赖检查只扫 skill 正文。
      const isOnline = (r: DoctorRuleLike): boolean =>
        isComposerRule(r) || (r as DoctorRule).external === true;
      const rulesOverride = staticOnly
        ? getRegisteredRules().filter((r) => !isOnline(r) && r.id !== 'samples_contract_aligned')
        : getRegisteredRules().filter((r) => r.id !== 'samples_contract_aligned');

      // 批量体检进度(per-skill,写 stderr)。--gate 是静默模式,不报进度;
      // --json 进度走 stderr 不污染 stdout 的 JSON。
      const onProgress = flags.gate ? undefined : makeDoctorProgress(lang);

      // --effort 合法性由 oclif parser 拦截。这里仅做窄化后透传给健康审计。
      const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
      const effort = flags.effort && (validEfforts as readonly string[]).includes(flags.effort)
        ? flags.effort as (typeof validEfforts)[number]
        : undefined;

      let report;
      try {
        report = await runDoctor({
          signal,
          target,
          cwd,
          executorName,
          model,
          timeoutMs,
          lang,
          runHealthCheck: !staticOnly,
          healthSamples,
          healthMerge,
          healthConcurrency,
          effort,
          rules: rulesOverride,
          onProgress,
        });
      } catch (err) {
        if (err instanceof CliExit) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(lang === 'zh' ? `健康检查未完成：${msg}` : `Doctor could not complete: ${msg}`);
        throw new CliExit(1);
      }

      if (report.skills.length === 0) {
        console.error(tCli('cli.doctor.no_skill_found', lang, { path: target ?? cwd }));
        throw new CliExit(1);
      }

      if (flags.json) {
        console.log(renderDoctorReportJson(report));
      } else if (flags.gate) {
        if (report.outcome === 'failed') {
          const summary = lang === 'zh'
            ? `doctor failed: ${report.totals.fail} 个 skill 未通过 (${report.totals.warn} warn / ${report.totals.pass} pass)`
            : `doctor failed: ${report.totals.fail} skills did not pass (${report.totals.warn} warn / ${report.totals.pass} pass)`;
          console.error(summary);
          process.stderr.write(renderDoctorActionPlanText(report, lang));
        }
      } else {
        renderDoctorReportText(report, lang);
      }

      const persistenceWarnings = persistDoctorReport(report, flags['output-dir']
        ? resolve(flags['output-dir'])
        : (flags.global ? globalDoctorsDir() : projectDoctorsDir()), lang);
      for (const message of persistenceWarnings) {
        process.stderr.write(lang === 'zh' ? `doctor 附属产物维护失败：${message}\n` : `Doctor derived artifact maintenance failed: ${message}\n`);
      }

      if (flags.fix) {
        const existing = report;
        if (existing.outcome !== 'failed') {
          process.stderr.write(lang === 'zh' ? '✅ 没有需要修复的问题\n' : '✅ Nothing to fix\n');
          throw new CliExit(0);
        }
        const { runDoctorFix } = await import('../../knowledge-artifacts/doctor/fixer.js');
        const changed = await runDoctorFix({ signal, report: existing, executorName, model, timeoutMs, effort });
        throw new CliExit(changed ? 0 : (existing.outcome === 'failed' ? 1 : 0));
      }

      throw new CliExit(report.outcome === 'failed' ? 1 : 0);
    });
  }
}

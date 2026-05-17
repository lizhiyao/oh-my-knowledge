import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';
import { runLegacyCommand } from '../run-legacy.js';

// oclif 版 doctor — 一次 typed parse 拿 {args, flags},直接喂业务 runDoctorCommand,
// 业务逻辑住在 src/cli/commands/doctor.ts(单一来源),oclif 这层是 thin shell。

export default class Doctor extends Command {
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
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。',
        en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh.',
      }),
      default: 'zh',
    }),
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Doctor);
    const lang = (flags.lang ?? 'zh') as 'zh' | 'en';
    await runLegacyCommand(this, async () => {
      const { runDoctorCommand } = await import('../../commands/doctor.js');
      await runDoctorCommand(args, { ...flags, lang }, lang);
    });
  }
}

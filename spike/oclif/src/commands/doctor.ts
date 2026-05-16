import { Command, Flags } from '@oclif/core';
import { bilingual, resolveLang, t } from '../i18n.js';

// spike 版 doctor — 复刻 omk 生产 src/cli/commands/doctor.ts 的最小行为骨架:
// - `--lang zh|en` + OMK_LANG env fallback,默认 zh
// - `--skill-dir <path>` 必带默认值
// - `--no-cache` boolean flag(omk 现实是 --skip-connectivity,这里改名复刻 `--no-*` 形态)
// - preflight 失败 exit 1;unknown flag exit 2(由 oclif.exitCodes 在 package.json 配置)

export default class Doctor extends Command {
  // exp-8:开启 oclif 内置 --json flag。run() 的 return 值会被 oclif 序列化为 JSON
  // 输出到 stdout。错误路径下,oclif 会自动把 this.error() 的 message + exit code
  // 包成 JSON。验证「CI / 外部脚本 parse JSON 替代 regex 抓 stdout」的可行性。
  static enableJsonFlag = true;

  static description = bilingual({
    zh: '体检 omk 工作目录,检查 skill 配置 / 依赖 / executor 连通性。',
    en: 'Preflight health checks for omk workdir: skill config / deps / executor connectivity.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '默认在中文模式下扫描当前目录的 skills/',
        en: 'Default zh mode, scans ./skills/',
      }),
      command: '<%= config.bin %> doctor',
    },
    {
      description: bilingual({
        zh: '指定英文 + 跳过连通性缓存(任何缓存命中的网络检测都重跑)',
        en: 'English output, bypass connectivity cache (re-run all cached network probes)',
      }),
      command: '<%= config.bin %> doctor --lang en --no-cache',
    },
  ];

  static flags = {
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en,优先级 CLI > OMK_LANG env > zh',
        en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh',
      }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    'skill-dir': Flags.string({
      description: bilingual({
        zh: '要体检的 skill 目录,默认 ./skills',
        en: 'Skill directory to inspect (default ./skills)',
      }),
      default: 'skills',
    }),
    'no-cache': Flags.boolean({
      description: bilingual({
        zh: '跳过连通性缓存,所有探测都重跑(spike 用作 preflight 失败模拟开关)',
        en: 'Bypass connectivity cache, re-probe everything (spike: also forces preflight-fail path)',
      }),
      default: false,
    }),
  };

  async run(): Promise<{
    ok: boolean;
    lang: 'zh' | 'en';
    skillDir: string;
    noCache: boolean;
    checks: { name: string; passed: boolean }[];
  }> {
    const { flags } = await this.parse(Doctor);
    const lang = (flags.lang === 'en' ? 'en' : 'zh') as 'zh' | 'en';
    const detected = resolveLang(process.argv);
    this.log(`[spike doctor] flags=${JSON.stringify(flags)} detected_lang=${detected}`);

    this.log(
      t(
        {
          zh: `→ 体检目录:${flags['skill-dir']}`,
          en: `→ Inspecting skill dir: ${flags['skill-dir']}`,
        },
        lang,
      ),
    );

    if (flags['no-cache']) {
      this.error(
        t(
          {
            zh: '体检失败:--no-cache 触发模拟 fail 路径(spike 验收 exit code)',
            en: 'Preflight failed: --no-cache triggers simulated fail path (spike: exit code check)',
          },
          lang,
        ),
        { exit: 1 },
      );
    }

    this.log(
      t(
        {
          zh: '✔ 体检通过(spike 占位实现,未实际跑任何检查)',
          en: '✔ Preflight passed (spike stub — no real checks performed)',
        },
        lang,
      ),
    );

    // exp-8:--json 模式下 oclif 拿这个 return value 序列化输出,suppress 上面的 this.log。
    return {
      ok: true,
      lang,
      skillDir: flags['skill-dir'],
      noCache: flags['no-cache'],
      checks: [
        { name: 'skill-config', passed: true },
        { name: 'deps', passed: true },
        { name: 'connectivity', passed: true },
      ],
    };
  }
}

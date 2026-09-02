import { resolve, join, relative, sep } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual, resolveLang } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';
import { projectLayout } from '../../shared/storage-layout.js';
import {
  DEFAULT_INIT_SAMPLE_COUNT,
  FULL_INIT_SAMPLE_COUNT,
  serializeInitSamples,
} from '../templates/init-samples.js';

// 预置 .omk/.gitignore:测量 bulk + doctor --fix 备份(项目本地、不该入库)默认不入库;
// managed/ 治理档案 + 配置不在此列,默认 track。
const INIT_OMK_GITIGNORE = `# omk 测量 bulk 与 doctor --fix 备份（项目本地）——不入库；前导 / 锚定 .omk/ 顶层，不误伤嵌套同名目录。
/eval/
/doctor/
/observe/
/backups/
/state/
`;

// 模板带 Claude Code SKILL.md 兼容 frontmatter(name + description),让用户
// 可以把 init 出来的 SKILL.md 直接 deploy 到 ~/.claude/skills/ 给 Claude Code 用,
// 一份文件双向 dogfood(omk 评测 + Claude 部署)。omk 当前不 strip frontmatter,
// 它会跟着 leak 进 system prompt — 在 model 行为层面是无害噪声,跨 executor 一致。
const INIT_SKILL_V1 = `---
name: code-review-v1
description: 简单代码审查 skill,识别明显问题
---

# Code review v1

你是一个代码审查助手。请审查用户提供的代码，指出潜在问题。
`;

const INIT_SKILL_V2 = `---
name: code-review-v2
description: 多维度代码审查,覆盖安全 / 健壮 / 可维护 / 性能,带严重程度标注
---

# Code review v2

你是一个高级代码审查专家。请从以下维度审查用户提供的代码：

1. 安全性：是否存在注入、XSS、敏感信息泄露等风险
2. 健壮性：是否有适当的错误处理和边界检查
3. 可维护性：命名是否清晰、结构是否合理
4. 性能：是否存在明显的性能瓶颈

对每个维度给出具体的改进建议，并标注严重程度（高/中/低）。
`;

const INIT_EVAL_COMMAND = 'omk eval --control code-review-v1 --treatment code-review-v2';

function isOutsideCwd(relPath: string): boolean {
  return relPath === '..' || relPath.startsWith(`..${sep}`);
}

function nextEvalCommand(targetDir: string): string {
  const rel = relative(resolve('.'), targetDir);
  if (!rel) return INIT_EVAL_COMMAND;
  const cdTarget = isOutsideCwd(rel) ? targetDir : rel;
  return `cd ${shellQuoteArg(cdTarget)} && ${INIT_EVAL_COMMAND}`;
}

export default class Init extends BaseCommand {
  static description = bilingual({
    zh: '初始化一个 omk 项目：在目标目录铺好待测知识载体（skills/）与评测用例（eval-samples.json），供 omk eval / doctor / evolve / observe / list 操作。默认是两版 code-review skill 的 A/B 起步模板。',
    en: 'Initialize an omk project: scaffold knowledge artifacts (skills/) and eval samples (eval-samples.json) in the target dir for omk eval / doctor / evolve / observe / list to work on. Ships a two-variant code-review A/B starter template by default.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '在当前目录初始化一个 omk 项目',
        en: 'Initialize an omk project in the current directory',
      }),
      command: '<%= config.bin %> init',
    },
    {
      description: bilingual({
        zh: '在指定目录初始化一个 omk 项目',
        en: 'Initialize an omk project in a specified directory',
      }),
      command: '<%= config.bin %> init my-project',
    },
    {
      description: bilingual({
        zh: '使用达到注册样本量下限的 20 条官方用例初始化',
        en: 'Initialize with the 20 first-party samples that meet the registered sample-size floor',
      }),
      command: '<%= config.bin %> init my-project --samples 20',
    },
  ];

  static args = {
    targetDir: Args.string({
      description: bilingual({
        zh: '初始化目标目录，默认当前目录（.）',
        en: 'Target directory, defaults to current directory (.)',
      }),
      required: false,
      parse: async (input: string): Promise<string> => {
        // 拒绝 `omk init -- --weird` 这种把 flag 当 positional 的写法 — legacy 会
        // 创建名为 `--weird` 的目录,新人一头雾水。在 oclif Args 这层拦住更友好。
        if (input.startsWith('--')) {
          const lang = resolveLang();
          const msg = lang === 'zh'
            ? `初始化目录不能以 -- 开头：${input}（看起来是误写的 flag）`
            : `init target dir cannot start with --: ${input} (looks like a malformed flag)`;
          throw new Error(msg);
        }
        return input;
      },
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    samples: Flags.string({
      description: bilingual({
        zh: '官方起步用例数量：3 条用于快速跑通，20 条用于达到注册样本量下限',
        en: 'Number of first-party starter samples: 3 for a quick run, 20 to meet the registered sample-size floor',
      }),
      options: [String(DEFAULT_INIT_SAMPLE_COUNT), String(FULL_INIT_SAMPLE_COUNT)],
      default: String(DEFAULT_INIT_SAMPLE_COUNT),
    }),
    force: Flags.boolean({
      description: bilingual({
        zh: '允许覆盖目标目录中已有的 omk 脚手架文件',
        en: 'Allow overwriting existing project scaffold files in the target directory',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const targetDir: string = resolve(args.targetDir || '.');
      const layout = projectLayout(targetDir);
      const sampleCount = flags.samples === String(FULL_INIT_SAMPLE_COUNT)
        ? FULL_INIT_SAMPLE_COUNT
        : DEFAULT_INIT_SAMPLE_COUNT;
      const { existsSync, writeFileSync, mkdirSync } = await import('node:fs');
      const scaffoldFiles = [
        join(targetDir, 'eval-samples.json'),
        join(targetDir, 'skills', 'code-review-v1', 'SKILL.md'),
        join(targetDir, 'skills', 'code-review-v2', 'SKILL.md'),
        join(layout.root, '.gitignore'),
      ];
      const existingFiles = scaffoldFiles
        .filter((path) => existsSync(path))
        .map((path) => relative(targetDir, path));
      if (existingFiles.length > 0 && !flags.force) {
        throw new Error(tCli('cli.init.existing_files', lang, { paths: existingFiles.join(', ') }));
      }

      // omk skill loader 把 `skills/<name>/SKILL.md` 子目录识别为 directory-skill,
      // cwd 默认锚到 skill 根目录,后续可在同目录下放 assets / 子文档。
      mkdirSync(join(targetDir, 'skills', 'code-review-v1'), { recursive: true });
      mkdirSync(join(targetDir, 'skills', 'code-review-v2'), { recursive: true });
      writeFileSync(join(targetDir, 'eval-samples.json'), serializeInitSamples(sampleCount));
      writeFileSync(join(targetDir, 'skills', 'code-review-v1', 'SKILL.md'), INIT_SKILL_V1);
      writeFileSync(join(targetDir, 'skills', 'code-review-v2', 'SKILL.md'), INIT_SKILL_V2);
      // 像 dvc init 那样预置忽略规则,开发者不会误把测量 bulk 提交进库。
      mkdirSync(layout.root, { recursive: true });
      writeFileSync(join(layout.root, '.gitignore'), INIT_OMK_GITIGNORE);

      console.log(tCli('cli.init.scaffolded', lang, { dir: targetDir }));
      console.log(tCli('cli.init.sample_pack', lang, { count: sampleCount }));
      console.log('');
      console.log(tCli('cli.init.next_steps_title', lang));
      console.log(tCli('cli.init.next_step_run', lang, { command: nextEvalCommand(targetDir) }));
      console.log(tCli('cli.init.next_step_executor', lang));
      console.log(tCli(
        sampleCount === FULL_INIT_SAMPLE_COUNT
          ? 'cli.init.next_step_report_full'
          : 'cli.init.next_step_report_quick',
        lang,
      ));
      console.log(tCli('cli.init.next_step_customize', lang));
      console.log(tCli('cli.init.note_skill_injection', lang));
    });
  }
}

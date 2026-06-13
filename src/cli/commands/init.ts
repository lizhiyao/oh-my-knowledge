import { resolve, join } from 'node:path';
import { Args } from '@oclif/core';
import { LANG_FLAG, bilingual, resolveLang } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';

// 预置 .omk/.gitignore:测量 bulk(项目本地、可重生)默认不入库;managed/ 治理档案 + 配置不在此列,默认 track。
const INIT_OMK_GITIGNORE = `# omk 测量 bulk(项目本地、可重生)——不入库;前导 / 锚定 .omk/ 顶层,不误伤嵌套同名目录。
/observe-health/
/doctors/
/observe-inbox/
/reports/
`;

const INIT_SAMPLES = `[
  {
    "sample_id": "s001",
    "prompt": "审查以下代码",
    "context": "function authenticate(username, password) {\\n  const query = \`SELECT * FROM users WHERE name='\${username}' AND pass='\${password}'\`;\\n  return db.execute(query);\\n}",
    "rubric": "应识别 SQL 注入风险，建议使用参数化查询",
    "assertions": [
      { "type": "contains", "value": "SQL", "weight": 1 },
      { "type": "contains", "value": "injection", "weight": 1 },
      { "type": "regex", "pattern": "parameterized|prepared|placeholder|bind", "flags": "i", "weight": 0.5 },
      { "type": "not_contains", "value": "looks good", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "是否准确识别出 SQL 注入漏洞并说明其危害",
      "actionability": "是否给出可直接使用的参数化查询修复代码"
    }
  },
  {
    "sample_id": "s002",
    "prompt": "审查以下代码",
    "context": "async function fetchData(url) {\\n  const res = await fetch(url);\\n  const data = await res.json();\\n  return data;\\n}",
    "rubric": "应指出缺少错误处理（网络异常、非 JSON 响应、HTTP 错误状态码）",
    "assertions": [
      { "type": "contains", "value": "error handling", "weight": 1 },
      { "type": "regex", "pattern": "try[\\\\s\\\\S]*catch|exception|error", "flags": "i", "weight": 1 },
      { "type": "contains", "value": "status", "weight": 0.5 }
    ],
    "dimensions": {
      "robustness": "是否指出了所有缺失的错误处理场景",
      "actionability": "是否给出了完整的 try-catch 修复代码"
    }
  },
  {
    "sample_id": "s003",
    "prompt": "审查以下代码",
    "context": "function renderComment(comment) {\\n  document.getElementById('output').innerHTML = '<p>' + comment + '</p>';\\n}",
    "rubric": "应识别 XSS 风险，建议使用 textContent 或转义 HTML",
    "assertions": [
      { "type": "contains", "value": "XSS", "weight": 1 },
      { "type": "regex", "pattern": "textContent|escape|sanitize|sanitizer", "flags": "i", "weight": 1 },
      { "type": "contains", "value": "innerHTML", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "是否准确识别出 XSS 漏洞并说明攻击方式",
      "actionability": "是否给出使用 textContent 或转义的修复代码"
    }
  }
]
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
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Init);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const targetDir: string = resolve(args.targetDir || '.');
      const { writeFileSync, mkdirSync } = await import('node:fs');

      // omk skill loader 把 `skills/<name>/SKILL.md` 子目录识别为 directory-skill,
      // cwd 默认锚到 skill 根目录,后续可在同目录下放 assets / 子文档。
      mkdirSync(join(targetDir, 'skills', 'code-review-v1'), { recursive: true });
      mkdirSync(join(targetDir, 'skills', 'code-review-v2'), { recursive: true });
      writeFileSync(join(targetDir, 'eval-samples.json'), INIT_SAMPLES);
      writeFileSync(join(targetDir, 'skills', 'code-review-v1', 'SKILL.md'), INIT_SKILL_V1);
      writeFileSync(join(targetDir, 'skills', 'code-review-v2', 'SKILL.md'), INIT_SKILL_V2);
      // 像 dvc init 那样预置忽略规则,开发者不会误把测量 bulk 提交进库。
      mkdirSync(join(targetDir, '.omk'), { recursive: true });
      writeFileSync(join(targetDir, '.omk', '.gitignore'), INIT_OMK_GITIGNORE);

      console.log(tCli('cli.init.scaffolded', lang, { dir: targetDir }));
      console.log('');
      console.log(tCli('cli.init.next_steps_title', lang));
      console.log(tCli('cli.init.next_step_edit_samples', lang));
      console.log(tCli('cli.init.next_step_edit_skills', lang));
      console.log(tCli('cli.init.next_step_run', lang));
      console.log(tCli('cli.init.note_codex_executor', lang));
    });
  }
}

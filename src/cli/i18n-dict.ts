/**
 * CLI 文案字典。
 *
 * 命名约定: `cli.<command>.<event>` 或 `cli.common.<event>`。
 * 占位符用 `{name}` 形式,在 tCli(params) 处替换。
 *
 * ============================================================================
 * 翻译守则 (受 cc-viewer i18n 方案启发)
 * ============================================================================
 *
 * 1. **彻底本地化, 不接受中英混搭**
 *    "中文用户读到的中文"和"英文用户读到的英文"必须是各自语言里自然的表达,
 *    不能机械翻译, 不能在中文里塞英文短语解释术语。如果某个英文短语没有
 *    自然的中文译法, 重新组织句子结构, 而不是混着写。
 *
 * 2. **保留原文的白名单 (产品术语 / 命令 / 文件名)**
 *    以下 token 在两种语言里都保留原文, 不翻译:
 *    - 产品名: omk, oh-my-knowledge, Claude, npm
 *    - 子命令空间和命令名: bench, analyze, run, report, init, evolve, gold,
 *      diff, ci, gen-samples, debias-validate, saturation, verdict,
 *      diagnose, failures
 *    - omk 核心业务术语: skill, variant, sample, judge, executor (出现在产品
 *      UI 里时首字母可大写如 "Skill 评测", 描述句中保持小写)
 *    - 技术参数: --lang, --control, --treatment, --bootstrap, --judge-repeat,
 *      OMK_LANG, JUDGE_PROMPT_VERSION_*
 *    - 文件名 / 路径: eval-samples.json, skills/v1.md, ~/.oh-my-knowledge/...
 *    - 数学概念缩写: CI, α, RAG (其译法可在配套描述里说明, 但术语本身留原文)
 *
 * 3. **必须翻译的内容**
 *    动作 (run / edit / scaffold / generate), 状态 (success / failed /
 *    invalid), 引导文案 (next steps / try this / see also), 解释性描述。
 *
 * 4. **不要机械直译**
 *    "Next steps:" 译 "下一步:" 而不是 "下一步骤:"。
 *    "Run: ..." 译 "运行: ..." 而不是 "跑: ..."。
 *    选用 omk 项目长期使用的中文措辞 (LLM judge 译"评委" 不译"判官", 见
 *    feedback_ui_translation.md)。
 *
 * 5. **新增 key 流程**
 *    a. 加到 CliMessageKey union 类型里
 *    b. 在 CLI_DICT 里同时给出 zh / en (Record 类型强制 zh/en 双写, 漏写
 *       tsc 直接报错)
 *    c. 自查: 中文里有没有非白名单的英文? 英文里有没有中文?
 *    d. 自查: 措辞自然度 — 把中文版念出来, 像不像中文项目的命令行输出?
 *    e. test/cli-i18n.test.ts 会跑 runtime parity 检查
 *
 * 未来扩 Lang (zh-TW / ja / ko ...): 改 src/types/shared.ts 的 Lang union,
 * Record 类型自动强制每 key 加新语言版本。
 */

export type CliMessageKey =
  // 通用 / 启动期
  | 'cli.common.lang_invalid_silent'
  | 'cli.common.help_hint'
  | 'cli.common.unknown_domain'
  | 'cli.common.unknown_bench_command'
  // bench init
  | 'cli.init.scaffolded'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_edit_samples'
  | 'cli.init.next_step_edit_skills'
  | 'cli.init.next_step_run';

export interface CliMessage {
  zh: string;
  en: string;
}

export const CLI_DICT: Record<CliMessageKey, CliMessage> = {
  'cli.common.lang_invalid_silent': {
    zh: '无效的语言代码: {value} (仅支持 zh / en, 已使用默认 zh)',
    en: 'Invalid language code: {value} (supported: zh / en, using default zh)',
  },
  'cli.common.help_hint': {
    zh: "运行 'omk --help' 查看用法",
    en: "Run 'omk --help' to see usage",
  },
  'cli.common.unknown_domain': {
    zh: "未知顶层命令: {domain} (请用 'omk bench <command>' 或 'omk analyze <dir>')",
    en: "Unknown domain: {domain} (use 'omk bench <command>' or 'omk analyze <dir>')",
  },
  'cli.common.unknown_bench_command': {
    zh: "未知子命令: bench {command} (运行 'omk --help' 查看可用列表)",
    en: "Unknown bench command: {command} (run 'omk --help' to see all commands)",
  },
  'cli.init.scaffolded': {
    zh: '已初始化测评项目: {dir}',
    en: 'Eval project scaffolded at: {dir}',
  },
  'cli.init.next_steps_title': {
    zh: '下一步:',
    en: 'Next steps:',
  },
  'cli.init.next_step_edit_samples': {
    zh: '  1. 编辑 eval-samples.json, 加入你要测的测评用例',
    en: '  1. Edit eval-samples.json to add your test cases',
  },
  'cli.init.next_step_edit_skills': {
    zh: '  2. 编辑 skills/v1.md 和 skills/v2.md, 为两个 skill 版本填入实际内容',
    en: '  2. Edit skills/v1.md and skills/v2.md with your skill versions',
  },
  'cli.init.next_step_run': {
    zh: '  3. 运行: omk bench run --control v1 --treatment v2',
    en: '  3. Run: omk bench run --control v1 --treatment v2',
  },
};

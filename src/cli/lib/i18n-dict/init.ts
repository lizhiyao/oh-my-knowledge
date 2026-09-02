import type { CliMessage } from './types.js';

export type InitMessageKey =
  | 'cli.init.scaffolded'
  | 'cli.init.sample_pack'
  | 'cli.init.existing_files'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_run'
  | 'cli.init.next_step_executor'
  | 'cli.init.next_step_report_quick'
  | 'cli.init.next_step_report_full'
  | 'cli.init.next_step_customize'
  | 'cli.init.note_skill_injection';

export const initDict: Record<InitMessageKey, CliMessage> = {
  'cli.init.scaffolded': {
    zh: '已初始化 omk 项目：{dir}',
    en: 'omk project initialized at: {dir}',
  },
  'cli.init.sample_pack': {
    zh: '已写入 {count} 条官方起步用例。',
    en: 'Wrote {count} first-party starter samples.',
  },
  'cli.init.existing_files': {
    zh: '目标目录已有 omk 脚手架文件，已停止以避免覆盖：{paths}。请改用新的空目录，或确认要重建后显式传 --force。',
    en: 'Existing project scaffold files would be overwritten: {paths}. Use a new empty directory, or pass --force only after confirming a rebuild.',
  },
  'cli.init.next_steps_title': {
    zh: '下一步：',
    en: 'Next steps:',
  },
  // 先让用户「无需改任何文件直接跑通」——脚手架的用例与 skill 本身可跑(已过合规校验),
  // 跑出第一份报告是冷启动最该先发生的事;「换成你自己的」放到跑通之后。这也消除了
  // 主 README「不用改任何文件」与旧 init「先编辑」的矛盾。
  'cli.init.next_step_run': {
    zh: '  1. 直接跑通（无需先改任何文件）：{command}',
    en: '  1. Run it as-is (no edits needed): {command}',
  },
  'cli.init.next_step_report_quick': {
    zh: '  2. 看报告里的 verdict 和“下一步”：3 条用例只用于跑通链路，出现 UNDERPOWERED 是预期结果；需要完整起步集时，在新的空目录使用 --samples 20。',
    en: '  2. Read the report verdict and Next line: 3 samples only prove the workflow, so UNDERPOWERED is expected; use --samples 20 in a new empty directory for the full starter set.',
  },
  'cli.init.next_step_report_full': {
    zh: '  2. 看报告里的 verdict 和“下一步”：20 条用例达到注册样本量下限，但来源是 llm-generated；用于理解统计流程，发布前应人工复核并替换为真实领域用例。',
    en: '  2. Read the report verdict and Next line: 20 samples meet the registered sample-size floor but are llm-generated; use them to learn the statistical workflow, then review and replace them with real domain cases before release.',
  },
  'cli.init.next_step_executor': {
    zh: '     executor / judge 会按运行环境选择；Codex 任务自动使用本机 Codex 配置。也可用 OMK_EXECUTOR / OMK_MODEL 固定环境偏好，详见 https://oh-my-knowledge.pages.dev/zh/reference/executors。',
    en: '     The executor / judge follow the runtime environment; Codex tasks use the local Codex configuration automatically. OMK_EXECUTOR / OMK_MODEL pin environment preferences. See https://oh-my-knowledge.pages.dev/reference/executors.',
  },
  'cli.init.next_step_customize': {
    zh: '  3. 跑通后，替换为你自己的 skill 和 eval-samples.json；还没有用例时先运行 omk sample <skill-path>。',
    en: '  3. Once it runs, replace the starter skills and eval-samples.json with your own; if you have no samples yet, run omk sample <skill-path>.',
  },
  'cli.init.note_skill_injection': {
    zh: '     注：omk eval 会把 SKILL.md 作为 system prompt 注入；模板 frontmatter 只是方便同一目录复用为 agent skill。',
    en: '     Note: omk eval injects SKILL.md as the system prompt; the starter frontmatter only helps reuse the same directory as an agent skill.',
  },
};

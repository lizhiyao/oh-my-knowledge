import type { CliMessage } from './types.js';

export type InitMessageKey =
  | 'cli.init.scaffolded'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_run'
  | 'cli.init.next_step_executor'
  | 'cli.init.next_step_report'
  | 'cli.init.next_step_customize'
  | 'cli.init.note_skill_injection';

export const initDict: Record<InitMessageKey, CliMessage> = {
  'cli.init.scaffolded': {
    zh: '已初始化 omk 项目：{dir}',
    en: 'omk project initialized at: {dir}',
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
  'cli.init.next_step_report': {
    zh: '  2. 看报告里的 verdict 和“下一步”：PROGRESS 才能发布；UNDERPOWERED / NOISE 先扩样到约 20 条以上后重跑。',
    en: '  2. Read the report verdict and Next line: PROGRESS can ship; UNDERPOWERED / NOISE means grow to roughly 20+ samples and re-run.',
  },
  'cli.init.next_step_executor': {
    zh: '     默认 executor / judge 使用 claude CLI；离线或其它模型见 https://oh-my-knowledge.pages.dev/reference/executors。',
    en: '     The default executor / judge use the claude CLI; for offline or other models see https://oh-my-knowledge.pages.dev/reference/executors.',
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
